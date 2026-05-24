# 03 — Cryptographic Protocol

This is the canonical description of arc-vault's key hierarchy and the semantics of every
wrap/encrypt/sign operation. The algorithm set here is **fixed** (not being redesigned);
crypto agility is handled by the envelope (doc 04), not by changing this hierarchy.

## 3.1 Primitives

| Purpose | Primitive | Parameters |
| ------- | --------- | ---------- |
| Password KDF | **Argon2id** | `m = 256 MiB (262144 KiB)`, `t = 3`, `p = 1`, 32 B out. Pinned numeric values for cross-platform reproducibility (matches Rust `argon2::Params::new(262144, 3, 1, Some(32))`); do **not** rely on `OPSLIMIT_MODERATE`. Stored per-account so they can be raised later. |
| Key derivation / split | **HKDF-SHA-256** | distinct `info` labels per derived key (see §3.3). |
| Symmetric AEAD | **XChaCha20-Poly1305** | 24 B random nonce per encryption; 16 B tag; AAD always set (§3.4). |
| Public-key sealing (anonymous) | **`crypto_box_seal`** (X25519 + XSalsa20-Poly1305, ephemeral sender) | recipient pubkey only; sender anonymous. |
| Public-key box (authenticated) | **`crypto_box`** (X25519 + XSalsa20-Poly1305) | sender priv + recipient pub; recipient learns sender identity cryptographically. |
| Signatures | **Ed25519** | over canonical bytes (doc 04). |
| Randomness | CSPRNG | `crypto.getRandomValues` (web), `getrandom`/`rand` (Rust). |

> **Argon2id memory note.** 256 MiB in a browser/WASM context is heavy and can OOM or be
> throttled on mobile and low-RAM devices. We keep 256 MiB as the desktop/server-restretch
> target but allow a **per-platform profile** (e.g. a mobile profile at `m = 64 MiB, t = 4`)
> selected at enrollment and recorded in `argonParams`. The param-versioning machinery
> (doc 05 §5.3) lets us raise weak profiles later via re-wrap. Never silently downgrade an
> existing account's params.

## 3.2 Canonical key hierarchy

This is the single diagram every other doc refers to. **It is preserved exactly as
specified — MK → WK → identity keys → VK → IK — and is not being redesigned.**

```
master password            (never persisted, never transmitted)
   │  + salt_mk (16 B, public, stored server-side)
   ▼  Argon2id(m,t,p)
  MK (32 B, memory only)
   │
   ├─ HKDF-SHA256(MK, info="arc/auth/v1") ─▶ auth seed
   │        │  Argon2id(auth seed, salt_auth)         [client computes]
   │        ▼
   │     authHash ───────────────────────────────────▶ server (rate-limit gate ONLY;
   │                                                     server re-stretches before compare)
   │
   └─ HKDF-SHA256(MK, info="arc/wrap/v1") ─▶ WK (32 B)
            │  XChaCha20-Poly1305
            ▼
      identity_priv (X25519)   +   signing_priv (Ed25519)
        [encIdentityPriv]            [encSigningPriv]
        (recovery key independently wraps identity_priv → encIdentityPrivRecovery)
            │
            │  identity_priv unwraps each vault grant (§3.5)
            ▼
      VK_v   (per vault, random 256-bit, versioned)
            │  XChaCha20-Poly1305
            ▼
      IK     (per item, random 256-bit)
            │  XChaCha20-Poly1305,  AAD = vaultId | itemId | version | keyVersion
            ▼
      item plaintext (canonical JSON, doc 04 §4.4)
```

### Random vs derived

- **Random (CSPRNG):** VEK/VK (32 B), IK (32 B), all salts (16 B), all nonces (24 B),
  recovery key (32 B), identity/signing/device keypairs.
- **Derived:** MK (Argon2id), then `{auth seed, WK}` as two HKDF branches of MK with
  distinct `info` labels. Splitting via HKDF guarantees that leaking authHash cannot reveal
  WK.

### Why the IK layer exists (preserved from the shared-vault design)

1. **Granular sharing** — re-wrap a single item's IK to another vault's VK or a user's
   identity key without exposing the rest of the vault.
2. **Cheap rotation** — rotating a VK re-wraps the small IK blobs; it does **not** re-encrypt
   every item payload.
3. **Future per-item ACLs.**

A **personal vault** uses the identical hierarchy with one `owner` member; there is no
separate "VEK" code path. (The legacy term VEK from earlier drafts == the personal vault's
`VK_v1`.)

## 3.3 HKDF label registry

All HKDF `info` labels are versioned and centrally listed so TS and Rust never disagree:

| Label | Derives | From |
| ----- | ------- | ---- |
| `arc/auth/v1` | auth seed (→ authHash) | MK |
| `arc/wrap/v1` | WK | MK |
| `arc/passkey/v1` | passkey wrapping key | WebAuthn PRF output (doc 13) |

New labels must be added here, never reused with different meaning.

## 3.4 AEAD and AAD discipline

Every XChaCha20-Poly1305 encryption sets **Associated Data** that binds the ciphertext to
its logical position, preventing copy/replace/rollback attacks:

- **Item payload:** `AAD = vaultId | itemId | version | keyVersion` (field separator is the
  canonical concatenation in doc 04 §4.3). A ciphertext moved to another item/version fails
  to open.
- **Wrapped IK (IK under VK):** `AAD = vaultId | itemId | "ik" | keyVersion`.
- **Wrapped private keys (identity/signing under WK):** `AAD = userId | keyName | keyVersion`.
- **Folder name (under VK):** `AAD = vaultId | folderId | "name" | keyVersion`.

Nonces are 24 B random per encryption; with XChaCha20 the random-nonce collision risk is
negligible, so no counter is needed. **Nonce reuse is a critical bug** and is checked in
testing (doc 15 §15.2).

## 3.5 Key-sharing / wrapping semantics (clarified)

This section resolves the ambiguity in earlier drafts that wrote "`crypto_box(pub, VK)`"
without specifying authentication. There are three distinct operations and each has a
correct use:

### (a) Anonymous sealing — `crypto_box_seal`

The sender generates an **ephemeral** keypair, performs `crypto_box` to the recipient, and
prepends the ephemeral public key. The recipient can decrypt but learns **nothing
cryptographic about who sent it**.

- **Use for:** wrapping a VK to a recipient's identity public key when sender authorship is
  *not* needed at the crypto layer, and for wrapping a VK to a new device's public key.
- **Property:** confidentiality + integrity to the recipient; sender-anonymous.

### (b) Sender-authenticated boxing — `crypto_box`

Uses the **sender's long-term private key** and the recipient's public key. The recipient,
who knows the sender's public key, gets cryptographic assurance the box came from that
sender (mutual: either party can both encrypt and decrypt).

- **Use for:** rare cases where the *unwrap-time* recipient must verify the wrapper's
  identity from the box itself and a separate signature is undesirable.
- **Caveat:** `crypto_box` authentication is *repudiable* and symmetric (it proves "one of
  {sender, recipient}"), which is usually **not** the property you want for an auditable
  grant chain.

### (c) Sealed + detached Ed25519 signature  ← **arc-vault's default for grants**

Wrap with `crypto_box_seal` (anonymous, recipient-confidential) **and** attach a detached
Ed25519 signature from the granting user's signing key over the canonical grant tuple
(doc 10 §10.4). This cleanly separates two concerns:

- **Confidentiality** of the VK → handled by the seal (only the grantee can open it).
- **Authenticity / non-repudiation** of "admin X granted VK v to user Y" → handled by the
  Ed25519 signature, which *anyone* can verify against X's published signing key and which
  forms the verifiable grant chain (doc 10).

| Operation | Confidential to recipient | Sender authenticated | Publicly verifiable authorship | arc-vault use |
| --------- | ------------------------- | -------------------- | ------------------------------ | ------------- |
| `crypto_box_seal` | yes | no | no | device VK transfer; grants where authorship is carried by a separate signature |
| `crypto_box` | yes | yes (repudiable, symmetric) | no | niche; generally avoided in favor of (c) |
| seal + Ed25519 sig | yes | yes (via sig) | **yes** | **default for `vault_key_grant` and all admin mutations** |

**Rule of thumb:** *confidentiality is a box; authenticity is a signature.* Do not overload
`crypto_box`'s built-in MAC to mean "this grant is authorized" — use an explicit signature
so the authorization is verifiable by third parties and survives in the audit/grant chain.

## 3.6 Item encryption / decryption (normative steps)

**Encrypt an item:**

1. Serialize the item to canonical JSON (doc 04 §4.4) → UTF-8 bytes; apply length padding
   (doc 02 §2.5) → `plaintext`.
2. Generate `IK` (32 B random) and `nonce_item` (24 B random).
3. `ct_item = XChaCha20Poly1305(IK, nonce_item, plaintext, AAD = vaultId|itemId|version|keyVersion)`.
4. Generate `nonce_ik` (24 B); `wrappedIK = XChaCha20Poly1305(VK_keyVersion, nonce_ik, IK, AAD = vaultId|itemId|"ik"|keyVersion)`.
5. Wrap each into envelopes (doc 04). If signing is enabled, sign the mutation tuple
   (doc 10 §10.4).
6. Upload `{ ciphertext envelope, wrappedIK envelope, vaultKeyVersion, baseVersion, signature? }`.

**Decrypt an item:**

1. Open `wrappedIK` with the matching `VK_keyVersion` (verify AAD) → `IK`.
2. Open `ct_item` with `IK` (verify AAD) → padded plaintext → strip pad → canonical JSON.
3. If a signature is present, verify it against the author's published signing key (doc 10).
4. On any AEAD or signature failure: **reject** and surface an integrity error; never return
   partial plaintext.

## 3.7 Zeroization

- **Rust:** `zeroize::Zeroize` / `Zeroizing<Vec<u8>>` on MK, WK, identity/signing privs, VK,
  IK, and item plaintext buffers, applied immediately after use and on auto-lock.
- **Web:** best-effort only — overwrite typed arrays and drop references on lock. JS cannot
  guarantee erasure (doc 02 §2.4). The web client therefore prefers the Rust core for
  decryption when running under Tauri.

## 3.8 Invariants (testable)

- The server never receives MK, WK, identity/signing privs, VK, IK, recovery key, or
  plaintext.
- authHash leakage reveals nothing about WK (distinct HKDF branches).
- Every AEAD operation sets AAD; no nonce is ever reused under any key.
- A VK grant's *authorization* is verifiable independent of its *confidentiality*
  (signature vs seal).
