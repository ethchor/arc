# arc — Status & Roadmap

Live picture of what's built vs. what's left to make this a fully shipped product.
**This file gets updated every commit** — if you're reviewing recent work, check the bottom
of the "Done" sections for the most recent entries and the "In progress" block for the
current focus.

Conventions:

- `[x] item (commit-sha)` — landed on develop.
- `[~]` — in progress on this branch but not yet finished.
- `[ ]` — pending, scoped.
- `[?]` — possible, not yet decided. Listed so we don't forget; decision goes into an ADR
  when we commit one way or the other.

Phases come straight from `docs/MONOREPO_PLAN.md` + `docs/16-roadmap-and-migration.md`.
Anything that ships *between* the phases gets folded into the closest one.

----

## Done

### Phase 0 — Foundation

- [x] Monorepo: pnpm workspaces + Turborepo + every package renamed to the `@arc/*` scope
  and `arc-*` directories per the platform plan (`42ba291`).
- [x] `@arc/types` — single source of truth for `JsonValue`, the versioned envelope wire
  shape, the vault domain unions, and the item-payload union (`3f62b7a`, `bd4d45b`).
- [x] `@arc/crypto`: Argon2id, HKDF, X25519, Ed25519, XChaCha20-Poly1305, RFC 8785 JCS,
  the versioned envelope, the anonymous sealed box, the AAD-binding rules from doc 04
  (baseline + many commits).
- [x] `@arc/crypto`: PQ-hybrid sealed box (X25519 + ML-KEM-768 + HKDF-SHA256 +
  XChaCha20-Poly1305) — ADR-002 Phase 1 (`f00243b`).
- [x] `vault-crypto-rs` (Rust): byte-for-byte parity with `@arc/crypto`, KAT vectors in
  `vectors/kat.json`, parity tests in `tests/parity.rs` (`76c5c57` brought it to PQ
  parity too — ADR-002 Phase 4).
- [x] `@arc/leasing`, `@arc/secrets-engine`, `@arc/plugin-sdk` contracts (`e1f9f04`).
- [x] `@arc/secrets-engine`: `KvEngine`, `DynamicSecretsEngine`, `TransitEngine`,
  `MountRegistry` (latest in `143fbec`).
- [x] `integrations/arc-openbao-adapter`: `OpenBaoClient`, `OpenBaoKvEngine`,
  `OpenBaoTransitEngine`, plus a live smoke test that skips without `BAO_ADDR`
  (`e1f9f04`, `ded6b27`, `143fbec`).
- [x] Docker compose for local OpenBao dev (`ded6b27`).
- [x] ADR-001 — language boundary (Rust where keys are in process memory, TS for
  the blind ciphertext server) (`e03cfc5`).
- [x] ADR-002 — post-quantum hybrid grants (4 phases, all shipped) (`f00243b`,
  `6f69b42`, `76c5c57`).

### Phase 1 — MVP, single-device, unified model

- [x] Server: `vault_user_keys`, `vaults`, `vault_memberships`, `vault_key_grants`,
  `vault_items`, `vault_devices`, `vault_heads`, `vault_audit_log`, `vault_folders`
  (baseline).
- [x] Server: hybrid identity columns — `identityPublicKeyMlkem`,
  `encIdentityPrivMlkem`, `encIdentityPrivMlkemRecovery` (`6f69b42`).
- [x] Server: `/auth/dev-login`, `/vault/enroll`, `/vault/keyset`, `/vault/unlock`,
  `/vaults` + create + members + items + folders + rotate-key + head + devices +
  `/vault/users/:id/identity-key` (baseline).
- [x] Server: anti-takeover (no overwriting an existing keyset on re-enroll), rate-limited
  unlock attempts, signed vault-head verification (baseline).
- [x] Server: e2e tests against the real Nest app + sql.js (`vault.e2e-spec.ts`,
  `sdk.e2e-spec.ts`, `cli.e2e-spec.ts`) (baseline + various).
- [x] SDK: enroll / unlock / setIdentity (hybrid) / listVaults / createVault / addMember
  / rotateKey / rotateForAllMembers / pull / putItem / deleteItem / device approval flow
  (latest in `6f69b42`, `bd4d45b`).
- [x] SDK: classical X25519 `seal` for device grants (the desktop's Rust side will get
  hybrid device grants when the desktop wallet flow lands — ADR-002 §"Phase 4" final
  paragraph).
- [x] Web: enrollment + master-password unlock + recovery-key card (baseline).
- [x] Web: vault list, item list (login items), share dialog with hybrid keys
  (`6f69b42`), folder management, vault-key rotation UI (baseline).
- [x] Web: device approval UX, auto-lock on idle, never-persist-keys store (baseline).
- [x] CLI: `login`, `enroll`, `create-vault`, `set`, `get`, `ls`, `whoami`, `totp-add`,
  `totp` (baseline + `bd4d45b`).
- [x] TOTP item type end-to-end through crypto + types + SDK + CLI + e2e
  (`bd4d45b`). RFC 4226 + RFC 6238 KATs landed.
- [x] Engine-A: TransitEngine contract + OpenBao adapter ("encryption as a service" for
  data that has to live outside the E2E vault) (`143fbec`).
- [x] Web: TOTP item UI — `TotpCard` (rotating code with per-second countdown + copy
  button + progress bar), `TotpDialog` (add/edit), full item-type discrimination in
  `vault-app.tsx` so login + TOTP both render correctly in the list and the active
  panel.
- [x] Web: secure-note + generic key/value secret item UIs — `NoteDialog`/`SecretDialog`
  + their active-panel renders. Discriminated unions in `vault-app.tsx` now handle all
  four item types (login, TOTP, note, secret); search filter, icons, edit + delete all
  flow through type-aware helpers so the next item type (passkey, payment card…) is a
  small diff.
- [x] TOTP: `otpauth://` URI import (Google Authenticator format). Paste a full URI into
  the secret field in `TotpDialog` and it auto-populates key / issuer / account /
  algorithm / digits / period. `parseOtpauthUri` exported from `@arc/crypto`; 7 unit
  tests cover the canonical Google URI, label-prefix fallback for issuer, minimal URIs,
  base32 normalisation across the input, and three rejection paths.

----

## In progress (this branch)

- (nothing — pick the next item from the Pending block below)

----

## Pending

Order is rough priority. Each [ ] is one focused commit's worth of work unless flagged.

### Phase 1 finish

- [ ] Server: drop the implicit `synchronize` on entity load; ship a real Postgres
  migrations file so production deployments don't depend on TypeORM auto-DDL.
- [ ] Server: real Postgres run profile alongside the sql.js test profile (currently a
  single AppModule branches on `NODE_ENV`; split it cleanly).
- [ ] Server: structured logging (Pino or similar) + request-id correlation.
- [ ] Cloud blob storage adapter for item ciphertext payloads (the entity column today
  stores the envelope inline as JSONB — fine for now, will hit row-size limits on
  attachments).

### Phase 2 — multi-device + shared vaults

- [ ] Desktop (Tauri shell) — wire `crates/desktop-core` into `apps/arc-vault-desktop`'s
  `src-tauri/src/main.rs` so the device actually runs. Crate is already tested in
  isolation.
- [ ] Desktop: switch the device identity to the hybrid keypair so device grants can use
  `pqSeal` too (closes the device-grant HNDL footnote in ADR-002 — possibly ADR-003).
- [ ] Browser extension: real autofill flow against the live origin-bound capability
  model in `docs/12`. Today is a scaffold of the messaging layer only.
- [ ] Passkey unlock — server endpoint to store the `encIdentityPrivPasskey` wrap per
  credential (the crypto helper `wrapIdentityForPasskey` already exists), web UI for
  WebAuthn register + unlock-with-passkey.
- [ ] Multi-device key rotation including auto-revoke for retired devices (the
  manual-rotate path works today; needs UX + audit hooks).

### Phase 3 — Engine A + plugin host

- [ ] `arc-server`: integrate `MountRegistry` so requests under `/v1/<mount>/...` route
  to the right engine adapter. Today the server is Engine-B only.
- [ ] `arc-server`: plugin host (in-process module + gRPC backend) per
  `packages/arc-plugin-sdk`'s contract. The interface is defined; the host runtime isn't.
- [ ] PKI engine adapter (`integrations/arc-openbao-adapter` extends, or a parallel
  module — TBD on file structure).
- [ ] Database dynamic credentials adapter (`/v1/database/creds/<role>` against OpenBao).
- [ ] Cloud plugins: `arc-plugin-aws`, `arc-plugin-gcp`, `arc-plugin-azure`.
- [ ] SCM plugins: `arc-plugin-github`, `arc-plugin-gitlab`, `arc-plugin-bitbucket`.
- [ ] Auth plugins: `arc-plugin-oidc`, `arc-plugin-kubernetes`.
- [ ] Audit-log query API + a `/vault/audit` UI panel (entity already exists; nothing
  reads from it today).

### Phase 4 — deployment + ops

- [ ] `arc-agent`: Rust sidecar for templating + auto-auth (sketched in ADR-001 §Open
  questions; needs a concrete first use case before it lands).
- [ ] `arc-operator`: Kubernetes operator (Go) per `infra/`.
- [ ] `arc-helm-charts`: deploys `arc-server` + colocated OpenBao.
- [ ] `arc-terraform`: IaC modules.
- [ ] GitHub Actions CI: build + typecheck + test + parity test + adapter live test
  (the last one needs a docker-enabled runner; cheap because we already have the
  compose file).
- [ ] Release pipeline + SBOM + signed artifacts.
- [ ] OpenTelemetry traces + Prometheus metrics in `arc-server`.
- [ ] `sdks/arc-js-sdk` publish to npm.
- [ ] `sdks/arc-go-sdk` scaffold + publish.

### Open product questions

- [?] Web: should the master-password recovery flow live in the unlock screen or as a
  separate route? Today it's tucked behind a button in `RecoveryKeyCard`.
- ~~[?] TOTP: support `otpauth://` URI import (most clients export this format)?~~ → yes,
  shipped in this batch (TotpDialog auto-detects on paste).
- [?] Secure notes: do they need rich text or is plaintext-with-newlines fine for v1?
- [?] Per-vault icons / colours — Bitwarden parity feature; currently no UI surface.
- [?] Item-level sharing (one item to one user, not whole vault) — Bitwarden has this;
  not in our model yet. Big design call.
- [?] Hardware-key (FIDO2 resident credential) as a primary unlock path on the
  extension. Different from passkey-prf; would let the extension run unlocked across
  browser restarts.

----

## Scope decisions worth remembering

- **XChaCha20-Poly1305 + Argon2id + RFC 8785 JCS** are the canonical primitives. Don't
  swap to AES/PBKDF2/RFC8259 for "compatibility" — those are the *legacy* choices we're
  building a better version of. ADR-001 codifies this.
- **OpenBao MPL 2.0 only** for Engine-A. Never copy Vault BSL source. The adapter
  package is the licensed boundary; everything Engine-A-shaped that we wrote lives in
  `arc-secrets-engine` (clean-room contract) + `arc-openbao-adapter` (HTTP-only).
- **Server holds no keys.** Memory-safety of `arc-server` isn't what protects user
  data; the zero-knowledge protocol is. TS/Nest stays. Rust is for processes that
  actually hold key material (crypto core, desktop, future agent). ADR-001 codifies.
- **Post-quantum hybrid by default** for vault-key grants (not opt-in). The server
  never stores a classical-only grant for new enrollments. ADR-002.

----

## How to update this doc

1. When you ship something, move the `[ ]` to `[x]` with the commit sha appended.
2. When you start something, flip it to `[~]` and add it to the "In progress" block.
3. When you change scope (drop, defer, or add a task) write a one-line note under
   "Scope decisions" or open an ADR if the call is non-trivial.
4. Keep the "In progress" block to one or two items — anything bigger means we should
   split the work.
