# ADR-003 — Hybrid (X25519 + ML-KEM-768) device keypairs

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** ethchor
- **Depends on:** ADR-002 (post-quantum hybrid for VK grants)

## Context

ADR-002 made every **user identity** grant hybrid (X25519 + ML-KEM-768 via
`pqSeal`) so the wrapped VKs stored on the server stop being a harvest-now-
decrypt-later (HNDL) liability. ADR-002 §Phase-4-followups explicitly left
**device** grants outside that hybridisation: when a trusted device approved
a new device, it still wrapped the VK with the classical `seal` envelope
(X25519 only) because the only consumer of those device-grant blobs was the
Rust desktop core, which did not yet ship ML-KEM.

That leaves an asymmetric surface. Server-stored VK grants are PQ-protected,
but the parallel `vault_key_grants` rows that target a `device.publicKey`
keep an X25519-only envelope. An adversary who exfiltrates *those* rows and
breaks X25519 in 203X can still recover the wrapped VK for any device that
was approved between ADR-002 and now — which is most devices.

Closing this gap is what ADR-003 is. The shape mirrors ADR-002 exactly: each
device gets a hybrid public key (X25519 + ML-KEM-768), the trusted approver
wraps VKs to that pair with `pqSeal`, and the new device opens them with
`pqSealOpen` using both private keys held in the device's secure storage.

## Decision

1. **Device keypair shape.** A device's identity is now a `HybridKeyPair`:
   the existing X25519 keypair *plus* an ML-KEM-768 keypair. The two pubs
   are registered atomically in a single `POST /vault/devices` call so they
   share a single verification-code anchor and a single trust decision.

2. **Server schema.** `vault_devices` gains a nullable `publicKeyMlkem`
   column (b64url of the ML-KEM-768 public key, 1184 bytes raw → ~1.6KB
   b64url). Nullable so existing X25519-only devices stay valid; new (ADR-
   003) devices populate it. Legacy devices can be left as-is or revoked +
   re-enrolled at the user's convenience.

3. **DTO + listing surface.** `RegisterDeviceDto.publicKeyMlkem` is
   optional. `listPendingDevices` and `listApprovedDevices` both surface
   the new pub (`null` for legacy devices) so the trusted approver can
   pick `pqSeal` vs `seal` per device with no out-of-band guess.

4. **SDK wrap path.** `VaultClient.registerDevice` now generates a
   `HybridKeyPair` (X25519 + ML-KEM-768), keeps **both** privates in
   process memory, and registers both pubs. `VaultClient.approveDevice`
   takes the new device's optional ML-KEM pub as a third argument — when
   present, it wraps VKs with `pqSeal`; when absent, it falls back to
   classical `seal` so a legacy X25519-only device approved by a new SDK
   keeps working.

5. **SDK open path.** `VaultClient.loadDeviceGrants` inspects each
   envelope's `alg` field. Anything `pq-…` flows through `pqSealOpen` with
   both device privates; classical `seal-…` flows through the existing
   `sealOpen` with just the X25519 private. **Mixed-envelope keysets work
   transparently** — a user can have some pre-ADR-003 grants and some new
   ones on the same device and both decrypt.

6. **Verification code.** The out-of-band SAS code is still computed over
   the X25519 pub (the existing `fingerprint(publicKey, 3)` shape) for
   back-compat with everywhere the code is displayed. The ML-KEM pub joins
   the same trust anchor by construction: both pubs are registered in the
   same atomic call and the user only confirms the device once.

## Construction

Identical to ADR-002 §Construction. The same `pqSeal` / `pqSealOpen`
primitives the user-identity grants already use are reused verbatim — there
is no new envelope, no new HKDF info string, no new salt schema. Only the
recipient key material changes from "user identity X25519 + ML-KEM" to
"device X25519 + ML-KEM".

## Migration

- **Schema:** migration `1717700000000-device-hybrid-key` adds the nullable
  column.
- **Data:** none. Existing rows have `publicKeyMlkem = NULL`; the SDK's
  per-device branch chooses the right unseal path from the envelope, not
  from the column.
- **Operator action:** none required. Users who want PQ protection on a
  legacy device revoke + re-enroll it through the same approval UI.

## Rust desktop core

The Rust core does not yet ship an ML-KEM-768 implementation behind a
`pqSeal` API. Until it does:

- The TypeScript SDK (`@arc/sdk`) is the path of truth for hybrid device
  enrollment — this is the path the web + Tauri front-end already takes.
- Future work (tracked under "ops/desktop-rust-pq" or similar): port the
  same X-Wing construction to `vault-crypto-rs` and expose
  `vault_device_hybrid_keypair` / `vault_wrap_vek_for_hybrid_device`
  Tauri commands. KAT vectors in `vectors/kat.json` will gain the
  hybrid-device cases the way ADR-002 added them for user identity.

## Consequences

**Better.** Every new device approved through the ADR-003 flow is HNDL-
resistant for its device-grant material — closing the last column on the
server that was still X25519-only. The change is **additive**: the column
is nullable, the SDK fields are optional, the trust ceremony is unchanged.

**No worse.** Mixed-envelope keysets are explicit in the SDK and tested.
Legacy devices keep working until revoked. The verification-code UX is
unchanged. The wire is larger per device — ~1.6KB more on registration and
each `pqSeal` envelope is ~1.4KB larger than a `seal` envelope — but device
grants are O(devices × vaults) not O(items) and the absolute size is small.

## Test

End-to-end: `apps/arc-server/test/sdk-device-hybrid.e2e-spec.ts` boots the
real server, has a trusted device create a vault, registers a new hybrid
device, approves it with `pqSeal`, opens the grant with `pqSealOpen`, and
decrypts a probe item end-to-end.
