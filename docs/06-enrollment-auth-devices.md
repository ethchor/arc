# 06 — Enrollment, Auth, Devices & Invite Hardening

## 6.1 Account vs vault (two separate gates)

1. **Account login** (e.g. Google OAuth) → a JWT. This authorizes **sync only**: it
   identifies which user owns which encrypted blobs. It does **not** unlock the vault.
2. **Vault unlock** → master password (or passkey, doc 13) derives MK → WK → identity keys.
   The server is never involved in producing keys; it only rate-limits unlock attempts.

A stolen JWT therefore yields ciphertext access, not plaintext. A known master password
without the JWT yields nothing to sync against. Both are required for a working client, and
neither alone breaks confidentiality.

## 6.2 Enrollment / master-password setup

```
1. Client generates: salt_mk (16B), salt_auth (16B), identity keypair, signing keypair.
2. User enters master password → MK = Argon2id(pw, salt_mk, profile params).
3. HKDF-split MK → { auth seed, WK }.
   authHash = Argon2id(auth seed, salt_auth).            // client-side
4. encIdentityPriv = wrap_WK(identity_priv);  encSigningPriv = wrap_WK(signing_priv).
5. Generate recovery key → WK_recovery → encIdentityPrivRecovery = wrap_WKrec(identity_priv).
6. Create the user's personal vault: VK_personal (random); ownerGrant =
   seal(identity_pub, VK_personal) + Ed25519 sig (doc 03 §3.5).
7. This device: X25519 device keypair; device priv → OS keychain (desktop) or memory (web);
   device self-grant encVekDevice = seal(devicePub, VK_personal) if caching; trusted=true.
8. POST /vault/enroll { saltMk, saltAuth, argonParams, authHash, identityPub, signingPub,
   encIdentityPriv, encSigningPriv, encIdentityPrivRecovery,
   vault:{type:"personal", encName, nameNonce}, ownerGrant,
   device:{ pubkey, name, encVekDevice } }.
   Server stores ciphertext + metadata only.
9. Show recovery key once; require confirmation re-entry; state the no-recovery warning.
```

The server, at no point, sees the master password, MK, WK, recovery key, any private key, or
any plaintext.

## 6.3 Login + unlock + adding a device

**Unlock (existing trusted device):**

1. `GET /vault/keyset` (JWT) → `{ saltMk, saltAuth, argonParams, encIdentityPriv,
   encSigningPriv, keyVersion }`.
2. User enters master password → derive MK → WK + authHash.
3. `POST /vault/unlock { authHash }` → server **re-stretches** authHash and **constant-time
   compares** to the stored value; rate-limits / locks out after N failures.
4. Client unwraps identity/signing privs with WK locally. Vault unlocked in memory.

authHash exists **only** for server-side rate-limiting/lockout. Security does not depend on
it — the real gate is WK successfully unwrapping the private keys.

**New-device enrollment requiring approval:**

```
1. New device generates an X25519 keypair; private key stays local.
   User logs in (OAuth → JWT).
2. POST /vault/devices { pubkey, name } → server creates a VaultDeviceEntity
   { trusted:false, approved:false }. No VK wrap exists for it yet.
3. New device displays a Short Authentication String (SAS) — see §6.3.1.
4. A trusted, unlocked device calls GET /vault/devices?pending=true, shows the new device +
   its SAS; the user confirms the two SAS values match (out-of-band, human compare).
5. Trusted device computes, for each vault it can grant, a device grant
   = seal(newDevicePub, VK) [+ optional sig], and POST /vault/devices/:id/approve
   { grants[] }.
6. Server stores the grants against the new device; approved=true. Server saw only ciphertext.
7. New device GET /vault/devices/me/keyset → receives its grants → opens with its device
   priv → VKs. (The master password is still required separately to obtain WK for future
   standalone unlock and to access the identity key.)
```

### 6.3.1 SAS (Short Authentication String) — binds both halves of the hybrid pair

Earlier drafts derived the verification code from `SHA256(pubkey)` of the new device only.
That authenticates the *new* device's key to a viewer but does not bind the *pair* — and
once devices became hybrid (X25519 + ML-KEM-768 per ADR-003), it also missed the second
half entirely. arc-vault now binds **both halves** of the hybrid pair (audit LOW-D):

```
# packages/arc-crypto/src/keys.ts::deviceSas
sas_bytes = SHA-256( "arc/sas/v1\n" || x25519Pub || mlkemPub )
sas       = base32(sas_bytes)[:12] grouped as "AAAA-BBBB-CCCC"
```

Legacy X25519-only devices (pre-ADR-003 rows where `publicKeyMlkem == NULL`) fall through
to the older `fingerprint(x25519Pub, 3)` shape so existing display chrome doesn't need a
version flag. New hybrid devices use the both-halves SAS. The domain-separation prefix
`arc/sas/v1\n` prevents bytes from colliding with any raw `fingerprint()` call.

The SAS is a function of both public keys, so a man-in-the-middle that substitutes
either half — including just the ML-KEM half on the wire — changes the SAS the human
compares. Twelve base32 characters in three groups of four (~60 bits of entropy) keeps
the displayed code legible while staying well above the rate-limit / one-shot ceiling
that constrains human-compared codes.

> The earlier spec sketched `HKDF + 6-decimal-digit` output. Reality landed as the
> SHA-256/base32 shape above; if/when we revisit the SAS encoding (e.g. for a desktop
> dialog that benefits from numeric-only entry), it will land as its own ADR.

## 6.4 Recovery entry point

Recovery is a first-class unlock path (full design in doc 05 §5.7): enter recovery key →
derive `WK_recovery` → unwrap identity key → access all grants. On success the client forces
a master-password reset and recovery-key regeneration. A recovering device still registers
for sync (§6.3) but does not require another device's approval, since it proved possession
of the recovery key.

## 6.5 Invite & enrollment hardening — verified identity binding

Sharing a vault means wrapping a VK to the **invitee's identity public key** fetched from
the server directory (`GET /vault/users/:id/identity-key`). The risk: a **malicious server
substitutes its own public key** for the invitee's, so the admin unknowingly wraps the VK to
a key the server controls. This is a trust-on-first-use (TOFU) problem.

Mitigations, layered:

1. **Key fingerprints + out-of-band verification.** Each identity key has a stable, short
   fingerprint (`base32(SHA-256(identityPub))[:N]`, grouped). For high-value team/org
   vaults, the admin verifies the invitee's fingerprint out-of-band (in person, video, a
   second channel) before granting. The UI surfaces "unverified key" until this happens.
2. **TOFU pinning.** Once an admin has granted to an invitee, the invitee's identity pubkey
   is **pinned** locally. A later change (key rotation) is shown as a security event
   requiring re-verification, not silently accepted — exactly the same UX as a changed SSH
   host key.
3. **Signed identity self-attestation.** A user's `identityPub` is co-published with an
   Ed25519 self-signature over `{ userId, identityPub, signingPub, ts }`. This doesn't stop a
   server that fabricates a *whole* identity, but it binds identity↔signing keys together so
   they can't be mixed and matched, and it anchors the grant-chain verification (doc 10).
4. **Directory transparency `[future]`.** A signed, append-only log of identity-key
   publications would let clients detect a server handing different keys to different
   viewers (equivocation). Out of base scope; the hooks (self-attestation + pinning) are in
   place to add it later.

## 6.6 Invite flow for not-yet-enrolled users

To invite by email before the invitee has any identity key:

1. Admin `POST /vaults/:id/invites { email, role, expiresAt }` → a pending `vault_invites`
   row. **No VK is wrapped yet** (there's no recipient key to wrap to — we never wrap to a
   server-chosen placeholder).
2. Invitee enrolls, publishes their identity key (+ self-attestation).
3. Admin (or an auto-prompt to the admin) converts the invite: fetches the now-published
   identity key, **verifies the fingerprint** (§6.5), wraps the VK, and `POST
   /vaults/:id/members`. Only at this human-in-the-loop step does a real grant exist.

This deliberately keeps a human verification step between "server-provided key" and "VK
wrapped to it," closing the substitution window.

## 6.7 Anti-takeover handling

Account-takeover and re-enrollment abuse are handled with explicit friction:

| Scenario | Handling |
| -------- | -------- |
| Attacker gains OAuth/JWT and tries to **re-enroll** (overwrite the keyset) | Re-enrollment that would replace an existing keyset is **refused** by the server; changing the master password requires unlocking the *existing* keyset (proving WK), not just a valid JWT. A true reset requires the recovery key. |
| Attacker registers a **new device** | Cannot obtain any VK without approval from an already-trusted, unlocked device (or the recovery key). A valid JWT alone grants ciphertext sync, not keys. |
| Attacker triggers a **signing/identity key reset** without the old key | Flagged as a `*_reset` (doc 05 §5.5.1), audit-logged, and surfaced to vault admins/peers as "unverified — re-verify before trusting." Other members' clients downgrade trust in that user's new key until re-verified. |
| **Email change** on the account | Does not move any keys or grants (keys are bound to `userId`, not email). Identity-key fingerprint is unchanged, so existing pins still hold. A vault invite keyed to the *old* email is not auto-redirected. |
| Rapid repeated unlock failures | Server lockout with backoff; audit event; optional user alert. authHash compares are constant-time. |
| New device approval **declined** by the user | Device stays `approved:false` with no grants; can be deleted; audit-logged. |

## 6.8 Revocation

`DELETE /vault/devices/:id` removes a device and its grants. True forward security against
that device requires VK rotation (doc 07 §7.5), offered as an explicit "rotate keys" action
— not automatic, because rotation has a cost and the user should choose when a device
removal warrants it (lost/stolen → rotate; tidying up an old laptop you still control →
maybe not).
