# 05 — Identity Keys, Recovery & Rotation

This doc covers the per-user identity layer, recovery-key handling, and — importantly — a
**rotation matrix** that treats identity/signing-key rotation as **independent** of
vault-key rotation. Conflating the two is a common design mistake: rotating a compromised
signing key should not force re-encrypting every vault, and rotating a vault for a revoked
member should not invalidate everyone's identity keys.

## 5.1 Per-user keys

At enrollment every **user** receives two long-term keypairs, independent of any device:

- **identity keypair (X25519)** — receives wrapped Vault Keys (via seal, doc 03 §3.5). Its
  private half unwraps every VK the user has been granted.
- **signing keypair (Ed25519)** — signs mutations and grants (doc 10); its public half is
  how peers verify the user's writes and authorizations.

The **public** keys are published to a server-side directory (used to share *to* a user and
to *verify* the user). The **private** keys are wrapped:

- `encIdentityPriv`, `encSigningPriv` — under **WK** (so unlocking with the master password
  yields them).
- `encIdentityPrivRecovery` — identity private key wrapped independently under the
  **recovery key**.

Each device additionally has its own X25519 keypair for enrollment/approval and fast-unlock
caching (doc 06).

## 5.2 Why identity keys sit between WK and VK

```
WK ─wraps─▶ identity_priv ─unwraps─▶ VK grants ─wraps─▶ IK ─encrypts─▶ item
```

Because grants are wrapped to the **user's identity key** (not to WK or per-device keys),
the user can be granted vaults from any device and unwrap them after any unlock, and a
master-password change only re-wraps the identity/signing privs — not every grant.

## 5.3 Param-version upgrades (Argon2id)

`argonParams` is `{ profile, m, t, p, version }`. To raise parameters (e.g. mobile profile →
desktop profile, or a future global increase):

1. Client unlocks with the **old** params → derives old MK → old WK → identity/signing privs.
2. Derive **new** MK/WK from the same master password with new params.
3. Re-wrap `encIdentityPriv`/`encSigningPriv` under the new WK; recompute authHash under the
   new auth branch.
4. `PUT /vault/keyset` with new params + re-wrapped blobs + new authHash, atomically.

No vault data is touched. Never downgrade an account's params silently.

## 5.4 Rotation matrix

The single most important table in this doc — **what each event forces, and what it does
not**:

| Event | Rotate master pw / WK | Rotate identity key | Rotate signing key | Rotate VK(s) | Rotate IK / re-encrypt items |
| ----- | --------------------- | ------------------- | ------------------ | ------------ | ---------------------------- |
| User changes master password | yes (re-wrap privs, new authHash) | no | no | no | no |
| Recovery key regenerated | no | no | no | no | no (just re-wrap identity priv under new recovery key) |
| **Signing key suspected compromised** | no | no | **yes** (§5.5) | no | no |
| **Identity key suspected compromised** | no | **yes** (§5.6) | maybe (often rotate both) | no* | no* |
| Device revoked | no | no | no | optional | no |
| **Member revoked from a vault** | no | no | no | **yes** (that vault) | no (re-wrap IKs only) |
| Member's secret content known-leaked | no | no | no | yes | **yes** for affected items + rotate the underlying real credentials |
| Algorithm deprecation (doc 04 §4.7) | only if password-derived envelope affected | re-wrap if affected | n/a | re-wrap if VK envelope affected | re-encrypt if item envelope affected |

\* If the identity key is rotated because it was *compromised*, an attacker who held it could
have unwrapped any VK granted to that user. Treat those VKs as exposed and rotate them too
(and rotate the real secrets). Pure key-hygiene rotation (no known compromise) does not
require VK rotation.

**Takeaway:** identity/signing rotation and VK rotation are orthogonal axes. The matrix is
the contract; flows below implement the non-trivial cells.

## 5.5 Signing-key rotation (independent of VK)

Goal: replace a user's Ed25519 keypair without touching any vault data or any grant.

1. Client generates a new signing keypair; wraps the new private key under WK
   (`encSigningPriv'`).
2. Client **cross-signs**: produce a signed statement `rotate-signing` =
   `{ userId, oldSigningPub, newSigningPub, ts, kid' }` signed by the **old** signing key
   (proves continuity: the new key is endorsed by the old). If the old key is *lost* rather
   than rotated-for-hygiene, this continuity proof is unavailable — see §5.5.1.
3. `POST /vault/identity/rotate-signing` `{ newSigningPub, encSigningPriv', continuitySig }`.
4. Server appends the new key to the user's **signing-key history** with `validFrom` and the
   continuity signature, marking the old key `retiredAt`.
5. Peers verifying old mutations use the key that was `validFrom`-valid at the mutation's
   `seq`/`ts`; new mutations use the new key. The continuity signature lets peers trust the
   handoff without re-verifying every historical signature.

### 5.5.1 Lost-key (no continuity proof) case

If the old signing key is unavailable (device lost), continuity can't be self-signed. Then
the rotation is **authorized by master-password possession** (the user proves control of WK
by re-wrapping under it) and is flagged in the audit log as a `signing_key_reset` (vs a
clean `signing_key_rotated`). Vault admins/peers see the reset flag and can require
out-of-band re-verification before trusting the new key for high-value grants.

## 5.6 Identity-key rotation (independent of VK)

Rotating the X25519 identity key is heavier than signing-key rotation because **every grant
the user holds is wrapped to the old identity key**. But it still does **not** require
rotating the VKs themselves:

1. Client unlocks → has old identity_priv → can unwrap each VK it currently holds.
2. Client generates a new identity keypair; wraps new identity_priv under WK + recovery key.
3. For each vault the user is a member of, the client **re-seals the VK to its own new
   identity public key**, producing a replacement grant (`granteeUserId = self`,
   same `keyVersion`). This is a self-grant re-wrap; no admin needed, no VK change.
4. `POST /vault/identity/rotate-identity` with `{ newIdentityPub, encIdentityPriv',
   encIdentityPrivRecovery', regrants[] }`; server swaps the user's identity pubkey and
   replaces the user's own grants atomically.
5. Publish the new identity pubkey to the directory; record old→new in identity history.

VK contents are unchanged, so no item re-encryption. If the rotation is due to *compromise*
of the old identity key, additionally trigger VK rotation per §5.4 (the old key could have
unwrapped those VKs).

## 5.7 Recovery: key handling and UX

- **Generation:** random 256-bit at enrollment, encoded as grouped Base32
  (`XXXX-XXXX-…-XXXX`) for transcription, like a 1Password Secret Key. HKDF-stretched
  (`info="arc/recovery/v1"`) into `WK_recovery`, which wraps `identity_priv` →
  `encIdentityPrivRecovery`.
- **Shown once,** then confirmed by re-entry before enrollment completes. Never stored by
  the server, never logged.
- **Recovery flow:** user enters recovery key → derive `WK_recovery` → unwrap identity_priv
  → unwrap VK grants → vault accessible. Because recovery yields the **identity key**, it
  transitively recovers every vault the user can access, not just a personal VEK.
- **After recovery, force a master-password reset:** recovery proves possession of the
  recovery key, not the master password. On successful recovery the user must set a new
  master password (new MK/WK), re-wrap identity/signing privs under the new WK, and
  **regenerate the recovery key** (the old one was just used / possibly written somewhere
  insecure). Old recovery wrap is invalidated.

### 5.7.1 Edge-case recovery scenarios (explicitly handled)

| Scenario | Behavior |
| -------- | -------- |
| Recovery key used, but identity key was rotated since enrollment | `encIdentityPrivRecovery` is **always kept current**: every identity rotation (§5.6) re-wraps identity_priv under the recovery key too. So recovery always yields the *current* identity key. (Invariant: identity rotation must update both WK-wrap and recovery-wrap atomically.) |
| Lost master pw **and** lost recovery key | Permanent, unrecoverable loss (doc 01 §1.3). The UI states this at enrollment and at every recovery-key display. |
| Recovery on a brand-new device | Recovery is a full unlock path; the new device still goes through device registration (doc 06) for sync, but obtains keys via the recovery flow, not via another device's approval. |
| Recovery key compromised (not lost) | Treat as identity-key exposure: after recovery, rotate the identity key (§5.6) and rotate VKs of sensitive vaults; regenerate the recovery key. |
| Org-managed user, org escrow enabled (doc 14) | Org recovery key can additionally recover the user's org-vault VKs; personal/non-escrowed vaults remain recover-only via the user's own keys. Surfaced to the user. |
| Multiple recovery keys? | Not in base product — exactly one active recovery wrap. Regenerating replaces it. (Multiple/backup recovery shares are `[future]`.) |

## 5.8 Invariants

- Identity rotation re-wraps `identity_priv` under **both** WK and the recovery key
  atomically — recovery never points at a stale identity key.
- Signing-key rotation never touches identity keys, VKs, or items.
- Member-revocation VK rotation never touches anyone's identity/signing keys.
- After any recovery, the master password and recovery key are both replaced before normal
  use resumes.
