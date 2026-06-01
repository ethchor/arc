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
- [x] Server: real Postgres migrations. `src/migrations/1717200000000-init-schema.ts`
  captures the full data model (users, vault keysets including the hybrid identity
  columns, vaults, memberships, grants, items, devices, signed heads, audit log,
  folders) with all indexes + unique constraints. `app.module.ts` wires `migrationsRun:
  true` + `synchronize: false` when `NODE_ENV=production`. New `migration:generate /
  run / revert / show` scripts in `apps/arc-server/package.json` + a CLI-side
  `src/database/typeorm.config.ts` data source for them.
- [x] Audit log query API + UI. New `GET /vaults/:id/audit` endpoint (paginated by
  `before` ISO timestamp, default limit 50, max 200, viewer-or-higher required) +
  `VaultClient.listAudit()` SDK method + `AuditView` component replacing the static
  marketing copy in the Audit section. Shows newest-first table with friendly action
  labels, warn-tone badges for destructive events (unlock_failed, item_deleted,
  device_revoked, vault_key_rotated). E2E test asserts events show up after a real
  enroll → create → put cycle AND that no ciphertext or plaintext leaks into the
  metadata log.
- [x] Server: production env validation. `NODE_ENV=production` without `DATABASE_URL`
  now refuses to start (would have silently fallen back to sql.js + lost every write).
  Three explicit data-source profiles (prod = postgres + migrations only, dev with
  `DATABASE_URL` = postgres + synchronize, dev/test fallback = sql.js + synchronize).
  Same posture as the existing `JWT_SECRET` prod-required check.
- [x] Server: structured logging via `nestjs-pino`. JSON output + `x-request-id`
  correlation in production (honours an upstream header, generates a UUID otherwise);
  `pino-pretty` single-line colored output in dev. `bufferLogs` so even Nest's own
  bootstrap lines come out in the same shape. Configurable via `LOG_LEVEL` (default
  `info` in prod, `debug` in dev).
- [x] Engine-A wired into `arc-server`. New `EnginesModule` builds a `MountRegistry`
  from env at boot (`BAO_ADDR` + optional `BAO_TOKEN`/`BAO_NAMESPACE`), mounts
  `OpenBaoKvEngine` at `secret/` + `OpenBaoTransitEngine` at `transit/`, and exposes a
  single `/v1/*` controller that resolves the mount and dispatches by engine type.
  Vault-compatible wire shape (`/v1/secret/data/<key>`, `/v1/transit/encrypt/<key>`,
  etc.) so existing Vault SDKs reach arc-server unchanged. Without `BAO_ADDR` the
  server still boots; `/v1/*` returns 503 with `{ engine: "A", configured: false }` and
  Engine-B (the zero-knowledge vault) keeps working. New `engines.e2e-spec.ts` covers
  both modes — 4 always-on tests for the disabled path (503 shape, auth still gates,
  empty registry); 5 conditional tests (`describe.skip` unless `BAO_ADDR` is set) that
  round-trip KV v2 put/get/delete + transit create/encrypt/decrypt + 404 for unknown
  mount. `@arc/secrets-engine` + `@arc/openbao-adapter` now dual-publish ESM + CJS via
  matching `tsup.config.ts` files (inlining `@arc/leasing` in the CJS build) so the
  CommonJS Jest runner can `require()` them without dual-publishing leasing itself.

----

## In progress (this branch)

- (nothing — Phase 3 priority queue (PKI adapter, DB dynamic creds, plugin host, per-mount
  ACL) all shipped, plus the persistent grants store + admin API follow-ups. Next pick from
  the Pending block — policy cache, group attachments, or the first real plugin.)

----

## Pending

Order is rough priority. Each [ ] is one focused commit's worth of work unless flagged.

### Phase 1 finish

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

- [ ] Policy lookup cache. `CapabilityGuard` calls `TypeOrmPolicyStore.getPoliciesForSubject`
  on every `/v1/*` request (two indexed queries). A short-TTL per-subject cache with
  invalidation on attach/detach/upsert/remove is the obvious optimization; the
  `MutablePolicyStore` contract makes it a decorator around the existing store.
- [ ] Group / role attachments. Today policies attach to a subject string (user id). Vault-style
  group membership (attach a policy to a group, add users to groups) is the next expansion —
  `@arc/identity` territory; the `PolicyStore.getPoliciesForSubject` would union direct + group
  policies.
- [x] Persisted policy store. New `MutablePolicyStore` contract in `@arc/grants` (read +
  upsert/remove/attach/detach/list; sync-or-async so both stores satisfy it; `InMemoryPolicyStore`
  now declares it). `TypeOrmPolicyStore` in `apps/arc-server/src/grants/` implements it against
  two new entities — `PolicyEntity` (name PK, `simple-json` scopes) + `PolicyAttachmentEntity`
  (unique (subject, policyName), indexed by subject, no FK so stale attachments are tolerated).
  `GrantsService` injects the store via a `POLICY_STORE` token (in-memory in unit tests, TypeORM
  in the app) and its mutators are async now. New migration `1717300000000-grants-schema.ts`
  creates `policies` + `policy_attachments`; registered in `app.module.ts` + `typeorm.config.ts`.
  The `PolicyEngine` didn't change — only the store behind it.
- [x] Admin HTTP API for grant management. `GrantsController` at `/v1/sys/policy`: `GET` (list),
  `POST` (upsert `{name, scopes:[{pathPrefix, capabilities}]}` with class-validator nested
  validation + capability enum), `DELETE /:name`, `POST /:name/attach` + `/:name/detach`
  (`{subject}`). Gated by the same `JwtAuthGuard + CapabilityGuard` as the rest of `/v1/*`, so
  the ACL surface protects itself — managing policies needs create/read/delete on `sys/policy/`.
  Bootstrap solved via `ARC_ROOT_USERS=1,2`: `GrantsService.onModuleInit` seeds a `root` policy
  (`sudo` on the empty prefix = all paths) and attaches it to those user ids, so `deny` mode is
  usable from a cold start. 7 admin e2e tests (root bootstrap reaches the API under deny, non-root
  denied everywhere, create→attach→access→detach→revoke→delete loop, unknown-policy 404,
  malformed-policy 400, non-root can't self-grant) + 8 service unit-specs (store delegation,
  parseRootUsers, onModuleInit seeding). Persistent path exercised through the real TypeORM store
  on sql.js.
- [x] PKI engine adapter. `PkiEngine` contract in `@arc/secrets-engine` (issue/sign/revoke
  /read/list certs + CA cert + CA chain), `OpenBaoPkiEngine` in
  `integrations/arc-openbao-adapter/src/pki-engine.ts` mapping arc's contract onto OpenBao's
  `pki/issue/<role>` / `pki/sign/<role>` / `pki/revoke` / `pki/cert/<serial>` / `pki/certs`
  / `pki/ca/pem` / `pki/ca_chain` HTTP layout (SANs comma-joined, TTL as `<n>s` per Vault).
  10 unit tests cover the mocked-fetch contract (issue body shape, sign-CSR override,
  revoke-by-serial, read-cert-with-or-without revocation_time, list, CA PEM, CA chain
  flattening, error case, custom mount). Mounted at `pki/` by `EnginesModule`; dispatched
  by `EnginesService` (GET for cert/list/ca/ca_chain, POST for issue/sign/revoke,
  Vault TTL strings + comma-CSV SAN parsing in the body). Live OpenBao e2e test rounds
  through issue → read → CA → revoke → re-read shows `revocation_time` → list.
- [x] Per-mount ACL on `/v1/*` via the new `@arc/grants` package. The package owns the
  policy model (`Capability`, `Scope`, `Policy`, `PolicyStore`), the matching helpers
  (`normalizePrefix`, `scope(prefix, caps)`, `scopeAllows` — slash-segment-safe so
  `secret/` never matches `secret-other/foo`), the `PolicyEngine` (decide + decideDetailed
  with `scope-match` / `no-matching-scope` / `no-policies` reasons), and an
  `InMemoryPolicyStore` (upsert/attach/detach/list, tolerates removed policies on lookup).
  21 unit tests cover the engine + scope semantics including default-allow vs default-deny,
  sudo-implies-all, multi-policy union, and the segment-boundary footgun. Wired into
  arc-server through `apps/arc-server/src/grants/`: `GrantsService` holds the store + engine,
  `CapabilityGuard` is a per-controller guard (`@UseGuards(JwtAuthGuard, CapabilityGuard)`
  on `EnginesController` + `PluginsController`) that maps HTTP method → capability
  (GET=read, GET?list=true=list, POST=create, PUT=update, DELETE=delete) and asks the
  engine. `ARC_DEFAULT_POLICY=allow|deny` (default `allow`) controls the "subject has no
  policies" fallback so dev/test stay frictionless and prod can flip to fail-closed.
  9 capability-guard unit-specs + 7 grants e2e tests boot the real app with
  `ARC_DEFAULT_POLICY=deny`, verify default-deny on `/v1/*` for a fresh user, attach a
  scoped policy and confirm only the covered path+capability passes, confirm `list`
  capability is required for `?list=true`, confirm `/vaults/*` (Engine-B) is unaffected,
  confirm 401-before-403 ordering when no bearer token is present, plus a default-allow
  smoke test that ensures the dev posture still works. `@arc/grants` dual-publishes ESM + CJS
  for the Jest runner.
- [x] In-process plugin host wired into arc-server. New `apps/arc-server/src/plugins/`
  module: `PluginsService` holds a `PluginHost` (from `@arc/plugin-sdk`) and exposes
  `register` / `mountSecretsPlugin(plugin, mountPath, config)` / `list` / `unmount`. Mounting
  registers in the same `MountRegistry` + `enginesByMount` map that drives `/v1/*` dispatch,
  with `PluginSecretsEngine` adapting `SecretsPlugin` (the plugin-author contract) onto
  `DynamicSecretsEngine` (the dispatcher contract). The shared `LeaseManager` owns arc
  lease ids for plugin-issued credentials; backend plugin lease ids ride in
  `lease.backendLeaseId`. Unmount calls `LeaseManager.revokePrefix` so every outstanding
  lease at that mount is revoked atomically. `EnginesService.get` now dispatches
  `<mount>/creds/<role>` against any `DynamicSecretsEngine` (not just type-`database`),
  which is what lets plugin mounts slot in without the dispatcher learning a new shape.
  `requireClient()` was dropped from `resolve` / `listMounts` / lease lifecycle so a
  plugin-only deployment (no OpenBao) is a valid configuration — `/v1/sys/seal-status` and
  `/v1/sys/health` still 503 since they're explicit OpenBao proxies. New `GET
  /v1/sys/plugins` controller for read-only listing (write-side will land with `@arc/grants`
  ACL — admin endpoint needs auth). 6 unit-spec tests on `PluginsService` cover the full
  loop: register/configure/mount → dispatch creds/<role> → renew via the plugin → revoke
  → unmount drops the registry + revokes prefix leases → configure() failure stays
  half-mounted-free → duplicate-name registration refused with 400. The test harness builds
  an `EnginesService` with `client: null`, proving plugin mounts work end-to-end without
  any OpenBao backend. `@arc/plugin-sdk` now dual-publishes ESM + CJS so Jest can `require()`
  `PluginHost` directly. Out-of-process plugins (gRPC / WASM) follow in a later commit;
  the host runtime here is the in-process foundation.
- [x] Database dynamic-credentials adapter (first dynamic-secrets engine). `OpenBaoDatabaseEngine`
  in `integrations/arc-openbao-adapter/src/database-engine.ts` implements `DynamicSecretsEngine`
  on top of OpenBao's `database/creds/<role>` (issue) + `sys/leases/renew` (renew) +
  `sys/leases/revoke` (revoke). `LeaseManager` is the source of truth for arc-internal lease
  ids (UUIDs); backend OpenBao lease ids ride along in `lease.backendLeaseId`. 8 adapter unit
  tests cover the issue + renew + revoke happy paths, default TTL, ttl override, not-renewable
  refusal, unknown-lease 404, and the body-form revoke. Mounted at `database/` by `EnginesModule`,
  which now also holds a process-wide `LeaseManager` in `EnginesConfig.leases`. New
  controller routes: `POST /v1/sys/leases/renew { lease_id, increment }`, `PUT
  /v1/sys/leases/revoke/<id>`, `POST /v1/sys/leases/revoke { lease_id }`. 5 unit-spec tests
  on `EnginesService` exercise the full lifecycle through a fake DynamicSecretsEngine (issue
  → renew → revoke → revoked-renew 400 → unknown-lease 404 → non-dynamic-mount 400). `lease_duration`
  is derived from `expiresAt - now` so renewal increments propagate to the wire even though
  `LeaseManager.renew` keeps `ttlSeconds` readonly. `@arc/leasing` now dual-publishes ESM + CJS
  so Jest can `require()` `LeaseError` / `LeaseManager` directly.
- [ ] `arc-server`: out-of-process plugin host (gRPC / WASM backend). The in-process
  module shipped above; out-of-process transport for sandboxed plugins is the follow-up.
- [ ] Cloud plugins: `arc-plugin-aws`, `arc-plugin-gcp`, `arc-plugin-azure`.
- [ ] SCM plugins: `arc-plugin-github`, `arc-plugin-gitlab`, `arc-plugin-bitbucket`.
- [ ] Auth plugins: `arc-plugin-oidc`, `arc-plugin-kubernetes`.

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
