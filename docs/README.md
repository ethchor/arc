# arc-vault — design documentation

This directory is the full architecture and protocol specification for arc-vault. It
preserves the locked-in cryptography (master key → wrapping key → identity keys → vault
keys → item keys) and the zero-knowledge guarantees, and formalizes the protocol to the
point where TypeScript and Rust clients can interoperate byte-for-byte.

## Status legend

Each major feature carries one of:

- **`[spec]`** — fully specified here, ready to implement.
- **`[planned]`** — described with intent + constraints; details finalized during its phase.
- **`[future]`** — acknowledged direction, deliberately out of near-term scope.

Nothing in the repo is implemented yet; the legend describes *specification maturity*, not
shipped code.

## Reading order

| # | Doc | What it covers |
| - | --- | -------------- |
| — | [`README.md`](README.md) | This index, glossary, status legend, coverage matrix. |
| 01 | [`01-overview-and-goals.md`](01-overview-and-goals.md) | Vision, the two personas, locked product decisions, design tenets. |
| 02 | [`02-threat-model.md`](02-threat-model.md) | STRIDE, trust boundaries, client-compromise assumptions, metadata-leakage analysis, expanded enterprise/machine-identity adversaries. |
| 03 | [`03-cryptographic-protocol.md`](03-cryptographic-protocol.md) | Canonical key hierarchy, primitives, key-sharing/wrapping semantics. |
| 04 | [`04-crypto-envelope-and-serialization.md`](04-crypto-envelope-and-serialization.md) | Versioned envelope, canonical serialization, cross-platform signing contract, test vectors. |
| 05 | [`05-identity-keys-and-rotation.md`](05-identity-keys-and-rotation.md) | Identity/signing keys, recovery, the full rotation matrix. |
| 06 | [`06-enrollment-auth-devices.md`](06-enrollment-auth-devices.md) | Enrollment, login vs unlock, device approval, invite hardening, anti-takeover. |
| 07 | [`07-vaults-rbac-and-sharing.md`](07-vaults-rbac-and-sharing.md) | Vaults, memberships, RBAC, grants, sharing, revocation. |
| 08 | [`08-data-model.md`](08-data-model.md) | TypeORM entities, indexes, migrations. |
| 09 | [`09-api-contract.md`](09-api-contract.md) | REST endpoints, DTOs, guards, error model. |
| 10 | [`10-sync-consistency-and-integrity.md`](10-sync-consistency-and-integrity.md) | Delta sync, conflicts, signed mutation chains, signed vault-head, rollback detection. |
| 11 | [`11-audit-privacy-and-telemetry.md`](11-audit-privacy-and-telemetry.md) | Audit event catalog, metadata minimization, retention, opt-in telemetry. |
| 12 | [`12-clients-sessions-and-extension.md`](12-clients-sessions-and-extension.md) | Web session security, Tauri/Rust core, browser-extension architecture. |
| 13 | [`13-passkeys-and-webauthn.md`](13-passkeys-and-webauthn.md) | WebAuthn PRF unlock, compatibility limits, fallbacks. |
| 14 | [`14-developer-platform.md`](14-developer-platform.md) | Service accounts, CI/CD, API tokens, delegated access, org governance, escrow. |
| 15 | [`15-testing-review-and-operations.md`](15-testing-review-and-operations.md) | Crypto testing/review, KAT vectors, ops hardening, production checklist. |
| 16 | [`16-roadmap-and-migration.md`](16-roadmap-and-migration.md) | Unified consumer + developer roadmap, v1→v2 migration. |
| 17 | [`17-free-tier-deployment.md`](17-free-tier-deployment.md) | Running the whole stack production-like on free infrastructure. |
| — | [`production-hardening.md`](production-hardening.md) | **Operational** env-var contract + boot-time fail-closed gates for non-dev deploys. Pairs with §15.6 (crypto correctness). |
| — | [`manual-testing/`](manual-testing/README.md) | Step-by-step QA playbook; per-feature checklist for release validation. |

## Coverage matrix

Every explicitly requested refinement and priority maps to a home:

| Requirement | Primary doc(s) |
| ----------- | -------------- |
| Clarify key-sharing/wrapping semantics (`crypto_box` vs sealed-box vs sender-authenticated) | 03 §3.5 |
| Strict canonical serialization/signing (RFC 8785 JCS / canonical CBOR) for TS↔Rust | 04 §4.4–4.5 |
| Universal versioned crypto envelope (`alg`, `kdf`, `keyVersion`, `aad`, …) | 04 §4.2–4.3 |
| Signed mutation chains / signed vault-heads (rollback + tamper detection) | 10 §10.4–10.6 |
| Threat model: service accounts, delegated access, machine identities, enterprise automation | 02 §2.6; 14 |
| Identity/signing-key rotation independent of vault-key rotation | 05 §5.4–5.6 |
| Audit-log privacy + retention controls (minimization, configurable telemetry) | 11 |
| Invite/enrollment hardening (verified identity binding, anti-takeover) | 06 §6.5–6.7 |
| Browser-extension architecture (autofill, phishing/origin binding, isolation) | 12 §12.4 |
| WebAuthn PRF/passkey compatibility limits + fallbacks | 13 |
| Dual platform: consumer **and** developer/team | 01 §1.2; 14; 16 |
| Implementation correctness | 03, 04, 08, 09, 15 |
| Sync reliability + concurrency/conflict handling + state consistency | 10 |
| Protocol documentation | 03, 04 |
| Recovery UX + edge-case recovery scenarios | 05 §5.7; 06 §6.4 |
| Attack-surface reduction + operational hardening | 12, 15 |
| Metadata leakage analysis | 02 §2.5 |
| Cryptographic testing/review | 04 §4.6; 15 §15.1–15.3 |
| Client-compromise assumptions | 02 §2.4; 12 |

## Glossary

| Term | Meaning |
| ---- | ------- |
| **MK** | Master Key. Argon2id(master password, `salt_mk`). 32 B. In memory only. |
| **WK** | Wrapping Key. HKDF branch of MK. Wraps the identity/signing private keys. |
| **authHash** | Value the client sends at unlock for server-side rate-limiting only. Never gates decryption. |
| **identity keypair** | Per-**user** X25519 keypair. Receives wrapped Vault Keys. |
| **signing keypair** | Per-**user** Ed25519 keypair. Signs mutations and grants. |
| **device keypair** | Per-**device** X25519 keypair. Used for enrollment/approval and fast-unlock caching. |
| **VK** | Vault Key. Per-vault, versioned, random 256-bit. Wraps Item Keys. |
| **IK** | Item Key. Per-item, random 256-bit. Encrypts one item payload. |
| **grant** | A VK wrapped to a member's identity public key (`vault_key_grant` row). |
| **recovery key** | Random 256-bit, shown once. Independently wraps the identity private key. |
| **envelope** | The versioned container around every ciphertext/signature (doc 04). |
| **seq** | Per-vault monotonic mutation sequence number; the sync + rollback-detection cursor. |
| **personal vault** | A `type=personal` vault with exactly one `owner` member — same code path as team vaults. |

## Conventions

- Sizes are in bytes. XChaCha20-Poly1305 nonces are 24 B, random per encryption.
- "The server never sees X" is an invariant, not a goal. Any doc that appears to violate it
  is a bug in the doc.
- Code identifiers (`camelCase` fields, `/vault/...` routes) are normative; prose around
  them is explanatory.
