# 15 — Testing, Review & Operations

Turns the spec into something you can verify and run safely. Two halves: **cryptographic
testing/review** (correctness + cross-platform parity) and **operational hardening** (the
deployment-time controls).

## 15.1 Cross-platform parity (TS ↔ Rust)

The single most important correctness property: `packages/arc-crypto` (TS) and the Tauri
`vault::crypto` (Rust) must produce **identical bytes** for identical inputs, or a vault
encrypted on desktop won't open on web (and signatures won't verify across clients).

- A shared `vectors/` fixture set (doc 04 §4.6) is the contract. **Both** test suites load
  the **same** files and must reproduce them exactly.
- CI runs the TS suite and the Rust suite against `vectors/`; a mismatch fails the build.
- The vectors cover: Argon2id (per profile), HKDF splits, AAD construction, JCS canonical
  bytes, AEAD seal/open (+ tamper-fail), sign/verify (+ wrong-key fail), envelope round-trip.

## 15.2 Crypto correctness tests

| Test class | What it asserts |
| ---------- | --------------- |
| Known-Answer Tests | matches `vectors/` byte-for-byte (both languages) |
| **Nonce uniqueness** | a property test generating many encryptions asserts no nonce repeats under a key; a deliberate reuse is caught by a lint/assertion in the seal path |
| **AAD binding** | an item ciphertext moved to another itemId/version/keyVersion fails to open |
| **Tamper rejection** | flipping any byte of ciphertext/tag/envelope → open fails, no partial plaintext returned |
| **Constant-time compare** | the authHash comparison uses a constant-time primitive; a test asserts the comparison function is the constant-time one (not `===`) |
| **Rollback/chain** | a reordered/omitted mutation set fails chain-hash verification vs the signed head (doc 10) |
| **Round-trip across langs** | encrypt in TS → decrypt in Rust and vice-versa for each item type |
| **Param-profile interop** | each Argon2id profile round-trips on each target platform |

## 15.3 Property, fuzz & negative testing

- **Property tests** (fast-check / proptest): encrypt-then-decrypt is identity for arbitrary
  payloads; canonical-serialize is idempotent; envelope decode∘encode is stable.
- **Fuzz targets** (cargo-fuzz / jazzer-style): envelope parser, JCS parser, and the
  device-grant/unwrap path — feed malformed/hostile bytes; the only acceptable outcomes are
  "clean reject" or "correct parse," never panic/UB/partial output.
- **Negative API tests:** a viewer's write is rejected (403); a stale `baseVersion` yields
  409 with current ciphertext; an unknown `alg`/envelope `v` fails closed (410/parse reject);
  a malformed signature is rejected at the boundary.

## 15.4 Security-review checklist (pre-merge for crypto-touching changes)

- Constant-time authHash compare; login rate-limit + lockout present and tested.
- Argon2id params pinned numerically, benchmarked per platform, **versioned** for upgrade;
  never silently downgraded.
- Random nonces verified unique; 24 B XChaCha20 nonces; **never** a counter or reuse.
- AAD binds `vaultId|itemId|version|keyVersion` on items (and the documented tuples
  elsewhere); anti-rollback in place.
- Recovery key shown once + confirmed; the "lose both = permanent loss" copy present.
- **No key material in logs, audit, telemetry, or any persist store** (Zustand/local/IDB).
- All secrets come from env/secrets-manager. **Forbidden patterns (CI-grep-blocked):** any
  server-held vault decryption key; any hardcoded fallback like
  `process.env.X || "0".repeat(64)` or `"dev-secret-change-in-production"`; any
  `synchronize: true` on the data source.
- CORS locked to the expected origins (localhost / `tauri://localhost`); CSP + Trusted Types
  on; no `dangerouslySetInnerHTML` in vault routes.
- Clipboard auto-clear and auto-lock present.
- Dependencies pinned (lockfiles), `pnpm audit` + `cargo audit` clean in CI, SRI on any
  external asset.
- Sign-mutation / verify-head paths covered by tests where signing is enabled.

## 15.5 Operational hardening

- **Secrets management:** `JWT_SECRET`, DB credentials, any OAuth secrets come from env /
  secrets manager. No defaults, no fallbacks, fail-fast on missing required secrets at boot.
- **Rate-limiting & lockout:** `/vault/unlock` and directory lookups (`/vault/users?email=`)
  are rate-limited; unlock has exponential backoff + lockout after N failures (423). All
  recorded as security audit events (doc 11).
- **Transport:** TLS everywhere; HSTS; modern cipher config. The Rust stack uses `rustls`
  (no OpenSSL) to match the desktop build.
- **Backups:** server backups contain only ciphertext + metadata (by design) — but still
  treat them as sensitive metadata (doc 02 §2.5) and apply retention.
- **Key-rotation runbooks:** documented procedures for member-revocation rotation (doc 07),
  signing/identity rotation (doc 05), and post-break-glass rotation (doc 14).
- **Monitoring/alerting:** alert on grant changes, `*_reset` events, lockouts, and audit
  retention reductions (a "hide my tracks" signal).
- **DB safety:** migrations only (no `synchronize`); ciphertext columns are `text` and never
  altered destructively without a migration that preserves data.

## 15.6 Production checklist (gate before any real-data deployment)

- [ ] TS↔Rust KAT parity green in CI.
- [ ] Nonce-uniqueness, AAD-binding, tamper-rejection, constant-time-compare tests green.
- [ ] Rollback/chain + conflict-preserving sync tests green.
- [ ] No forbidden patterns (CI grep) — no server-held keys, no hardcoded secrets, no
      `synchronize`.
- [ ] No key material in any log/audit/telemetry/persist store (automated scan).
- [ ] Argon2id params benchmarked per target platform and versioned.
- [ ] Rate-limit/lockout, auto-lock, clipboard-clear verified end-to-end.
- [ ] CSP + Trusted Types + CORS verified; extension origin-binding (eTLD+1) verified.
- [ ] `pnpm audit` + `cargo audit` clean; lockfiles pinned; SRI in place.
- [ ] Recovery flow tested incl. edge cases (doc 05 §5.7.1); "permanent loss" copy present.
- [ ] Audit retention/minimization defaults applied; telemetry off by default.
- [ ] Independent crypto review of `vault-crypto` + Rust core before GA.

## 15.7 What testing cannot cover

Per doc 02 §2.4, tests cannot prove a running unlocked client is safe from same-context
malicious code. They cover protocol correctness, parity, and the controls that bound the
unlock window — not the impossibility of client compromise.
