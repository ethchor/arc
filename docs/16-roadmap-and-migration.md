# 16 — Roadmap & Migration

Sequences the build so each phase ships something usable, with the **consumer** and
**developer** tracks interleaved on the shared protocol (doc 01 §1.2). Because the canonical
model is "everything is a vault with members," there is no painful personal→shared rewrite —
the unified model (doc 03 §3.2, doc 07) is built from Phase 1.

## 16.1 Phasing

### Phase 1 — MVP, single-device, unified model `[spec]`

- `packages/arc-crypto`: Argon2id, HKDF split, XChaCha20-Poly1305, the **versioned
  envelope + JCS** (doc 04). Reuse `@noble/hashes`; add `libsodium-wrappers-sumo` (the sumo
  build is required for `crypto_pwhash`) or `@noble/ciphers` (see §16.3).
- Identity + signing keypairs from enrollment (doc 05) — even single-device, so the identity
  layer is never retrofitted.
- Personal vault as a one-member vault (doc 07): `vaults`, `vault_user_keys`,
  `vault_memberships`, `vault_key_grants`, `vault_items` entities; `/vault/enroll`,
  `/keyset`, `/unlock`, `/vaults`, `/items`.
- Recovery-key generation + the recovery flow (doc 05 §5.7).
- Web client routes + a vault store that **excludes all keys from persist** (doc 12).
- Cloud blob storage from day one.

### Phase 2 — Multi-device + shared vaults `[spec]`

- `vault_devices` + device approval with SAS (doc 06 §6.3).
- VK→IK item model fully exercised; sharing + member management (doc 07).
- Delta sync via per-vault `seq`, optimistic concurrency, **conflict-preserving** resolution,
  idempotency keys (doc 10).
- RBAC guards (owner/admin/editor/viewer) on the API (doc 09).
- Invite flow + identity-binding/anti-takeover (doc 06 §6.5–6.7).

### Phase 2.5 — Signed mutations & rollback detection `[spec]`

- Ed25519 authorship signatures on mutations + grant signatures (doc 10 §10.4).
- Signed vault-head + hash chain + gap-checking for rollback/omission detection (doc 10
  §10.5).

### Phase 3 — Consumer UX depth `[planned]`

- **Browser extension** (doc 12 §12.4): origin-bound autofill, isolated content scripts.
- **Passkey/WebAuthn-PRF unlock** wrapping the identity key (doc 13), with fallbacks.
- Mobile clients (doc 12 §12.5).
- Recovery UX polish + edge-case handling (doc 05 §5.7.1).

### Phase 4 — Tauri SQLCipher + keychain `[planned]`

- The Rust `vault/` core (doc 12 §12.2): move crypto into Rust commands, OS keychain device
  key, offline SQLCipher cache, auto-lock in Rust, decrypt-narrowly.
- TS↔Rust KAT parity gate in CI (doc 15 §15.1).

### Phase 5 — Developer/team platform `[planned]`

- Service accounts / machine identities, scoped API tokens, CLI/SDK (doc 14 §14.2–14.3).
- Delegated/break-glass access (doc 14 §14.4).
- Org vaults + governance + audit feed + retention controls (doc 11, doc 14 §14.5).
- CI/CD integration patterns; OIDC-federated short-lived tokens `[future]`.

### Phase 6 — Hardening, governance, extensibility `[future]`

- Key-rotation tooling + runbooks surfaced in-product (doc 15 §15.5).
- Opt-in org escrow with threshold sharing (doc 14 §14.6).
- Directory transparency log for identity keys (doc 06 §6.5).
- Metadata-padding defaults tuned (doc 02 §2.5); breach monitoring (HIBP k-anonymity,
  client-side); collection/folder keys for partial sharing (doc 07 §7.7); device attestation.

## 16.2 Consumer vs developer track view

| Capability | Track | Phase |
| ---------- | ----- | ----- |
| Master-password + recovery unlock | both | 1 |
| Multi-device sync, sharing, RBAC | both | 2 |
| Tamper/rollback detection | both (critical for teams) | 2.5 |
| Browser extension autofill | consumer | 3 |
| Passkey unlock | consumer (also team 2FA) | 3 |
| Mobile | consumer | 3 |
| Native Rust core / offline | both | 4 |
| Service accounts, API tokens, CLI/SDK | developer | 5 |
| Delegated/break-glass | developer | 5 |
| Org governance, audit feed | developer | 5 |
| Escrow, transparency log, attestation | developer/enterprise | 6 |

Neither track blocks the other after Phase 2; they share entities, endpoints, crypto, and
KATs, so a fix in the shared core benefits both.

## 16.3 Library choices

- **Web (`packages/arc-crypto`):** `libsodium-wrappers-sumo` (audited Argon2id +
  XChaCha20-Poly1305 + `crypto_box`/seal; sumo build for `crypto_pwhash`). Alternative:
  `@noble/ciphers` + `@noble/hashes` (pure-JS, no WASM, smaller, slightly slower Argon2). Pick
  one and pin it; the envelope/KATs make the choice swappable later.
- **Rust:** `argon2 ^0.5`, `chacha20poly1305 ^0.10`, `crypto_box ^0.9`, `ed25519-dalek`,
  `hkdf ^0.12`, `sha2 ^0.10`, `zeroize ^1`, `keyring ^3`,
  `rusqlite ^0.32 (bundled-sqlcipher)`, `rand ^0.8`. Pure-RustCrypto stack pairs with
  `rustls` (no OpenSSL); bundled SQLCipher avoids a system dependency.
- **Reuse:** NestJS `JwtAuthGuard`/Passport, TypeORM, TanStack Query for sync, Zustand for
  unlocked state (keys excluded from persist).

## 16.4 v1 → v2 migration (kept for reference)

If a v1 "personal VEK, user-owned items" deployment ever predates the unified model, migrate
lazily and idempotently:

1. On first unified unlock, derive + publish the user's identity/signing keypairs (wrap under
   the existing WK + recovery key).
2. Treat the v1 personal VEK as the personal vault's `VK_v1`.
3. Per item: generate an IK, re-encrypt under IK, store `wrappedItemKey = enc(VK, IK)`. Run
   client-side, **idempotent and resumable** (doc 10 §10.7). Keep a compatibility read path
   that decrypts old `VEK→item` blobs until each item is migrated.

Building the unified model from Phase 1 (as specified) means this migration is **not needed**
for a fresh arc-vault deployment; it exists only for hypothetical legacy data.

## 16.5 Definition of done per phase

Each phase is "done" when: its features are spec-conformant, the relevant doc-15 tests are
green (including TS↔Rust KAT parity once Rust lands), the production-checklist items in scope
pass, and the threat-model rows it touches (doc 02) are re-reviewed.
