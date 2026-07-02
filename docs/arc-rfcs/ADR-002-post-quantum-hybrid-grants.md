# ADR-002 — Post-quantum hybrid for vault-key grants

- **Status:** Accepted · all four phases shipped
- **Date:** 2026-05-31
- **Deciders:** ethchor
- **Depends on:** ADR-001 §"Open questions" #1

## Context

The server stores wrapped vault-key (VK) grants in `vault_key_grants` — one
row per `(vault, key_version, recipient_identity_pub)`. Each row holds an
anonymous sealed-box envelope produced by `wrapVaultKeyFor`: ephemeral X25519
ECDH → HKDF-SHA256 → XChaCha20-Poly1305. Confidentiality of the VK against
anyone other than the recipient depends on the X25519 ECDH being hard.

The harvest-now-decrypt-later (HNDL) threat is concrete here. A state-level
adversary who exfiltrates a backup, an S3 dump, or a snapshot of the grants
table today can hold those bytes until a cryptographically-relevant quantum
computer breaks X25519, then decrypt every VK and every item in those vaults.
The recovery-key wrap is already symmetric (Grover-reduced to ~128-bit
security, fine), and Ed25519 signatures don't have HNDL (you'd be forging
future signatures, not opening past ones), so the grants are the surface that
matters.

We picked **ML-KEM-768** (FIPS 203) hybridised with X25519 as the upgrade,
matching the construction that Signal (PQXDH), Apple iMessage (PQ3), and AWS
KMS already ship. ML-KEM-768 is the NIST L3-security parameter set; the
`@noble/post-quantum` library (same audit lineage as our existing
`@noble/{hashes,ciphers,curves}` deps) implements it.

## Decision

### Phase 1 — primitive (DONE)

Land `pqSeal` / `pqSealOpen` and `generateHybridIdentityKeyPair` in
`packages/arc-crypto/src/pq-hybrid.ts`. Construction
(`pq-seal-x25519-mlkem768-hkdf-xc20p`):

```
eph_x25519          = X25519 keygen()
ss_ec               = X25519(eph_x25519.priv, recipient.x25519Pub)
(kem_ct, ss_pq)     = ML-KEM-768.encapsulate(recipient.mlkemPub)
K                   = HKDF-SHA256(
                        ikm  = ss_ec || ss_pq,
                        salt = eph_x25519.pub || kem_ct
                               || recipient.x25519Pub || recipient.mlkemPub,
                        info = "arc/pq-seal/v1",
                        L    = 32)
ct                  = XChaCha20-Poly1305(K, random_nonce, plaintext, aad)
```

Envelope adds a `kc` field (base64url ML-KEM-768 ciphertext, 1088 bytes) next
to the existing `ep` (ephemeral X25519 pub). All other envelope fields stay
the same. Eleven unit tests cover round-trip, tamper of each component
(`ep`/`kc`/`ct`), KEM ciphertext substitution, X25519 ephemeral substitution,
wrong recipient (each of the two private keys swapped independently), AAD
mismatch, downgrade attempts (stripped `kc`), wrong algorithm marker, and
length conformance to FIPS 203 / RFC 7748.

### Phase 2 — keyset format bump (PLANNED)

Recipients need to publish *both* an X25519 identity public key and an
ML-KEM-768 public key. The keyset (docs/05) gets a v2 schema:

```jsonc
{
  "version": 2,
  "identityPub": "...",           // X25519 — kept for back-compat & ECDH-only paths
  "identityPubMlkem": "...",      // NEW: ML-KEM-768 public key, base64url
  "signingPub": "...",            // Ed25519 (unchanged)
  // wrapped private materials, with the ML-KEM private key wrapped under the
  // same master-password and recovery wraps as the X25519 identity private:
  "encIdentityPriv": { /* X25519 priv (existing) */ },
  "encIdentityPrivMlkem": { /* ML-KEM priv (new), same wrapping scheme */ },
  // ...
}
```

The wrap of the new ML-KEM private key reuses the existing
master-password-derived KEK and the recovery wrap — no new password-derived
key, no migration of master-password handling. AAD strings get an
`"identity-priv-mlkem"` variant so each wrap is bound to its purpose.

Server side, the `users` (or per-version `user_keys`) row gains an
`enc_identity_priv_mlkem text` column and the public-keyset response
serialises the new field. Recovery flow re-wraps both private keys.

### Phase 3 — switch grant wrapping (PLANNED)

Change `wrapVaultKeyFor` to call `pqSeal` against the recipient's hybrid
public key pair, and `openVaultKeyGrant` to call `pqSealOpen`. The wire
format change is detectable by the `alg` field, so during the transition the
server stores grants of either algorithm and clients open whichever they
receive. Once all v2-keyset users exist, a one-shot key-version bump
re-wraps every grant under the hybrid envelope and the legacy path can be
retired.

The signed `grant_chain` (docs/03 §3.5 (c)) signs the grant tuple, not the
envelope bytes, so the signature scheme is unaffected. Ed25519 stays.

### Phase 4 — Rust parity (DONE)

The Rust core in `crates/vault-crypto-rs` now depends on `ml-kem = "0.3"`
(RustCrypto, same audit lineage as the existing `chacha20poly1305`,
`x25519-dalek`, and `ed25519-dalek` crates) and ships
`pq_seal_to_envelope` / `pq_seal_open_envelope` mirroring the TS path
byte-for-byte:

- Same KEM (`ML-KEM-768`).
- Same combiner: `HKDF-SHA256(ss_ec || ss_pq, eph_pub || kem_ct ||
  recip_x25519_pub || recip_mlkem_pub, "arc/pq-seal/v1")`.
- Same envelope shape (`alg = "pq-seal-x25519-mlkem768-hkdf-xc20p"`,
  carrying `ep`, `kc`, `n`, `ct`, `aad`).
- Same ML-KEM private-key wire format (2400-byte expanded form, matching
  what `@noble/post-quantum`'s `keygen` returns and what the keyset stores
  on the server). The Rust side loads it via `DecapsulationKey::from_expanded`;
  switching to the 64-byte seed format is a future cleanup that requires
  both libraries to expose seed-based APIs at the same audit bar.

The TS↔Rust parity vectors (`packages/arc-crypto/scripts/gen-vectors.mjs`
→ `crates/vault-crypto-rs/tests/parity.rs`) gain a `pqSeal` entry. The
parity test (`pq_seal_opens_a_ts_produced_envelope`) loads a TS-produced
envelope plus the hybrid recipient private key and asserts the Rust open
path recovers the same plaintext. Once decap + HKDF agree, the whole
X-Wing combiner is verified across both stacks. A second Rust-only
round-trip test (`pq_seal_round_trips_within_rust`) exercises the seal
path so it doesn't go un-tested by the open-only vector.

Desktop grant wrapping is now hybrid-capable. Whether the desktop client
*uses* hybrid for the device grants stored under
`/vault/devices/.../approve` is a separate decision; today they still use
the classical X25519 `seal` envelope because device keypairs are X25519
only (no ML-KEM half). The next step is a small extension: have the
desktop client also publish an ML-KEM device pub at registration so
`approveDevice` can switch to `pqSeal` too. **Shipped in ADR-003** (hybrid
device keys): devices register an ML-KEM pub and the approver uses `pqSeal`
when it's present, falling back to classical `seal` for legacy X25519-only
devices.

## Explicitly rejected alternatives

1. **Switch to ML-KEM-only (no hybrid).** Rejected. ML-KEM is young (FIPS 203
   was finalised in 2024); hybrid construction means even a fatal break of
   ML-KEM doesn't compromise grants — the X25519 layer still has to be
   broken independently. Cost is a single HKDF call and a 1184-byte public
   key in the keyset.

2. **ML-KEM-512 instead of 768.** Rejected. ML-KEM-768 (NIST L3) matches what
   the production deployments (Signal PQXDH, Apple PQ3) use; the extra ~400
   bytes of public-key material is negligible at our grant volumes.

3. **ML-KEM-1024 instead of 768.** Rejected for now. L5 is overkill for our
   threat model and roughly doubles the ciphertext (1568 vs 1088 bytes per
   grant). Reconsider if NIST guidance shifts.

4. **Use `@noble/post-quantum/hybrid.js` directly.** Rejected — see the
   module's own self-description: *"The current implementation is flawed and
   likely redundant. We should offer a small, generic API to compose hybrid
   schemes instead of reimplementing protocol-specific logic."* We compose
   the hybrid ourselves so the binding (HKDF salt = KEM transcript + both
   recipient pubs) is transparent and easy to mirror in Rust.

## Consequences

- **Storage.** Each hybrid-wrapped grant is `~1088 (kem_ct) + 32 (ep) +
  ct (≈vk_len + 16 tag) ≈ 1150 B` vs the classical `~32 + 48 ≈ 80 B`.
  Volume estimate: at 10⁶ grants per tenant, total grant storage goes from
  ~80 MB to ~1.1 GB. Still well inside Postgres/blob-store comfort zone;
  document in the capacity-planning section of `docs/16`.
- **Keyset size.** The published keyset gains 1184 B per user (ML-KEM-768
  public key). Wrapped private grows by 2400 B per user. Acceptable; these
  are per-user, not per-item.
- **CPU.** ML-KEM-768 encaps/decaps is ~1 ms in WASM-free JS on a modern
  laptop. Grant creation already requires Argon2id-class work for the
  recipient at enrolment; this is in the noise.
- **Auditability.** The `alg` field on every envelope tells the auditor (and
  the migration tooling) exactly which construction protects each grant; we
  keep an inventory of legacy grants by counting `alg = "seal-..."` rows.

## References

- `packages/arc-crypto/src/pq-hybrid.ts` — the primitive.
- `packages/arc-crypto/test/pq-hybrid.test.ts` — round-trip + tamper +
  binding tests.
- ADR-001 §"Open questions" #1 — why this matters and why we pick the
  hybrid family over PQ-only or classical-only.
- FIPS 203 (ML-KEM); RFC 7748 (X25519); RFC 5869 (HKDF); RFC 8439
  (ChaCha20-Poly1305, extended to XChaCha20-Poly1305 by IRTF cfrg-draft).
- *X-Wing: general-purpose hybrid post-quantum KEM* (Connolly, Schwabe,
  Westerbaan) — the binding pattern this construction follows.
- Signal PQXDH (2023); Apple PQ3 (2024) — production hybrid deployments
  we're aligning with.
