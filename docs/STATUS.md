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
- [x] Per-vault UI affordances (icon + colour). New `@arc/types` `vault-ui.ts` exports two
  closed allowlists (`VAULT_ICONS` = 20 Lucide/Heroicons identifiers, `VAULT_COLORS` =
  12 brand `#RRGGBB` values tuned for ≥ 4.5:1 contrast vs white text) plus
  `isVaultIcon` / `isVaultColor` type guards — kept tight on purpose so a chart bump is
  the only way to add to either list. New `VaultEntity.icon` + `.color` nullable text
  columns (migration `1717800000000-vault-ui`) — both plaintext, because they're
  picker chrome, not secret material (the vault's *name* still rides as `encName`).
  `CreateVaultDto` accepts optional `icon` / `color` and the service allowlist-validates
  both before any write, throwing a 400 with `{ error: "invalid_icon", icon }` (or
  `invalid_color`) on anything off-list — no XSS via icon names rendered into the
  picker, no surprise URLs in colour values. New `PATCH /vaults/:id/ui` endpoint
  (admin-or-higher) with `UpdateVaultUiDto` semantics: `undefined` leaves a field alone,
  `null` clears it. `listVaults` + `createVault` responses now include `icon` + `color`.
  SDK: `VaultClient.createVault(type, name, { icon, color })` (optional 3rd arg, all
  existing callers still compile), `VaultClient.updateVaultUi(vaultId, { icon, color })`,
  and the allowlists themselves are re-exported from `@arc/sdk` so picker UIs don't need
  a separate `@arc/types` import. **11 new tests**: 8 unit tests on the allowlists +
  type guards in `@arc/types/test/vault-ui.test.ts` (rejects non-allowlist values,
  rejects non-strings, hex shape check on every blessed colour), plus 3 e2e tests in
  `vault-ui.e2e-spec.ts` (round-trip on create through listVaults, 400 with structured
  payload on `<script>` / `javascript:` injection attempts, PATCH semantics including
  `null` clears).
- [x] Secure-note format (plaintext vs markdown). `NoteItem` in `@arc/types/items.ts`
  gains an optional `format?: "plaintext" | "markdown"` discriminator. Default
  (missing / `undefined`) is equivalent to `"plaintext"` so notes written by every
  client predating this change keep displaying unchanged — the field is purely a render
  hint the client can opt into. The server still treats the body as opaque ciphertext
  and never parses it (Engine-B remains zero-knowledge); `format` only travels inside
  the encrypted payload, never as a server-visible column. Bitwarden-shape default
  matches what the existing `NoteDialog` already produces.

----

## In progress (this branch)

- (nothing — the full Engine-C arc (ADR-005, 8 PRs: #22–#28) has landed: agent principal +
  signed delegation + scope intersection (#22), signed-intent task chain + budget +
  cascade-revoke (#23), push-consent CIBA via passkeys (#24), SPIFFE attestation (#25),
  agent self-auth + RFC 8693 `act` claim (#26), signed plugin manifests (#27), NHI
  inventory view in the web console (#28). Engine A and Engine B were already done before
  that. Next pick from the open product questions or new strategic work — no concrete
  pending tasks remain in the implementation queue.)

----

## Pending

Order is rough priority. Each [ ] is one focused commit's worth of work unless flagged.

### Engine-C — agentic identity (ADR-005, all phases shipped)

Distilled from the agentic-AI security thesis (HashiCorp "continuous trust" / "shape of
trust"): make agents first-class, attributable, revocable principals with a *cryptographic*
human→agent→action chain rather than a stack of bearer JWTs. Composes with the engines
already shipped (Engine-A creds, Engine-B vault, `@arc/grants` policy); reuses
`signObject`/`verifyObject` + `pqSeal` + `chainNext` — no new crypto. Full design in
[`docs/arc-rfcs/ADR-005-agentic-identity-engine-c.md`](arc-rfcs/ADR-005-agentic-identity-engine-c.md).

- [x] **Phase 1+2 — principal + delegation** (`architecture/engine-c-agent-identity`).
  `@arc/types` ships the Engine-C wire shapes (`AgentIdentity`, `DelegationClaims` /
  `SignedDelegation`, plus the Phase-3 `SignedIntent` / `AgentTask` types pinned now);
  `@arc/crypto` adds `signDelegation`/`verifyDelegation`/`signIntent`/`verifyIntent` +
  `intentArgsDigest` (thin wrappers over `signObject`/`verifyObject` — no new algorithm);
  `@arc/grants` adds `effectiveAllows` + `intersectScopes` (the "delegation can only
  narrow" lattice meet, property-tested to agree). Server: `vault_agents` +
  `vault_delegations` entities + migration `1717900000000-agent-identity`; additive
  nullable audit attribution columns (`actorKind`, `agentId`, `delegationId`, `taskId`);
  `AgentsModule` (register / list / patch / delegate / revoke / **authorize** introspection)
  with signature verification against the delegator's published key + effective-scope
  intersection (delegated ∩ delegator-ceiling ∩ agent-ceiling) via the `agent:<id>` subject
  handle; autonomous mode **deny-by-default** (`autonomousAllowed` opt-in). SDK:
  `generateAgentKeyset` + `registerAgent`/`listAgents`/`updateAgent`/`createDelegation`
  (signs client-side)/`revokeDelegation`/`authorizeAgent`. **19 new tests**: 8 grants
  intersection (escalation/accumulation/sudo/disjoint truth-tables + meet⟺conjunction
  property), 6 crypto delegation/intent sign+verify+tamper, 5 e2e (intersection enforced,
  no-escalation, bad-signature/spoofed-delegator rejected, autonomous opt-in + budget +
  revoke, audit attribution). ADR-005 Accepted.
- [x] **Phase 3 — signed intent + task budget** (`feat/signed-intent-and-task-budget`).
  `@arc/crypto` adds `intentDigest` + `intentChainNext` (per-task hash chain over
  `signObject`/`chainNext`); `@arc/leasing` gains a `taskId` lease tag + `revokeByTaskId`.
  Server: `vault_agent_tasks` (budget + running chain head) + `vault_agent_intents`
  (recorded chain) entities + migration `1718000000000-agent-tasks-intents`; nullable
  `vault_audit_log.toolCall`. New `AgentTasksService`: `openTask` (budget defaults,
  delegation-bound or standalone), `submitIntent` (verifies the agent signature, recomputes
  `argsDigest` so the declared body is bound, derives the capability from the op verb,
  authorizes through the Phase-2 effective-scope decision, folds the intent into the task
  chain transactionally, meters calls + secret-unseals), `closeTask` (cascade-revoke every
  delegation + Engine-A lease tagged with the task id via the shared `ENGINES_CONFIG.leases`
  registry), `getTask?verify` (recompute + check the chain — tamper-evidence). SDK:
  `openTask`/`submitIntent` (signs with the agent key)/`getTask`/`closeTask`. **15 new
  tests**: 2 leasing `revokeByTaskId`, 2 crypto chain (canonical digest + order-sensitive
  tamper-evidence), 4 grants/crypto reuse, plus 4 e2e (chain advance + verify, forged
  `argsDigest` + wrong-key signature rejected, call-budget exhaustion, close cascades +
  refuses further intents). Workspace stays 70/70 turbo green (server 28 suites, 141
  passed). v1 of Phase 3 ships the *cryptographically-bound* action chain; the agent's own
  authenticated credential path (vs. owner-JWT-submitted intents) is the remaining slice.
- [x] **Phase 4 — push-consent CIBA via passkeys** (`feat/push-consent-ciba`). An action the
  policy would allow but which runs under an `elevated` delegation is blocked pending
  out-of-band human approval — arc's CIBA, on our own passkeys, no third-party IdP. New
  `vault_pending_approvals` entity + migration `1718100000000`, each row pinned to one
  `intentDigest` (a grant authorizes exactly the action shown to the human). `submitIntent`
  gate: an allowed-but-elevated intent registers a pending approval and returns
  `{ decision: "deny", reason: "approval-required", approvalId }` **without** recording or
  metering the action; the agent re-submits the identical signed intent once granted.
  `ApprovalsService` (`ensurePending` idempotent, single-use `tryConsume`, `listPending`,
  `beginApproval`→challenge, `approve`→verify, `deny`) reuses `PasskeyService` via two new
  generic methods (`beginAssertionChallenge` + `verifyAssertionWithChallenge`) so proof of
  control is a real WebAuthn assertion (UV required, anti-clone counter), not a tappable yes.
  New `ApprovalsController` under `/vault/approvals`. SDK:
  `listApprovals`/`beginApproval`/`approve`/`denyApproval` + `approvalId` on the intent
  result. **3 e2e** (shared `FakeAuthenticator` helper — real ES256/CBOR, no bypass):
  elevated blocked → passkey grant → resubmit allowed + single-use; deny leaves it blocked;
  approve without an assertion is 401. Workspace 70/70 turbo green (server 29 suites, 144
  passed).
- [x] **Phase 5a — agent attestation** (`feat/agent-attestation`). Pluggable
  `AttestationVerifier` interface (selected by `kind`) with `SpiffeAttestationVerifier` as
  the first concrete input + an `AttestationService` policy layer. `AgentsService.register`
  verifies a presented attestation and records the resolved workload identity
  (`{ verified, subject, trustAnchor, verifiedAt }`); `ARC_AGENT_ATTESTATION=required`
  refuses enrollment without one, `ARC_SPIFFE_TRUST_DOMAINS` is an optional trust-domain
  allowlist. **Honest scope:** v1 validates the SVID *identity* (`spiffe://` format +
  trust-domain policy) and records it. **Enforce mode** (`feat/attestation-enforce-mode`)
  upgrades the SPIFFE verifier with **cryptographic X.509-SVID validation** when
  `ARC_SPIFFE_ENFORCE=true`: chain walked to a root in the configured trust bundle
  (`ARC_SPIFFE_TRUST_BUNDLES=<domain>=<pem-path>,…`), validity dates checked, SPIFFE URI
  pulled from the leaf's SAN. Fail-closed in production (server refuses to boot when
  enforce is on but no bundles are configured). Bare SPIFFE-ID strings refused in enforce
  mode (no crypto to verify). Honest deferred scope: JWT-SVID enforce remains in record
  mode until a follow-up adds JWKS-based signature verification. The verifier interface is
  the real decision — sigstore / TPM / cloud-IID slot in unchanged. **15 unit tests**
  total (5 record-mode + 5 enforce-mode against a real openssl-issued SPIFFE leaf + 5
  service / env-config tests, with the chain-anchor / unrelated-CA / expired-leaf /
  missing-bundle / wrong-allowlist negative paths all asserted). Workspace 70/70 turbo
  green (server 36 suites, 191 passed).
- [x] **Phase 5b — plugin-manifest provenance** (`feat/plugin-manifest`). Closes the
  "anyone can mount any artifact off disk" gap: an OOP / WASM plugin is mounted only when
  its **signed manifest** pins the artifact's SHA-256 *and* names a publisher arc trusts.
  `@arc/types` adds `PluginManifestClaims` + `SignedPluginManifest` (`kind: "wasm" | "process"`).
  `@arc/crypto` ships `signPluginManifest` / `verifyPluginManifest` (thin wrappers over
  `signObject`/`verifyObject` — no new crypto) + `pluginArtifactDigest`. Server
  `PluginManifestService` reads `ARC_PLUGIN_MANIFEST` (optional/required) +
  `ARC_PLUGIN_TRUST_ANCHORS` (comma-separated `publisher=<b64url-pub>` allowlist) and gates
  `PluginsService.mountRemoteSecretsPlugin` / `mountWasmSecretsPlugin` — the verifier
  short-circuits the mount path *before spawn*, so a tampered binary or unknown signer never
  forks a child. **14 tests** (manifest sign/verify round-trip + tamper, service unit, +
  integration through `PluginsService`).
- [x] **Phase 5b runtime capability gate** (`feat/plugin-capability-gate`). Extends Phase 5b
  beyond *who built it* + *what it is* into *what it's allowed to do*: a manifest's
  `capabilities` field — when present — is validated against the canonical arc-grants
  vocabulary at verify time (`create|read|update|delete|list|sudo`; unknown verb →
  `capability_unknown` refusal so operator typos surface immediately), and the resolved set
  is **pinned onto the mount** in `EnginesConfig.manifestCapsByMount`. The engine dispatcher
  (`EnginesService.get/post/delete/renewLease/revokeLease`) consults the pin on every
  request: a verb not in the declared set (and not implied by `sudo`) returns 400 with
  `reason: "plugin_capability_not_declared"` + the requested verb + the declared set, so
  operators can grep audit logs and know exactly which manifest line would unblock. Verb
  mapping mirrors Vault's policy semantics — `creds/<role>` ⇒ `read`, lease renew ⇒
  `update`, lease revoke ⇒ `delete`, KV put ⇒ `create`-or-`update`, transit/PKI write ⇒
  `update`, etc. Honest scope: built-in OpenBao mounts and plugins that omit `capabilities`
  bypass the gate (identical to the pre-gate path); the gate only activates for plugins
  that explicitly declared a cap set. **12 new tests**: 4 service-level on the verifier
  (declared caps surfaced, unknown verb rejected, `capabilities` absent ⇒ undefined,
  `sudo` accepted), 8 integration through the dispatcher (no-pin bypass, declared-verb
  allows, undeclared verb 400's with the structured reason, `sudo` short-circuits, unmount
  clears the pin, empty `[]` is the strict zero-trust posture). Workspace stays 70/70 turbo
  green (server 37 suites, 195 passed).
- [x] **Signed plugin release toolchain** (`feat/signed-plugin-release-toolchain`). Closes
  the gap between "the gate exists" and "operators can ship a signed plugin." New
  `tools/arc-plugin-sign` workspace package (CLI + lib) — three subcommands:
  - `arc-plugin-sign keygen` — generates an Ed25519 publisher keypair, writes the priv to a
    mode-0600 file (so it isn't world-readable on shared CI runners), emits the pub on
    stdout for `ARC_PLUGIN_TRUST_ANCHORS` pinning;
  - `arc-plugin-sign sign --artifact … --priv {file|env:VAR} --capabilities <csv>` — hashes
    the artifact bytes, validates the verb set against the arc-grants vocabulary upfront
    (so typos fail at build time, not in production), emits a `SignedPluginManifest` JSON
    file. `env:VAR` keeps the priv off disk in CI secrets;
  - `arc-plugin-sign verify` — re-hash + signature + capability check, mirrors arc-server's
    `PluginManifestService.verify` reason strings byte-for-byte so a local failure tells
    operators exactly what would have failed in production. Exits 0/1/2.
  Adds an OOP entry to `arc-plugin-aws` (`src/bin.ts` → `dist/bin.cjs` self-contained,
  AWS-SDK external) that `RemoteSecretsPlugin.spawn` can invoke directly via the bin's
  shebang — making the bin file itself the artifact the manifest pins. Workspace globs
  grew to include `tools/*`. **22 new tests**: 9 lib spec (keygen freshness, round-trip
  sign/verify, capability typo refused, default issuedAt, tamper detection, signer
  mismatch, vocabulary), 10 CLI spec (keygen file modes, sign + verify CLI round-trip,
  env:VAR priv path, missing env handles cleanly, verify exits 2 on tamper, invalid
  --kind, unknown subcommand), 3 arc-server signed-release e2e (publisher signs → operator
  pins → server mounts → gate dispatches; refusal on artifact tamper; refusal on
  unanchored publisher). Workspace stays 73/73 turbo green (server 38 suites, 198 passed).
- [x] **Plugin release pipeline + operator install + boot-time auto-mount**
  (`feat/plugin-release-pipeline`). Turns the signed-release toolchain from "operators
  *can* ship and consume signed plugins" into "the publish side is automated and the
  consume side is one CLI command." Three surfaces:

  - **`.github/workflows/release-plugin-aws.yml`** — tag-driven (`plugin-aws-v*`) +
    `workflow_dispatch`. Builds the OOP `arc-plugin-aws` bin, signs the manifest with
    `secrets.ARC_PUBLISHER_PRIV` (declared capabilities: `read,delete` — STS creds are
    non-renewable so `update` is intentionally absent), self-verifies via the same CLI,
    bundles a `release-arc-plugin-aws-<v>.tar.gz` (bin + manifest + SHA256SUMS) plus the
    loose files, and publishes a GitHub Release via `softprops/action-gh-release@v2`.
    Fail-safe: when the secret is unset the workflow still runs end-to-end with a
    workflow-local key (publish step skipped) so CI on a PR exercises the path before
    real keys are rotated.
  - **`arc-vault plugin install|verify`** — new operator-side `arc-cli` subcommands.
    `install --release <url-prefix> --pub <b64u-or-file> --out-dir <dir>` downloads
    `bin.cjs` + `manifest.json` from a release URL prefix (HTTP fetch via stdlib;
    injectable for tests), writes them under `<out-dir>/<name>/`, verifies via
    `@arc/plugin-sign` against the publisher pub, `chmod +x`'s the bin, and prints the
    exact `ARC_PLUGIN_MOUNTS=…` + `ARC_PLUGIN_TRUST_ANCHORS=…` snippets the operator
    copy-pastes into arc-server's env. `--from-dir` lets operators install from an
    air-gapped tarball they fetched out-of-band. `--pub` accepts a raw b64u key, a file,
    or a file containing the `publisher:<id>=<b64u>` anchor shape. Refusal exits 2 with
    the structured reason, leaves files on disk for inspection. `verify` is the offline
    half — no download, just `--artifact + --manifest + --pub`.
  - **`ARC_PLUGIN_MOUNTS` boot-time auto-mount** — new `apps/arc-server/src/plugins/
    plugin-mounts.ts` + `OnApplicationBootstrap` hook on `PluginsService`. Env shape:
    `<mount-path>=<bin>[?manifest=<json>][&config=<json>],…`. Each entry mounts
    independently through the existing manifest gate; a malformed line is skipped with a
    structured warning, a refused entry surfaces the gate's reason in the boot log
    (`artifact_hash_mismatch`, `untrusted_publisher`, etc.), and the rest still mount.
    No new admin HTTP endpoint — runtime mount/unmount remain programmatic-from-config
    (the env is the operator contract).

  Adds a `pubkey` subcommand to `arc-plugin-sign` (derive the b64u pub from an existing
  priv) so the release workflow can self-verify without a second secret round-trip.

  **41 new tests**: 5 lib spec (`pubkey` round-trip + b64u length checks + new
  derivation), 2 CLI spec (`pubkey` --priv file + env:VAR), 14 `arc-cli` plugin
  command spec (install from-dir + via HTTP + tamper refusal + signer mismatch + name +
  mount-path overrides + pub-as-file + pub-as-anchor-shape + 404 handling + verify
  happy/refused, usage), 15 plugin-mounts unit (env parser + file resolver + spec
  builder edge cases), 5 auto-mount e2e (signed plugin auto-mounts; bad entry isolated;
  tamper refused; no-manifest gate-bypass; config thread-through). Workspace stays
  74/74 turbo green (server 40 suites, 217 passed). New `arc-cli:test` task surfaces
  in turbo for the first time.
- [x] **Agent self-authentication + RFC 8693 `act` claim** (`feat/agent-credential-path`).
  Completes the Phase-3 credential path: an agent proves control of its Ed25519 signing key
  via challenge-response (`POST /vault/agents/:id/auth/challenge` → sign the nonce →
  `/auth/token`, both unauthenticated by design — the agent has its key but no session yet)
  and receives a short-lived (10m) JWT carrying the owner as `sub`, the `agentId`, and the
  RFC 8693 `act: { sub: "agent:<id>" }` actor claim. `JwtStrategy` + `CurrentUserData`
  surface `agentId`/`actSub`; `POST :id/intents` now accepts the agent's **own** token and
  refuses an agent token scoped to a different agent (`agent_token_scope_mismatch`). SDK:
  `agentToken(agentId, signingPriv)` (challenge+sign+token) + `useBearerToken`. **3 e2e**:
  agent self-auth → submits its own intent (allow) + token carries the `act` claim;
  cross-agent token rejected (403); wrong-key challenge signature rejected (400). Workspace
  70/70 turbo green (server 31 suites, 155 passed).
- [x] **NHI inventory view** in `arc-vault-web` (`feat/nhi-inventory-view`). New "Identities"
  section in the console (between Access and Policies) backed by `IdentitiesView` — surfaces
  every agent the operator owns. Summary tiles (total / active / autonomous / attested) +
  per-row card with display name, status badge (`active`/`suspended`/`retired`), SPIFFE
  attestation badge (with `trustAnchor` tooltip), autonomous flag, owner, agent id, last-seen
  (relative time), and quick controls for *toggle autonomy* / *suspend ↔ resume* / *retire*
  via `VaultClient.updateAgent`. `AgentAttestation` in `@arc/types` extended (additively) to
  surface the server-augmented `verified` / `subject` / `verifiedAt` fields the verifier
  records. Zero-knowledge property preserved — only public agent state is fetched. Web build
  is green (`pnpm --filter @arc/vault-web build` + workspace typecheck 70/70).

### Phase 1 finish

- [x] Blob storage for encrypted attachments. New `apps/arc-server/src/blob/` with a tiny
  `BlobStore` interface and three implementations: **`InMemoryBlobStore`** (default — dev /
  tests / small single-replica), **`FilesystemBlobStore`** (SHA-256-hashed sharded paths so
  the on-disk layout is traversal-proof; atomic write via temp+rename; mode 0600), and
  **`S3BlobStore`** (talks through an injectable `S3Like` so the tests don't pull
  `@aws-sdk/client-s3` at build time; the AWS SDK is **lazy-loaded only when
  `ARC_BLOB_BACKEND=s3`** and declared as an optional peer dep, so arc-server boots fine
  without it installed). Backend selection is env-driven via the `BlobModule`
  (`ARC_BLOB_BACKEND` + per-backend vars). New `VaultAttachmentEntity` (id, vaultId, itemId,
  blobKey, sizeBytes, wrappedKey, encMetadata envelopes, vaultKeyVersion, authorUserId,
  createdAt) + migration `1717600000000-attachments-schema`. Four new endpoints under
  `/vaults/:id/items/:itemId/attachments` (upload / list / download / delete) gated by the
  existing `requireRole` (editor for write, viewer for read; non-members get 404 to hide
  existence). The server stays zero-knowledge: ciphertext is opaque base64 it persists
  verbatim, and the wrappedKey/encMetadata envelopes mean it never sees plaintext filenames
  either. Hard 25 MiB ceiling per attachment enforced in the service (`PayloadTooLargeException`);
  body-parser limit raised to 40 MiB to fit base64 inflation. Audit log records distinct
  `attachment_added` / `attachment_deleted` actions (metadata only — asserted in the test).
  **15 new tests**: 10 unit tests on the three backends + `newAttachmentKey` (put/get/delete
  round-trips, buffer isolation, idempotent delete, `BlobNotFoundError` shape, S3 prefix
  threading, opaque-key uniqueness) and 5 e2e tests through the full HTTP surface
  (round-trip preserves bytes verbatim; 413 on oversized + empty; 404 hides the vault from
  non-members; audit emits both actions without leaking ciphertext).

### Phase 2 — multi-device + shared vaults

- [x] Desktop (Tauri shell) wired up. `apps/arc-vault-desktop/src-tauri/src/lib.rs` now
  exposes 13 `#[tauri::command]`s: session (`vault_set_autolock` / `_lock` / `_is_locked`
  / `_touch`), device + grants (`vault_device_keypair`, `vault_load_grant`,
  `vault_wrap_vek_for_device`), narrow item ops (`vault_encrypt_item` /
  `vault_decrypt_item` — VEK never crosses to the WebView), and the local cipher cache
  (`cache_open` / `_upsert` / `_get` / `_list`). A background watcher thread polls
  `Session::is_locked()` every second and emits `arc://vault-locked` on the
  unlocked → locked transition so the WebView can drop keys + redirect without polling
  Rust on every keystroke. `OsKeyStore` (Secret Service / macOS Keychain / Windows
  Credential Manager) stores the device X25519 private key; the keychain feature is on
  by default in the shell. `tauri.conf.json` points `frontendDist` at
  `../../arc-vault-web/out` (`pnpm --filter @arc/vault-web build:desktop`); `devUrl`
  pre-runs `pnpm --filter @arc/vault-web dev`. Frontend bindings live in
  `apps/arc-vault-web/src/lib/tauri.ts` — typed wrappers around `invoke`/`listen`, plus
  an `isDesktop()` detector (`window.__TAURI_INTERNALS__`) so plain `next dev` falls
  back to the in-browser crypto path. The web's auto-lock effect now mirrors the
  autolock setting into the Rust session and subscribes to `onLocked` so the OS-level
  idle TTL drives the same UX as the browser-side input listeners. `crates/desktop-core`
  tests (5) still pass locally; the Tauri shell itself only builds with GTK system libs
  installed (Linux) — documented in the shell's README.
- [x] Hybrid (X25519 + ML-KEM-768) device keypair — **ADR-003**. Every new device
  registered through `@arc/sdk` now generates a `HybridKeyPair`, registers both pubs in a
  single atomic `POST /vault/devices`, and the trusted approver wraps VKs to that device
  with `pqSeal` so device-grant material is HNDL-resistant. Closes the ADR-002 §Phase-4
  footnote that had left device grants on classical X25519 only. Server:
  `vault_devices.publicKeyMlkem` (nullable b64url column; migration
  `1717700000000-device-hybrid-key`) so legacy X25519-only devices stay valid and new ADR-003
  devices populate it. DTO: `RegisterDeviceDto.publicKeyMlkem` (optional).
  `listPendingDevices` + `listApprovedDevices` surface the new pub so the approver can pick
  `pqSeal` vs `seal` per device with no guess. **SDK is the path of truth** for now — the
  Rust desktop core gets the same primitive in a follow-up (`vault-crypto-rs` PQ + Tauri
  commands), tracked in the ADR. SDK behaviour: `registerDevice` keeps both privates in
  process memory and registers both pubs; `approveDevice(deviceId, x25519Pub, mlkemPub?)`
  uses `pqSeal` when the mlkem pub is provided and falls back to classical `seal` so a
  legacy device approved by a new SDK still works; `loadDeviceGrants` disambiguates by the
  envelope's `alg` (`pq-*` → `pqSealOpen`, classical `seal-*` → `sealOpen`) so
  **mixed-envelope keysets work transparently** — a single device can have pre-ADR-003 and
  new grants and both decrypt. Verification code stays over the X25519 pub for back-compat
  with existing SAS displays; the ML-KEM pub joins the same trust anchor by atomic
  registration. The verifier ceremony is unchanged for users. New 1 e2e test
  (`sdk-device-hybrid.e2e-spec.ts`) drives the full path through the real server: trusted
  enrolls + writes a probe → new device registers hybrid → trusted approves with `pqSeal`
  → new device opens with `pqSealOpen` → decrypts the probe. New ADR doc:
  `docs/arc-rfcs/ADR-003-hybrid-device-keys.md`. Workspace gate stays 70/70 turbo green;
  server tests 23 suites / 125 passing (was 124).
- [x] Browser extension autofill is real now (was just messaging scaffold). Three
  upgrades land here. **(1) Background auto-lock TTL** — the worker exposes
  `arc:setAutolock` (30–3600s, default 300s) + `arc:status` (`{unlocked, lockInSeconds}`),
  persists the TTL in `chrome.storage.session`, and every fill/list/get touches an idle
  timer that wipes `client` + `logins` + the activity timestamp when it expires. Every
  message handler now gates on `isUnlocked()` so requests after the worker is killed by
  MV3 lifecycle (or its idle TTL) get clean `{unlocked: false}` / empty responses
  instead of a stale-state crash. **(2) Inline suggestion overlay** — content script
  listens for `focusin` on password inputs, asks the worker for an origin-matched
  credential, and on a match renders a small floating "Use arc" button anchored above
  the field. Single click fills username + password via the existing field-detection
  heuristic. Anti-spam: shown at most once per page load; dismissed by clicking
  anywhere else. HTTPS-only — `location.protocol !== "https:"` short-circuits before any
  worker round-trip. All affordances stay user-initiated (no auto-fill on focus).
  **(3) Tests** — 10 new vitest cases covering the auto-lock state machine (unlocked →
  TTL elapses → locked; status returns `lockInSeconds: null` when locked; explicit
  `lockNow()` drops state) + the overlay logic (shown only on origin-match + HTTPS,
  filtered to password inputs, suppressed on second focus, click fills both fields and
  removes the overlay). 16 total in the extension (was 6).
- [x] Passkey unlock — **server + SDK + web UI all shipped.** Web UI: new
  `PasskeysSection` component embedded in the Settings dialog (list with createdAt + label,
  remove button per entry, register button with optional label field) + a "Use a passkey"
  button on the unlock screen (shown alongside Unlock / Create vault). Both call into the
  `browserPasskeyAuthenticator()` factory in `@arc/sdk`. Error messages are friendlier:
  PRF-not-supported → "Try Chrome 116+ or Safari 17+", cancellation → "You cancelled the
  OS prompt", origin-blocked → "check the page is on https or localhost". Auto-locked
  passkey list shows "No passkeys registered yet" on empty state. The web's `vault-app.tsx`
  now passes the `VaultClient` instance through SettingsDialog so the passkey section can
  render only when unlocked (server-side reads require the JWT, listPasskeys is gated
  through arc-server's auth). Web typecheck clean.
- [~] Original passkey work (preserved for diff reference) — Per-user-stable `prfSalt` persisted so register + unlock derive the same
  wrap key. `@arc/crypto` adds wrap/unwrap pairs for ML-KEM identity priv *and* signing
  priv under distinct AAD labels — so passkey unlock unwraps all three privs and produces
  a full read+write session, not read-only. `@arc/sdk` ships `registerPasskey` /
  `unlockWithPasskey` / `listPasskeys` / `removePasskey` + a `browserPasskeyAuthenticator()`
  factory; tests inject a fake authenticator (real ES256 signatures + HKDF-derived PRF).
  New `sdk-passkey.e2e-spec.ts` boots the real server, registers on client A, unlocks a
  *fresh* client B with the same authenticator, round-trips an item write (proving the
  signing priv unwrapped too), and asserts removePasskey invalidates subsequent unlock.
  Original `vault_user_passkeys` table (userId + credentialId unique, public key, counter,
  per-credential PRF-wrap envelopes for X25519, ML-KEM, signing identity privs, optional
  label + transports). `PasskeyService` drives the WebAuthn flow via
  `@simplewebauthn/server` (RP / origin / RP-name from env: `ARC_PASSKEY_RP_ID`,
  `ARC_PASSKEY_RP_NAME`, `ARC_PASSKEY_ORIGIN`). Six endpoints under `/vault/passkey/*`:
  `register-challenge` (with PRF salt), `register` (verifies attestation + stores wraps),
  `GET /vault/passkeys` (list), `DELETE /vault/passkeys/:id`, `unlock-challenge` (with
  `allowCredentials` + PRF salt), `unlock` (verifies assertion + advances signature counter
  + returns the wraps). Counter regression is rejected with 401 (anti-clone); challenges
  are in-memory keyed by userId with a 5-min TTL (Redis-backed store is the multi-instance
  follow-up). New migration `1717400000000-passkey-schema.ts`. The server *never* sees the
  PRF output, identity key, or master key — zero-knowledge posture identical to
  master-password unlock; passkey is additive, not a replacement. 6 hermetic e2e tests
  drive a self-contained `FakeAuthenticator` (real ES256 P-256 keypair, hand-rolled CBOR
  attestation, real signed assertions) through register → list → unlock → signCount-replay
  rejected → 404 for no-passkey user → corrupted-sig rejected → delete. Workspace total:
  295 tests passing.
- [x] Multi-device key rotation — **auto-revoke for retired devices + audit hooks**.
  Adds two pieces above the existing manual rotation path. (1) `POST /vault/devices/me/touch`
  — the SDK calls this on unlock and periodically so the device's `lastSeenAt` stays
  fresh; ownership-checked (a different user's deviceId → 404). (2) New
  `DevicesAutoRevokeService` — env-gated (`ARC_DEVICE_INACTIVE_DAYS`, default 0 = OFF) and
  configurable (`ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS`, default 1 h). Plain `setInterval` —
  no `@nestjs/schedule` dep — `.unref()`'d so it never holds the process up. Each scan
  finds approved-but-untrusted devices whose `lastSeenAt` (fallback `createdAt`) is older
  than the inactivity cutoff, deletes the device + its `vault_key_grants` rows, and
  writes a **distinct `device_auto_revoked` audit entry** so investigators can tell apart
  intentional retirement from inactivity sweep. **Trusted devices (`trusted: true`) are
  exempt** — that's the operator's "never auto-revoke" escape hatch. Pending devices
  (`approved: false`) are also skipped — they have their own onboarding cleanup story.
  New admin trigger: `POST /vault/devices/auto-revoke/run` for "apply the policy now"
  (returns `{ enabled, revokedIds }`). `GET /vault/devices?approved=true&pending=false`
  surfaces approved devices with `lastSeenAt` + `trusted` so a "My devices" UI can warn
  about inactive devices. **SDK** (`@arc/sdk`): new `listDevices()`, `touchDevice(id)`,
  `revokeDevice(id)` methods + `EnrolledDevice` type. **8 new e2e tests** (7 in
  `devices-auto-revoke.e2e-spec.ts` + 1 in `sdk-devices.e2e-spec.ts`): touch updates
  `lastSeenAt`; ownership check 404s a foreign device; approved-only listing returns the
  right shape; runOnce retires stale-untrusted, keeps fresh + trusted + pending, writes
  `device_auto_revoked`; HTTP admin trigger reports `enabled` + `revokedIds`; manual
  DELETE still works alongside auto-revoke and writes `device_revoked` (not the auto
  variant); the feature is OFF by default when the env var isn't set; SDK round-trip
  through CJS dist. Workspace totals climb to 70 turbo tasks + 109 server tests + 6
  skipped.

### Phase 3 — Engine A + plugin host
- [x] Group / role attachments shipped. `MutablePolicyStore` contract extended with
  `addToGroup` / `removeFromGroup` / `attachToGroup` / `detachFromGroup` /
  `listGroupsForSubject` / `listSubjectsInGroup` / `listGroupPolicies`.
  `getPoliciesForSubject` now returns the **union** of direct attachments + every policy
  reached via an attached group (deduped, stale-tolerant). `InMemoryPolicyStore`
  + `CachingPolicyStore` + the new `TypeOrmPolicyStore` all implement it. Cache invalidation:
  `addToGroup`/`removeFromGroup(subject, _)` drop just the subject's entry; `attachToGroup`/
  `detachFromGroup` flush the whole cache (we don't track a reverse group→members index
  here — admin-time + low frequency, fine). New entities `policy_group_memberships` +
  `policy_group_attachments`, migration `1717500000000-grants-groups-schema`. New
  `GroupsController` at `/v1/sys/groups/`: GET `:group` (describe), POST `:group/members`
  + `members/remove`, POST `:group/policies` + DELETE `:group/policies/:policyName`,
  same `JwtAuthGuard + CapabilityGuard` as the rest of the ACL surface (so groups protect
  themselves the same way policies do). 15 new unit tests in `@arc/grants` (49 total, was
  34) covering idempotent add/remove, union resolution, direct+group dedup, group-remove
  drops inherited access, cache invalidation. 7 new server e2e tests
  (`grants-groups.e2e-spec.ts`) exercising the full Postgres-backed loop through the HTTP
  surface: implicit-group describe, transit-via-group access, member-remove revokes,
  policy-detach revokes for every member, unknown-policy 404, non-root denied, direct+group
  union preserved when the group link is removed. Workspace total: 322 tests passing.
- [x] Persisted policy store. New `MutablePolicyStore` contract in `@arc/grants` (read +
  upsert/remove/attach/detach/list; sync-or-async so both stores satisfy it; `InMemoryPolicyStore`
  now declares it). `TypeOrmPolicyStore` in `apps/arc-server/src/grants/` implements it against
  two new entities — `PolicyEntity` (name PK, `simple-json` scopes) + `PolicyAttachmentEntity`
  (unique (subject, policyName), indexed by subject, no FK so stale attachments are tolerated).
  `GrantsService` injects the store via a `POLICY_STORE` token (in-memory in unit tests, TypeORM
  in the app) and its mutators are async now. New migration `1717300000000-grants-schema.ts`
  creates `policies` + `policy_attachments`; registered in `app.module.ts` + `typeorm.config.ts`.
  The `PolicyEngine` didn't change — only the store behind it.
- [x] Policy lookup cache. New `CachingPolicyStore` decorator in `@arc/grants` wraps any
  `MutablePolicyStore`: per-subject read cache with configurable TTL (default 30s, 0 to
  disable). `getPoliciesForSubject` hits cache; `attach`/`detach(subject)` invalidate that
  subject's entry; `upsertPolicy`/`removePolicy` flush the whole cache (couldn't know which
  subjects an edited policy reaches). `listPolicies` bypasses the cache. 13 unit tests cover
  read caching, TTL expiry, disable-via-`ttlMs=0`, per-subject independence, selective
  invalidation, contract pass-through (unknown-policy throw still propagates), plus two
  end-to-end correctness tests proving newly-attached / newly-removed policies are visible
  on the very next read with no stale window. Wired into arc-server: `GrantsModule` now
  provides the raw TypeORM store under a private token and exposes a `CachingPolicyStore`
  factory under `POLICY_STORE`. `ARC_POLICY_CACHE_TTL_MS` overrides the 30s default (set to
  0 to bypass entirely). `CapabilityGuard` is unchanged — it sees the same `MutablePolicyStore`
  interface, just one with the two DB queries memoized.
- [x] GCP cloud plugin: `@arc/plugin-gcp`. New workspace at `plugins/cloud/arc-plugin-gcp/`.
  Implements `SecretsPlugin` over IAM Credentials `generateAccessToken`: configure with a
  `roles` map (`targetServiceAccount`, `scopes[]`, optional `defaultTtlSeconds`,
  `maxTtlSeconds`, `delegates`); `issue` POSTs `…/serviceAccounts/<sa>:generateAccessToken`
  and returns the OAuth2 bearer + GCP-reported expiration as the lease TTL; `renew` throws
  (not renewable, re-issue instead); `revoke` is a no-op at GCP (IAM Credentials has no
  per-token revocation) but drops local tracking. Default `IamCredentialsClient` lives behind
  the `@arc/plugin-gcp/google-auth-library` subpath using `google-auth-library` as an optional
  peer dep — tests inject a fake. 18 unit tests + 3 server integration specs through
  `PluginsService`+`EnginesService` (mount/dispatch/renewable=false propagation/unmount-revokes-leases/invalid-config-stays-unregistered).
- [x] GitHub SCM plugin: `@arc/plugin-github`. New workspace at `plugins/scm/arc-plugin-github/`.
  Implements `SecretsPlugin` over the GitHub App installation-token endpoint. Configure with
  `appId` + `privateKeyPem` + a `roles` map (`installationId`, optional `repositories[]`,
  `repositoryIds[]`, `permissions {read|write|admin}`); `issue` POSTs
  `/app/installations/<id>/access_tokens` and returns the bearer token + 1h expiration;
  `renew` throws; `revoke` is a no-op (the DELETE endpoint would round-trip the token through
  audit). Default `GitHubAppClient` lives at `@arc/plugin-github/node` using Node built-ins
  only (`node:crypto` for RS256 JWT signing of the App-level JWT + global `fetch` — no
  external deps). 13 plugin unit tests + 7 node-client tests (real RSA keypair generated
  per test file, JWT signature verified with public key, request shape + GHES base override
  + error paths) + 3 server integration specs. Cross-plugin spec confirms AWS / GCP /
  GitHub-style plugins all dispatch independently from the same MountRegistry. Workspace
  total: 289 tests passing.
- [x] First real plugin: `@arc/plugin-aws`. New workspace at `plugins/cloud/arc-plugin-aws/`,
  implementing `SecretsPlugin` for dynamic IAM credentials via STS AssumeRole. Lifecycle
  matches Vault's `aws` engine for `assumed_role`: `issue` → AssumeRole returning
  `{access_key, secret_key, session_token, assumed_role_arn}` + the seconds-until-expiration
  as the lease TTL; `renew` always throws (STS creds are not renewable, re-issue instead);
  `revoke` is a no-op at AWS (matches Vault — cannot force-expire short of an IAM Deny) but
  drops local tracking so the arc LeaseManager records the revocation. Plugin accepts any
  `StsClient` impl at construction, so tests inject a fake; the shipped
  `@arc/plugin-aws/aws-sdk` subpath provides a `createSdkStsClient(opts)` factory backed by
  `@aws-sdk/client-sts` (declared as an **optional peer dep** so callers with their own SigV4
  / IMDSv2 / web-identity transport don't pay for the SDK install). Config validation guards
  the admin-side wiring: unknown roles throw at `issue` time; `defaultTtlSeconds >
  maxTtlSeconds` is a configure-time error; caller-supplied TTL is clamped to
  `role.maxTtlSeconds` before the STS request so a runaway caller can't out-request the
  operator. 19 plugin unit tests cover configure / issue / renew / revoke + the `clampTtl`
  helper, all hermetic via the fake StsClient. 5 server integration specs prove the full
  loop end-to-end: `PluginsService.mountSecretsPlugin` registers + configures + mounts the
  AWS plugin → `EnginesService.listMounts` shows `plugin:arc-plugin-aws` → `GET /v1/aws/creds/<role>`
  dispatches through the existing `DynamicSecretsEngine` branch → returns the Vault wire
  shape with `renewable: false` → `renewLease` correctly refuses with 400 → `revokeLease`
  marks the arc lease revoked → invalid config rejects at mount with the plugin staying
  unregistered → unmount drops the registry entry and revokes outstanding leases. First
  non-OpenBao mount in the test matrix; proves the plugin host runtime actually works.
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
- [x] Out-of-process plugin host (process backend over stdio). The in-process host shipped
  above; this lands the **sandbox boundary** — sandboxed plugins now run in their own child
  process, talk to arc-server via **JSON-RPC 2.0 over stdio**, and implement the same
  `SecretsPlugin` contract so the rest of arc-server can't tell them apart from in-process
  plugins. Two pieces in `@arc/plugin-sdk`: **`RemoteSecretsPlugin`** (host side — spawns
  the child, performs a `meta` handshake, then proxies `configure/issue/renew/revoke` over
  line-delimited JSON-RPC; tracks pending requests with timeouts, mirrors stderr to the
  server logs, gracefully shuts down via SIGTERM → 5 s grace → SIGKILL, fails in-flight
  calls when the child exits unexpectedly); **`runSecretsPlugin(plugin)`** (plugin-author
  side — a tiny stdio loop the plugin author drops into their bin entry to turn any
  in-process `SecretsPlugin` into a stdio server, exported at `@arc/plugin-sdk/runtime`
  so it isn't pulled by host-only consumers). arc-server gains
  `PluginsService.mountRemoteSecretsPlugin(spec, mountPath, config)` mirroring the
  in-process API; `unmount(name)` now also closes the child cleanly via `RemoteSecretsPlugin.close()`.
  The transport boundary is real: the child sees **only the env vars the spec lists**, has
  no access to arc-server's heap or open FDs beyond stdio, and is process-bound to its
  child lifetime. **10 new tests** (7 in
  `@arc/plugin-sdk` driving a real Node child through the runtime: meta handshake;
  configure → issue → revoke; error propagation as `RemotePluginError`; in-flight call
  fails when child exits; idempotent `close()`; spawn-without-handshake rejected; runtime
  dist exists; plus 3 in arc-server: spawn + mount + dispatch `creds/<role>` + renew + clean
  unmount; unspawnable plugin → BadRequest with the spawn error; configure() throws → host
  rolls back the child). Workspace stays 70/70 turbo green; arc-server 128 tests / 24
  suites; `@arc/plugin-sdk` 14 tests.
- [x] **WASM/wasmtime plugin backend** — ADR-004. Adds `buildWasmtimeSpec` to
  `@arc/plugin-sdk` and `PluginsService.mountWasmSecretsPlugin` to arc-server. Reuses the
  JSON-RPC-over-stdio transport from the OOP host above verbatim — the plugin author
  writes the same `SecretsPlugin`; they just compile it to a **WASI preview-1 command**
  instead of a Node script. wasmtime is shelled out to under a **deny-by-default profile**:
  `--env-inherit=none --dir=none --tcplisten=none`, with each `env: { K: V }` threaded as
  `--env=K=V` and each `dirs` entry threaded as `--dir=H=G[:rw]` so the plugin only sees
  what the operator explicitly grants. Deliberately **not** in-process WASM (Node's
  `node:wasi`) — that runs in the Node heap and would defeat the isolation point;
  wasmtime is the production-grade Bytecode Alliance sandbox and ships a persistent stdio
  process model that fits the existing transport. Operator action: install wasmtime in
  the deployment image (or pin `wasmtimePath`). 7 new tests: 6 unit tests on the spec
  builder (deny-by-default flags pinned, env / dir pass-through, wasmtime path override,
  argv after `--`, RPC timeout propagation); 1 arc-server spec verifying the
  "wasmtime not installed" path surfaces as a BadRequest carrying the spawn error (same
  flow as any other unspawnable process plugin, no half-mounted state leak). Full ADR:
  `docs/arc-rfcs/ADR-004-wasm-plugin-backend.md`.
- [x] `arc-plugin-azure` — Azure AD service-principal access tokens via the v2.0
  client_credentials grant. Mirrors the AWS / GCP / GitHub layout: core plugin + optional
  `@arc/plugin-azure/node` default client using `fetch` only (no external deps). Form-encoded
  request body per RFC 6749. Config: `adminToken` (not applicable here — replaced by
  per-role `clientSecret`) + roles map of `{tenantId, clientId, clientSecret, scope,
  maxTtlSeconds?}`. `issue` returns `{access_token, tenant_id, client_id, scope}` + AAD's
  `expires_in` as the lease TTL (clamped to `role.maxTtlSeconds` if set). `renew` throws;
  `revoke` is a no-op at AAD (no per-token revoke API — application-level via SP secret
  rotation) + drops local tracking. Sovereign-cloud `loginUrl` override supported. 13
  unit tests cover configure / issue / renew / revoke + the TTL clamp + sovereign-cloud
  override. 2 server integration specs through `PluginsService` + `EnginesService`.
- [x] `arc-plugin-gitlab` — GitLab project access tokens via the REST API. Admin PAT in
  `adminToken`, roles map of `{projectId, scopes[], accessLevel (10|20|30|40|50),
  expiresAt?, namePrefix?}`. `issue` POSTs `/projects/:id/access_tokens`, returns the
  bearer + computed `expirationSeconds` as the lease TTL. Default expires_at is 30 days
  out; role can override with explicit ISO date. `revoke` actually DELETEs at GitLab —
  unlike GitHub installation tokens we have the tokenId from the create response, so a
  cheap revoke round-trip is fine here. `renew` throws (rotate-by-recreate). 13 unit
  tests + 2 server integration specs.
- [x] `arc-plugin-bitbucket` — Bitbucket Cloud repository access tokens via the REST API.
  Admin token in `adminToken`, roles map of `{workspace, repoSlug, scopes[], namePrefix?,
  ttlSeconds?}`. Bitbucket tokens have **no native expiry** so the plugin records a
  configurable `ttlSeconds` (default 7 days) as the lease TTL. `revoke` DELETEs at
  Bitbucket via the stored uuid; `renew` throws. 9 unit tests + 2 server integration
  specs.
- Cross-plugin "six together" integration spec confirms all six vendors (AWS / GCP /
  GitHub / Azure / GitLab / Bitbucket) co-mount on the same `MountRegistry` and dispatch
  independently. **Workspace total: 364 tests passing.**
- [x] Auth plugins: `arc-plugin-oidc` + `arc-plugin-kubernetes` — completes the plugin
  target matrix (cloud + scm + auth). Both implement `@arc/plugin-sdk`'s `AuthPlugin`
  contract (`configure` + `login(req) → {identityId, policies, tokenTtlSeconds, …}`) with an
  injectable verifier/reviewer at construction so the core is hermetic; each ships a default
  Node-builtin-only client behind a `/node` subpath. **OIDC** (`plugins/auth/arc-plugin-oidc`)
  verifies a caller-presented JWT against the issuer's JWKS — `createOidcJwtVerifier` does OIDC
  discovery (`/.well-known/openid-configuration` → `jwks_uri`, cached) + RS256/384/512 &
  ES256/384/512 signature verification via `node:crypto` (`createPublicKey({format:"jwk"})`,
  IEEE-P1363 for ECDSA) + iss/aud/exp/nbf checks — then enforces the role's `boundAudiences` +
  `boundClaims` and maps to policies; policies come from the role, never the token, so a token
  can't self-escalate. 19 tests incl. real RSA/EC signed JWTs (tamper/wrong-key/expiry/issuer/
  audience/kid + JWKS caching). **Kubernetes** (`plugins/auth/arc-plugin-kubernetes`) delegates
  authentication to the cluster TokenReview API (`createNodeTokenReviewer` POSTs
  `authentication.k8s.io/v1/tokenreviews` over fetch), parses the
  `system:serviceaccount:<ns>:<name>` identity, and enforces the role's bound namespaces +
  service-account names (with `*` wildcards). 11 tests. **arc-server wiring:** new
  `AuthMethodsModule` (`apps/arc-server/src/auth-methods/`) — `AuthMethodsService` holds its own
  `PluginHost` for auth methods (deliberately free of `EnginesModule`) and
  `AuthMethodsController` serves `POST /v1/auth/<mount>/login`: resolve the method → `login()` →
  attach the resolved policies to the identity in the grants store → mint an arc JWT
  (`sub=identityId`). The module is registered **before** `EnginesModule` in `app.module` so its
  login route is matched ahead of the engines `/v1/*` catch-all. 5 e2e tests boot the real app,
  mount both methods with fake verifier/reviewer, and prove login → token → policy-bound access
  (covered path authorized, uncovered path 403) + 401 on unverifiable token / unknown role + 404
  on an unmounted method. Workspace total climbs accordingly (OIDC 19 + k8s 11 + 5 server e2e).
- [x] `@arc/mcp-server` — arc exposed over the **Model Context Protocol**. New workspace at
  `integrations/arc-mcp-server`: a stateless Node HTTP service that wraps arc-server's
  Engine-A surface (KV v2, Transit, dynamic credentials, sys/mounts) as MCP tools so any
  MCP-capable agent can use arc. Built on the official `@modelcontextprotocol/sdk`
  (Streamable HTTP transport, JSON response mode). Architecture: every `POST /mcp` request
  extracts `Authorization: Bearer <arc-jwt>`, builds a fresh `Server` instance bound to that
  bearer, and dispatches via a tiny ArcClient that forwards the bearer verbatim to the
  arc-server REST API. **arc-mcp-server is not the policy decision point** — `JwtAuthGuard`
  + `CapabilityGuard` (against `@arc/grants`) gate every call on the arc-server side, and a
  403 surfaces back as a structured `isError: true` tool result, not a JSON-RPC fault. Seven
  tools: `arc_kv_get` / `arc_kv_put` / `arc_kv_list` / `arc_transit_encrypt` /
  `arc_transit_decrypt` / `arc_dynamic_creds_issue` / `arc_list_mounts`. **Engine B is
  deliberately not exposed** — the E2E vault is zero-knowledge; surfacing it over MCP would
  break that property. 16 unit tests on the tool handlers (fake fetch, wire-shape asserts:
  default mount, cas envelope, ?list=true, ?version=N, ?ttl=N, base64 context threading,
  bearer forwarding, 403 → structured error) + 3 integration tests that boot the real HTTP
  server on a random port and drive it with the MCP SDK's `Client` over Streamable HTTP —
  initialize handshake, `tools/list` returns the seven tools, `tools/call(arc_kv_get)`
  round-trips through a fake arc-server, and unauthenticated requests get 401 with
  `WWW-Authenticate: Bearer`. Authentication for agents: `POST /v1/auth/oidc/login` (or
  `/v1/auth/kubernetes/login`) returns the arc JWT, agent connects with that as the bearer.
  Ships a `bin/arc-mcp-server` CLI configured via `ARC_SERVER_URL` / `PORT` / `HOST` env
  vars + a `GET /healthz` liveness route + SIGTERM/SIGINT graceful drain. ESM-only build via
  tsup. Tests live + green; workspace total 67 tasks all green.

### Phase 4 — deployment + ops

- [x] Helm chart for the ops trio (operator + agent + mcp-server). Extends
  `infra/arc-helm-charts/arc` (now chart v0.2.0) with three opt-in, off-by-default surfaces:
  **`operator.enabled`** ships the operator Deployment + ServiceAccount + ClusterRole/Binding
  (secrets get/list/create/update/patch; arcsecrets/arcdynamiccredentials get/list/watch +
  their /status patch — no wildcards) and vendors the two CRDs into the chart's `crds/`
  directory (Helm installs them; a smoke test asserts they stay byte-identical to
  `apps/arc-operator/crds`, so they can't drift). **`mcpServer.enabled`** ships the MCP
  Deployment + Service on :8800 with a `/healthz` liveness/readiness probe and no cluster
  RBAC (it only talks to arc-server). **`agent.sampleConfig.enabled`** ships a starter
  ConfigMap (the agent runs as an init+sidecar in the user's own pods, so the chart can't own
  its Deployment). Operator + mcp-server auto-wire `ARC_SERVER_URL` to the in-chart server
  Service via a new `arc.server.internalUrl` helper, so a single-chart install needs no extra
  config. NOTES.txt surfaces each enabled component. Validated with real `helm lint` +
  `helm template --include-crds` (all components on → clean render; all off → zero ops
  resources leak). Smoke tests grew 13 → 24 (new-file presence, operator-RBAC verb scoping,
  values shape, CRD drift). `helm lint` + `helm template` already run in CI on every PR.
- [x] `arc-agent`: Rust workload sidecar — pairs with `arc-operator` as the two
  "deliver secrets to workloads" surfaces (operator = cluster-wide CRDs into K8s Secrets;
  agent = direct in-pod templating into config files). Lives in `crates/arc-agent` as a
  standalone Rust crate (matches the existing `vault-crypto-rs`/`desktop-core` pattern; no
  Cargo workspace yet). YAML config (`src/config.rs`) describes auth + sinks; each sink has
  a source (`kv_get` or `dynamic_creds`), a template file, an output path, an octal mode,
  a refresh policy, and an optional `on_change` (exec a command or signal a PID). Two run
  modes — `arc-agent run --once` for init containers (fetch + render + exit), `arc-agent
  run` for sidecars (stay running, refresh before lease expiry). Auth via the Kubernetes
  auth plugin shipped in #7 (same login flow as `arc-operator`). HTTP client handles JWT
  cache + refresh-ahead (60s) + one re-login on 401; 403 propagates immediately. Templates
  use Tera (Jinja-style); autoescape is **off** (config files, not HTML), missing dotted
  fields error so operator typos fail loudly. Sink writes are atomic (`.tmp` + `rename`),
  with the configured mode (default 0600). The cached JWT lives in a `CachedJwt` wrapper
  that zeroizes on `Drop`. Runner schedules sinks independently — one failing sink can't
  block the others; per-sink errors are tracing-logged and rescheduled with a 15s
  backoff. Tests (10) across config parse/validate, template rendering (dotenv +
  dynamic-cred + lease metadata + missing-field error), and live HTTP integration via
  `wiremock` (login → KV render with correct mode; dynamic-cred issue + render; 403 → error
  with no file written). Ships a Dockerfile (rust:slim build → debian:slim runtime with
  just `ca-certificates`, non-root user); ~14 MB release binary. Helm chart integration
  (template a Pod with `arc-agent` as an initContainer + sidecar) is a follow-up PR.
- [x] `arc-operator`: Kubernetes operator that declaratively delivers arc secrets to
  workloads. Lives in `apps/arc-operator` (TypeScript — keeps the monorepo on one language;
  the control loop is small enough that `controller-runtime`/`kubebuilder` would be
  overkill). Two CRDs under `arc.io/v1alpha1`: **`ArcSecret`** syncs a KV v2 secret into a
  K8s Secret (with optional `{{ .field }}` template projection); **`ArcDynamicCredential`**
  issues a short-lived dynamic credential (AWS STS / GCP IAM / GitHub App / GitLab /
  Bitbucket / Azure AD / database) and re-issues it before its lease expires, best-effort
  revoking the previous lease on rotation. CRDs ship under `crds/` with `openAPIV3Schema`
  validation + `status` subresources + printer columns. The operator's pod authenticates
  via the **K8s auth plugin** shipped in #7 (`POST /v1/auth/kubernetes/login` with its own
  ServiceAccount token); the returned arc JWT is what every subsequent call carries.
  `JwtAuthGuard` + `CapabilityGuard` (`@arc/grants`) are the only policy decision points —
  the operator never makes authorization decisions locally. Reconcile strategy: polling
  (every `POLL_INTERVAL_SECONDS`, list both CR kinds, reconcile each), not informers —
  simpler, deterministic, fine for secret-injection. OwnerReferences make `kubectl delete
  arcsecret X` garbage-collect the Secret. Status conditions surface
  `Synced=True|False`/`Ready=True|False` with reason + message + lastTransitionTime so
  `kubectl describe` shows operator health. ArcClient handles login + JWT refresh-ahead +
  401-retry-once (token revoked server-side); 403 propagates immediately (policy denial is
  permanent). 23 tests: reconcilers (verbatim copy, template projection,
  missing-field-rejected, lease re-issue + revoke, no-op when lease fresh, error → status),
  ArcClient (SA-token login, JWT caching + refresh window, 401-retry, 403-no-retry),
  template engine (rendering, whitespace tolerance, null/undefined → empty, missing-field
  throw), poll loop (per-iteration progress, fault isolation per CR, clean stop). Ships an
  ESM-only build via tsup + a Dockerfile (multi-stage, non-root, `pnpm deploy --legacy`
  bundle, CRDs at `/app/crds`) so it can be deployed alongside arc-server. Helm chart
  template + RBAC manifests follow in a separate PR.
- [x] `arc-helm-charts`. New `infra/arc-helm-charts/arc` Helm chart deploys arc-server
  (Deployment + Service + Secret) with co-located OpenBao (StatefulSet + Service, dev mode
  by default — production deployments flip `openbao.devMode=false` and supply a real
  config/seal). Optional `Ingress` (`networking.k8s.io/v1`) and `ServiceMonitor`
  (`monitoring.coreos.com/v1`) that scrapes the `/metrics` endpoint from the
  observability commit. Production knobs: `arcServer.secret.existingSecret` for External
  Secrets / SealedSecrets integration, `OTEL_EXPORTER_OTLP_ENDPOINT` for tracing,
  `ARC_DEFAULT_POLICY=deny` + `ARC_ROOT_USERS` for the fail-closed posture. 13 vitest
  smoke tests (`infra/arc-helm-charts/arc/tests/chart.test.ts`) parse Chart.yaml +
  values.yaml + every template YAML, walk the values tree, and assert every
  `.Values.<key>` reference in the templates resolves to a real key — catches typos
  without needing `helm` installed locally. `helm lint` + `helm template` will run in CI
  in the next commit.
- [x] `arc-terraform`: IaC module wrapping the chart for `terraform`-driven
  installs. New `infra/arc-terraform/modules/arc` declares the providers
  (`hashicorp/helm` ~> 3.0, `hashicorp/kubernetes` ~> 3.0 — the v3 majors,
  so the example uses helm v3's `kubernetes = {}` attribute syntax and the
  `kubernetes_namespace_v1` resource), creates the
  namespace (gated on `create_namespace`), and renders a `helm_release` whose
  `values` block is a 1:1 typed mapping of the chart's `values.yaml`
  (`arc_server` → `arcServer`, `openbao` → `openbao`, etc.). Mirrors the same
  production knobs as the chart: `arc_server.secret.existing_secret`,
  `arc_server.env.OTEL_EXPORTER_OTLP_ENDPOINT`, `openbao.dev_mode`,
  `openbao.persistence`, `service_monitor.enabled`. `extra_values` escape
  hatch merges raw HCL on top so any chart key the typed surface doesn't
  expose yet can still be set. `outputs.tf` exposes the cluster-internal
  Service DNS for both arc-server and the colocated OpenBao. A reference
  example at `examples/dev/main.tf` wires the in-repo chart path for kind/k3d
  loops. 14 vitest smoke tests (`infra/arc-terraform/tests/module.test.ts`)
  scan every `.tf` file, assert the required `variable` / `output` /
  `resource` declarations exist, and cross-check that every chart key the
  module writes (`arcServer.replicaCount`, `openbao.devMode`, etc.) actually
  exists in `infra/arc-helm-charts/arc/values.yaml` — so the two stay in
  lockstep without needing `terraform` installed. `terraform fmt -check` +
  `terraform validate` will run in CI in the next commit.
- [x] GitHub Actions CI: build + typecheck + test + parity test, plus three
  newly added jobs — `openbao-adapter`, `helm`, `terraform`. The
  `openbao-adapter` job stands up the upstream `quay.io/openbao/openbao`
  image as a GitHub Actions service container (matching the
  `integrations/arc-openbao-adapter/docker-compose.yml` config) and exports
  `BAO_ADDR=http://127.0.0.1:8200` so the existing
  `tests/integration.test.ts` `skipIf(!BAO_ADDR)` suite runs against a
  real OpenBao instead of being skipped — no extra runner cost, the
  service container is part of the standard GH runner. The `helm` job
  installs `helm` v3.16.3 via `azure/setup-helm@v4`, runs `helm lint`,
  then `helm template` twice (default values + a production-ish override
  with the secret keys, OTLP endpoint, devMode=false, persistence,
  Ingress, and ServiceMonitor flipped on) and pipes the output through
  `yaml.safe_load_all` to assert the rendered documents parse and have
  the expected `kind`s. The `terraform` job installs `terraform` v1.9.8
  via `hashicorp/setup-terraform@v3`, runs `terraform fmt -check
  -recursive`, then `terraform init -backend=false` + `terraform
  validate` against both `modules/arc/` and `examples/dev/`. Together
  with the existing vitest smoke suites this gives both a "fast feedback
  for contributors without docker / helm / terraform installed" path and
  a "real binary" path that catches Go-template + HCL bugs the parsers
  can't see.
- [x] Release pipeline + SBOM + signed artifacts. New
  `apps/arc-server/Dockerfile` — multi-stage: stage 1 installs the whole
  pnpm workspace, builds arc-server + its `@arc/*` deps, then
  `pnpm --filter @arc/server deploy --prod --legacy /app` carves out a
  self-contained, production-only tree (the `--legacy` flag is pnpm v10's
  requirement for non-injected workspaces); stage 2 copies just that tree
  onto a slim non-root `node:22-bookworm-slim` runtime that runs
  `node dist/main.js` with a `/metrics` HEALTHCHECK. `.dockerignore` keeps
  node_modules / build caches out of the context. `.github/workflows/release.yml`
  (tag-triggered `v*` + manual dispatch) logs into GHCR, builds + pushes
  `ghcr.io/ethchor/arc-server` (the image the helm chart + terraform
  already reference) with BuildKit SLSA provenance + SPDX SBOM
  attestations, then **cosign keyless-signs** the digest (OIDC, no
  long-lived keys), generates a standalone SPDX SBOM via syft
  (`anchore/sbom-action`), `cosign attest`s it, and uploads it as a run
  artifact — plus a job summary with the `cosign verify` incantation. A
  new `docker-build` CI job builds the image on **every PR** (no push) and
  boots it to assert `/metrics` serves, so the Dockerfile can't rot
  between releases. 16 structural vitest checks in the new `@arc/release`
  package lock the Dockerfile + both workflows against drift (multi-stage,
  non-root, deploy --legacy, tag trigger, packages/id-token permissions,
  cosign + SBOM steps) without needing docker/cosign installed — and
  assert the build-time TLS bypass the sandbox needs never reaches the
  committed image. Verified locally that `pnpm deploy --prod --legacy`
  produces a self-contained bundle that boots the full NestJS app (every
  module initializes); the end-to-end image build is exercised by the
  `docker-build` CI job on every PR (the sandbox's TLS-intercepting proxy
  breaks corepack inside `docker build`, so it can't complete here without
  a throwaway bypass that must never ship in the image).
- [x] OpenTelemetry traces + Prometheus metrics in `arc-server`. New
  `apps/arc-server/src/observability/` module: `MetricsService` owns a single
  `prom-client` registry pre-loaded with the Node + process defaults
  (`arc_process_*`, `arc_nodejs_*`) and six arc-specific metric families —
  `arc_vault_operations_total`, `arc_leases_total {engine,op}`,
  `arc_acl_decisions_total {decision,reason}`, `arc_plugin_issue_total
  {plugin,role,result}`, `arc_http_request_duration_seconds {method,route,status}`
  histogram, `arc_active_leases {engine}` gauge. `MetricsController` at `/metrics`
  serves the 0.0.4 exposition format (un-guarded — network-layer auth is the
  expected control); samples the LeaseManager just before each render so the
  active-leases gauge is point-in-time current and won't hold stale labels.
  `HttpMetricsInterceptor` wired as `APP_INTERCEPTOR` records the histogram on
  every request using the matched Express route (low cardinality, no
  per-`:id` blowup). `CapabilityGuard` increments `arc_acl_decisions_total` with
  the `PolicyEngine`'s detailed reason; `EnginesService` increments
  `arc_leases_total {issue,renew,revoke}` + `arc_plugin_issue_total` —
  `MetricsService` injected via `@Optional()` so existing unit harnesses don't
  need a stub. OTel SDK gated on `OTEL_EXPORTER_OTLP_ENDPOINT`:
  `setupTelemetry()` from `main.ts` runs before `NestFactory.create` so
  auto-instrumentations (HTTP, Express, pg, sqlite, pino) wrap their targets
  in time. SIGTERM/SIGINT drain spans via `shutdownTelemetry()` so a deploy
  doesn't lose the last few seconds of traces. 5 new e2e tests
  (`observability.e2e-spec.ts`) confirm the exposition format, route-pattern
  cardinality on the histogram, ACL counter on allow path, gauge HELP/TYPE at
  zero, and unauthenticated scrape semantics. arc-server now 17 suites / 96
  tests passing.
- [x] `sdks/arc-js-sdk` npm publish prep. `@arc/sdk` is now a publishable, **self-contained**
  package: a tsup config bundles the workspace crypto (`@arc/crypto` + the type-only
  `@arc/types`, including `dts.resolve` so the emitted `.d.ts` carries the inlined types) and
  keeps the audited `@noble/*` libs as visible runtime `dependencies` — so an external
  consumer gets zero unresolved `workspace:*` imports. Dual ESM + CJS + sourcemaps + types.
  package.json gained the publish surface (`version 0.1.0`, `exports` map, `files`,
  `sideEffects:false`, `repository`/`homepage`/`bugs`, `keywords`, `engines`,
  `publishConfig:{access:public, provenance:true}`, `prepublishOnly`). New
  `.github/workflows/publish-sdk.yml` (manual `workflow_dispatch` with a dry-run default, or a
  `sdk-v*` tag) builds + verifies the dist is self-contained + `pnpm pack` + publishes with
  npm provenance — gated behind an `NPM_TOKEN` secret. Two deliberate pre-publish blockers the
  workflow enforces: a `LICENSE` file must exist (repo license is still TBD) and the version
  must not be `0.0.0`. Jest is unaffected (its moduleNameMapper points `@arc/sdk` at source,
  not the dist). The npm scope (`@arc`) is documented in the SDK README as the one thing to
  confirm/rename before the first real publish.
- [x] `sdks/arc-go-sdk` scaffold. New standard-library-only Go client for Engine-A:
  `go.mod` (module `github.com/ethchor/arc/sdks/arc-go-sdk`), `arc.go` with a `Client`
  (`New` + `WithToken`/`WithHTTPClient` options), `LoginKubernetes`, `KVGet`, `KVPut`,
  `IssueDynamic`, `RevokeLease` — mirrors the operator/agent surface: caches the arc JWT,
  forwards it as the bearer, retries once on 401, returns a typed `*APIError` on non-2xx
  (403 without retry). Engine-B is intentionally not exposed (zero-knowledge client crypto
  lives in the TS SDK). 5 `httptest`-backed tests (login caches+forwards the bearer, KV
  version query, dynamic-cred ttl+shape, 401-retry-once-then-succeed, 403→APIError-no-retry).
  A new `go` CI job (`actions/setup-go@v5`, go 1.23) runs build + vet + test on every PR.

### Open product questions

- ~~[?] Web: should the master-password recovery flow live in the unlock screen or as a
  separate route?~~ → resolved (ADR-006): a **dedicated `RecoverScreen`** reached from a
  low-emphasis "Forgot your master password?" link on the unlock screen. Recovery is a rare,
  high-stakes, multi-step break-glass flow, so it gets its own screen rather than cluttering
  the per-session unlock hot path. Built the flow end-to-end (it didn't fully exist before):
  `@arc/crypto` `recover()` (re-wraps the recovered identity + signing keys under a new
  password + new recovery key, **no public-key change**), additive `encSigningPrivRecovery`
  so the signing key is recoverable too, `POST /vault/keyset/recover` that **pins every
  public key** (anti-takeover — a session-holder without the recovery key can't swap the
  identity), SDK `recoverWithKey`, migration `1718200000000`. **10 tests** (4 crypto
  round-trip / rotation / refusal, 3 e2e restore-access + key-rotation + 400-on-pubkey-mismatch,
  + the existing recoverIdentityPriv coverage). ADR-006 Accepted.
- ~~[?] TOTP: support `otpauth://` URI import (most clients export this format)?~~ → yes,
  shipped in this batch (TotpDialog auto-detects on paste).
- ~~[?] Secure notes: do they need rich text or is plaintext-with-newlines fine for v1?~~ →
  resolved (#20): `NoteItem.format?: "plaintext" | "markdown"` opt-in render hint, missing
  ≡ plaintext for back-compat. Server stays zero-knowledge — `format` rides inside the
  encrypted payload, never a server-visible column.
- ~~[?] Per-vault icons / colours — Bitwarden parity feature; currently no UI surface.~~ →
  resolved (#20): `VAULT_ICONS` + `VAULT_COLORS` allowlists in `@arc/types`, nullable
  `vaults.icon` / `.color` columns, `PATCH /vaults/:id/ui`, SDK `updateVaultUi`. UI surface
  still to do (covered alongside the NHI inventory groundwork in #28).
- ~~[?] Item-level sharing (one item to one user, not whole vault) — Bitwarden has this;
  not in our model yet. Big design call.~~ → resolved (**ADR-007**): a share is the item's
  IK `pqSeal`-wrapped to the recipient's hybrid identity + a ciphertext snapshot of the
  shared version. Recipients get cryptographic access to **exactly one item**, never become
  vault members, never receive the VK. No new crypto — reuses `pqSeal` (ADR-002). v1 is
  view-only with snapshot semantics (an edit rotates the IK; the granter re-shares to push
  the new version — clean forward secrecy on edits, snapshot keeps working for the shared
  version). New `vault_item_shares` table (unique on `(itemId, granteeUserId)`, so re-sharing
  upserts) + migration `1718300000000`; server endpoints `POST
  /vaults/:id/items/:itemId/share`, `GET /vault/shares/{incoming,outgoing}`, `DELETE
  /vault/shares/:id` (granter *or* grantee can revoke); `requireRole("viewer")` on the
  source vault means non-members get a 404 (member-existence hidden) and a recipient can't
  re-share. SDK: `shareItem` (derives the IK from the local VK, looks up the recipient's
  identity, wraps + uploads), `listIncomingShares`/`listOutgoingShares`/`decryptIncomingShare`/
  `revokeShare`. **5 e2e** through the real server + SDK: share decrypts byte-identical
  on the recipient + recipient has no membership; snapshot survives edits; re-share upserts
  to the new version; granter + grantee both revoke; non-member can't share; recipient
  can't re-share. Edit-shares (recipient writes back) and TTL'd shares are documented as
  follow-ups in ADR-007.
- ~~[?] Hardware-key (FIDO2 resident credential) as a primary unlock path on the
  extension. Different from passkey-prf; would let the extension run unlocked across
  browser restarts.~~ → resolved (**ADR-008**) — accepted residency, rejected "survives
  browser restarts." The proposal mixed (a) discoverable credentials, a real UX win at zero
  cost, with (b) caching a long-lived KEK in extension storage so the extension comes back
  pre-unlocked. The KEK-in-storage path walks back the zero-knowledge posture (filesystem
  read of the profile dir = vault), so we don't ship it. What we *did* ship:
  registration now uses `residentKey: "required"` (every new passkey is discoverable),
  plus two unauthenticated endpoints (`POST /vault/passkey/discover-{challenge,unlock}`)
  that resolve the user from the assertion's `userHandle` and mint a session token — no
  email on the wire. SDK: `signInWithDiscoverablePasskey` + `signInAndUnlockWithPasskey`
  (sign in via discoverable creds, then PRF unwrap; on supported browsers the two prompts
  coalesce). Extension popup is **passkey-first** — primary button is *Unlock with passkey*,
  master-password collapsed behind *Use master password instead*. Net UX: **two biometric
  taps + zero typing** on first cold launch (vs. email + password + click); future "survives
  restarts" work belongs in a separately-running desktop helper (Tauri wrap), not the
  extension service worker — flagged in ADR-008. **6 e2e** through the real Nest app +
  ES256 FakeAuthenticator: discoverable sign-in returns the right user; full sign-in +
  PRF-unlock reads a pre-existing item byte-identical; anti-replay (unknown challenge),
  missing `userHandle`, unknown `userHandle`, and the `residentKey: required` option flag
  all asserted. Workspace 70/70 turbo green; server 36 suites, 183 passed.

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
