# arc — Monorepo Architecture Plan

## arc Platform Repository (monorepo root: `arc/`)

-----

## 0. Product Vision

**arc = OpenBao + Bitwarden, unified into one self-hostable platform.**

Two engines under one roof, one identity, one audit trail, one UI:

- **Engine A — Infrastructure Secrets** (the HashiCorp Vault use case): dynamic secrets,
  PKI/certificate issuance, KV engines, Kubernetes auth, secret leasing & revocation,
  encryption-as-a-service. Backed by **OpenBao**.
- **Engine B — End-to-End Encrypted Vault** (the 1Password / Bitwarden use case): passwords,
  passkeys, TOTP, secure notes, secure sharing — zero-knowledge, client-side encryption.
  Built on the **Bitwarden crypto model** (reimplemented, not copied).

-----

## 1. CRITICAL — Licensing & Upstream References

### HashiCorp Vault: READ to learn, do NOT copy

In August 2023 HashiCorp relicensed Vault from MPL 2.0 to the **Business Source License
(BSL 1.1)**. BSL is "source-available," NOT open source: it permits use and modification but
**prohibits offering the software as a service that competes with HashiCorp's commercial
offerings**. arc is exactly such a competing service. Using Vault BSL code = violation.
(Each BSL release auto-converts to MPL 2.0 four years after publication, but current Vault is off-limits.)

**You MAY** read Vault's repo (<https://github.com/hashicorp/vault>) and docs to understand
concepts, feature behavior, and API surface. **You MAY NOT** copy, port, or closely translate
its BSL source into arc — reading-then-rewriting is a derivation risk, not a clean room.
SAFE PATTERN: learn intent from Vault, implement against **OpenBao (MPL 2.0)** as your
reference code.

### What you CAN build on

| Need | Project | License | Repo | Notes |
|------|---------|---------|------|-------|
| Infra secrets engine | **OpenBao** | MPL 2.0 | <https://github.com/openbao/openbao> | Community fork of Vault 1.14 (last MPL version), Linux Foundation governed. Vault-API compatible. Commercial use OK. |
| Infra engine site/docs | OpenBao | — | <https://openbao.org/> | Docs, API reference. |
| E2E vault server (reference) | **Vaultwarden** | AGPL-3.0 | <https://github.com/dani-garcia/vaultwarden> | Rust reimpl of Bitwarden server. STUDY only — AGPL network copyleft. Do not vendor. |
| E2E vault clients + crypto model | **Bitwarden** | GPL/AGPL + SDK terms | <https://github.com/bitwarden> | Reimplement the crypto model; do not copy code. Open spec at <https://bitwarden.com/open-source/> |

**License posture:**

- **OpenBao (MPL 2.0)** — weak copyleft. Modifications to MPL-licensed files must stay MPL,
  but you may combine with proprietary arc code. SAFE to build on and ship commercially.
- **Vaultwarden (AGPL-3.0)** — strong copyleft + network clause. If you link or derive,
  your whole service may be forced to AGPL. PREFER: study the architecture, reimplement the
  Bitwarden-compatible crypto in `arc-crypto`. No direct reuse without legal sign-off.
- **Bitwarden crypto model** — publicly documented: AES-256 + PBKDF2/Argon2id key derivation,
  client-side master-key derivation, server stores only ciphertext (zero-knowledge).
  REIMPLEMENT from the spec.

Any time an agent is unsure whether something crosses a license boundary, STOP and write an
ADR in `docs/arc-rfcs/`.

-----

## 2. Monorepo Structure (Full)

```
arc-vault/
├── packages/                       # Internal shared libraries
│   ├── arc-types/                  # Source of truth for all TS types/schemas
│   ├── arc-crypto/                 # E2E crypto (Bitwarden model), key derivation
│   ├── arc-identity/               # Identity schemas, DID, profiles
│   ├── arc-protocols/              # Wire formats, sync protocol
│   ├── arc-auth/                   # Auth flows, sessions, tokens
│   ├── arc-audit/                  # Audit log interfaces + emitters
│   ├── arc-events/                 # Event bus contracts
│   ├── arc-grants/                 # ACL / policy model (Vault-style policies)
│   ├── arc-secrets-engine/         # KV + dynamic-secret engine abstraction
│   ├── arc-leasing/                # Lease + revocation lifecycle (TTLs)
│   └── arc-plugin-sdk/             # Plugin contracts + host runtime
│
├── apps/                           # User-facing products
│   ├── arc-vault-web/              # React web app (consumer + admin)
│   ├── arc-vault-desktop/          # Tauri desktop app
│   ├── arc-browser-extension/      # Autofill browser extension
│   ├── arc-cli/                    # CLI (bao/vault-style ergonomics)
│   └── arc-server/                 # Backend control plane (unifies both engines)
│
├── sdks/
│   ├── arc-js-sdk/
│   └── arc-go-sdk/
│
├── integrations/
│   └── arc-openbao-adapter/        # Adapter to embedded/colocated OpenBao
│
├── infra/
│   ├── arc-helm-charts/
│   ├── arc-terraform/
│   └── arc-operator/               # K8s operator (secret injection)
│
├── docs/
│   ├── arc-rfcs/                   # RFCs + ADRs (incl. license ADRs)
│   └── arc-architecture/           # OpenAPI specs, diagrams, CURRENT_TASK.md
│
├── CLAUDE.md
├── MONOREPO_PLAN.md
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

-----

## 3. The Two Engines — How They Fit

### Engine A — Infrastructure Secrets (OpenBao-backed)

Components: `arc-secrets-engine`, `arc-leasing`, `arc-openbao-adapter`, `arc-operator`

**Approach (recommended for Phase 1): Adapter, not reimplementation.**

- Embed or colocate an OpenBao server.
- Drive it through its Vault-compatible HTTP API from `arc-openbao-adapter`.
- `arc-secrets-engine` defines arc's clean interface; the adapter implements it against OpenBao.
- This gets you dynamic secrets, PKI, KV v2, K8s auth, auto-unseal "for free" and MPL-safe.

Local dev: run OpenBao in dev mode (Docker) and point the adapter at it.

```
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root \
  quay.io/openbao/openbao:latest server -dev
export BAO_ADDR="http://127.0.0.1:8200"
export BAO_TOKEN="root"
```

### Engine B — E2E Personal/Team Vault (Bitwarden model)

Components: `arc-crypto`, `arc-vault-web`, `arc-browser-extension`, parts of `arc-server`

**Zero-knowledge design (reimplement from spec):**

- Master password → key derivation (Argon2id preferred, PBKDF2 fallback) — client-side only.
- Derive a master key, then a stretched key; protect a random symmetric key (the "vault key").
- All vault items encrypted client-side with the vault key. Server stores ciphertext only.
- Server never sees plaintext or master password. No server-side recovery.

`arc-server` is the unifying control plane: single identity, single auth, single audit log,
single admin UI spanning both engines.

-----

## 3b. Plugin System (parity with Vault's ecosystem)

arc must integrate with major **cloud platforms, source-control systems, databases, and auth
backends** — the same surface area Vault covers via secret engines + auth methods. Delivered
through a first-party plugin system. Use OpenBao's plugin/engine model as the reference
implementation; use Vault docs to understand intended behavior (never copy Vault code).

### packages/arc-plugin-sdk — the contracts

```ts
// SecretsPlugin: dynamic credential generation + revocation (Vault "secret engine")
interface SecretsPlugin {
  meta: PluginMeta;
  configure(input: unknown): Promise<void>;         // validated against plugin's Zod schema
  issue(req: IssueRequest): Promise<IssuedSecret>;  // mint scoped, leased credential
  renew(leaseId: string): Promise<LeaseInfo>;
  revoke(leaseId: string): Promise<void>;
}

// AuthPlugin: authenticate caller against external IdP -> arc identity + policy (Vault "auth method")
interface AuthPlugin {
  meta: PluginMeta;
  configure(input: unknown): Promise<void>;
  login(req: LoginRequest): Promise<AuthResult>;    // returns identity + granted policies + token TTL
}

// StoragePlugin (optional, later): pluggable backend storage
interface StoragePlugin { /* get/put/list/delete */ }
```

### Lifecycle

discover → register → configure → mount(path) → handle requests → lease/renew/revoke.

### Isolation & security

- Plugins run as isolated processes (or sandboxed modules) loaded by the `arc-server` plugin host.
- Plugins NEVER receive the E2E master key. They get only scoped capabilities + their own config.
- All plugin actions flow through `arc-audit`.
- Plugin config secrets (e.g. a cloud root credential) are themselves stored in the infra engine.

### Target plugin matrix

| Category | Plugins (repo path) | Capability |
|----------|---------------------|------------|
| Cloud | plugins/cloud/arc-plugin-aws | STS temp creds, IAM users, assumed roles |
| Cloud | plugins/cloud/arc-plugin-gcp | service-account keys, short-lived tokens |
| Cloud | plugins/cloud/arc-plugin-azure | service principals, MSI |
| SCM | plugins/scm/arc-plugin-github | GitHub App tokens, deploy keys, fine-grained PATs |
| SCM | plugins/scm/arc-plugin-gitlab | project/group access tokens |
| SCM | plugins/scm/arc-plugin-bitbucket | app passwords / access tokens |
| DB | plugins/db/arc-plugin-postgres | dynamic DB users with TTL |
| DB | plugins/db/arc-plugin-mysql | dynamic DB users with TTL |
| Auth | plugins/auth/arc-plugin-oidc | OIDC/OAuth login |
| Auth | plugins/auth/arc-plugin-kubernetes | K8s ServiceAccount token login |

### Plugin package rules

- A plugin depends ONLY on `arc-plugin-sdk` and `arc-types`. Never on app internals.
- Each plugin ships its own Zod config schema, its own tests, and a README documenting scopes/permissions required on the target platform.
- Adding a plugin: implement the SDK contract, register it, add to the matrix above, write an ADR if it introduces a new credential type.

-----

## 4. Package-by-Package Architecture

### packages/arc-types

- **Purpose**: SoT for all shared types/schemas (both engines).
- **Contains**: domain interfaces (VaultItem, SecretLease, Policy, Identity, AuditEvent…), Zod schemas.
- **Must NOT contain**: logic, side effects, crypto impls.
- **Deps**: none. **Bootstrap priority**: 1.

### packages/arc-crypto

- **Purpose**: E2E crypto model (Bitwarden-style), key derivation, primitives.
- **Contains**: Argon2id/PBKDF2 KDF, AES-256-GCM, key hierarchy, envelope encryption.
- **Must NOT contain**: storage, network, UI. Must NOT copy Bitwarden/Vaultwarden code.
- **Deps**: arc-types. **Bootstrap priority**: 2.

### packages/arc-secrets-engine

- **Purpose**: Clean interface for KV + dynamic secrets (the Engine A contract).
- **Contains**: SecretEngine interface, KV/PKI/dynamic-secret types, mount abstraction.
- **Must NOT contain**: OpenBao-specific code (that's the adapter), UI.
- **Deps**: arc-types, arc-leasing. **Bootstrap priority**: 3.

### packages/arc-plugin-sdk

- **Purpose**: Contracts + host runtime for plugins (SecretsPlugin, AuthPlugin, StoragePlugin).
- **Contains**: interfaces, plugin metadata types, host loader, capability scoping.
- **Must NOT contain**: any specific plugin impl (those live in plugins/), app internals, the master key.
- **Deps**: arc-types. **Bootstrap priority**: 3.

### packages/arc-leasing

- **Purpose**: Lease + revocation lifecycle (Vault-style TTLs, renew, revoke).
- **Deps**: arc-types. **Bootstrap priority**: 2.

### packages/arc-identity

- **Purpose**: Identity schemas, DID, profiles.
- **Deps**: arc-types, arc-crypto. **Bootstrap priority**: 3.

### packages/arc-protocols

- **Purpose**: Wire formats + sync protocol definitions.
- **Deps**: arc-types. **Bootstrap priority**: 3.

### packages/arc-auth

- **Purpose**: Auth flows, sessions, tokens, MFA, OIDC.
- **Deps**: arc-types, arc-identity, arc-crypto. **Bootstrap priority**: 4.

### packages/arc-grants

- **Purpose**: ACL/policy model (Vault-style HCL-equivalent policies, RBAC).
- **Deps**: arc-types, arc-identity. **Bootstrap priority**: 4.

### packages/arc-events

- **Purpose**: Event bus contracts, schema registry.
- **Deps**: arc-types. **Bootstrap priority**: 3.

### packages/arc-audit

- **Purpose**: Audit log interfaces + emitters (unified across both engines).
- **Deps**: arc-types, arc-events. **Bootstrap priority**: 4.

### integrations/arc-openbao-adapter

- **Purpose**: Implement arc-secrets-engine against the OpenBao API.
- **Contains**: OpenBao HTTP client, auth, mount mgmt, KV/PKI/dynamic mapping.
- **Must NOT contain**: any HashiCorp Vault BSL code. Pin to OpenBao (MPL).
- **Deps**: arc-types, arc-secrets-engine, arc-leasing. **Bootstrap priority**: 5.

### apps/arc-server

- **Purpose**: Backend control plane unifying both engines + identity/auth/audit.
- **Tech**: Node/Bun, REST + (optionally) gRPC.
- **Deps**: most packages + arc-openbao-adapter. **Bootstrap priority**: 5.

### apps/arc-vault-web

- **Purpose**: Web app (consumer E2E vault + infra-secrets admin).
- **Tech**: React, Tailwind, Vite. **Deps**: arc-types, arc-crypto, arc-auth, arc-js-sdk.
- **Bootstrap priority**: 6.

### apps/arc-browser-extension

- **Purpose**: Autofill + quick-access extension (Bitwarden-ext-style).
- **Tech**: WebExtension API, React. **Deps**: arc-types, arc-crypto, arc-js-sdk.
- **Bootstrap priority**: 7.

### apps/arc-vault-desktop

- **Purpose**: Offline-first desktop vault.
- **Tech**: Tauri. **Deps**: arc-types, arc-crypto, arc-js-sdk. **Bootstrap priority**: 7.

### apps/arc-cli

- **Purpose**: CLI for both engines (bao/vault-style UX).
- **Tech**: TS, Node, Clipanion. **Deps**: arc-types, arc-crypto, arc-js-sdk. **Bootstrap priority**: 6.

### sdks/arc-js-sdk

- **Purpose**: Public TS/JS SDK. **Publish**: npm (eventually).
- **Deps**: arc-types, arc-crypto, arc-protocols. **Bootstrap priority**: 6.

### sdks/arc-go-sdk

- **Purpose**: Go SDK. **Publish**: pkg.go.dev (eventually). **Bootstrap priority**: 8.

### infra/arc-operator

- **Purpose**: K8s operator for secret injection (Vault-Agent-Injector analogue).
- **Tech**: Go (controller-runtime). **Bootstrap priority**: 8.

-----

## 5. Dependency Graph

```
arc-types ─────────────────────────── (root, no deps)
   ↑
   ├── arc-crypto
   ├── arc-protocols
   ├── arc-events
   ├── arc-leasing
   │
   ├── arc-identity     ← arc-crypto
   ├── arc-secrets-engine ← arc-leasing
   ├── arc-auth         ← arc-identity, arc-crypto
   ├── arc-grants       ← arc-identity
   └── arc-audit        ← arc-events

arc-openbao-adapter ← arc-secrets-engine, arc-leasing
arc-server          ← (most packages) + arc-openbao-adapter
arc-js-sdk          ← arc-types, arc-crypto, arc-protocols
arc-vault-web       ← arc-types, arc-crypto, arc-auth, arc-js-sdk
arc-browser-extension ← arc-types, arc-crypto, arc-js-sdk
arc-cli             ← arc-types, arc-crypto, arc-js-sdk
plugins/*           ← arc-plugin-sdk, arc-types (ONLY)
arc-server          ← + arc-plugin-sdk (hosts plugins)
```

-----

## 6. Phased Roadmap

### Phase 0 — Foundation (Week 1–2)

- [ ] pnpm workspaces + Turborepo
- [ ] arc-types with core interfaces (both engines)
- [ ] arc-crypto skeleton (Bitwarden-model KDF + envelope encryption)
- [ ] arc-secrets-engine + arc-leasing interfaces
- [ ] arc-openbao-adapter skeleton talking to dev-mode OpenBao
- [ ] CI (typecheck + build on PR)
- [ ] Migrate existing arc-vault code into correct locations
- **Output**: compilable monorepo; adapter can `bao status` against a dev OpenBao.

### Phase 1 — Engines (Week 3–8)

- [ ] Implement arc-crypto fully (real E2E, tested against Bitwarden-model test vectors you author)
- [ ] Implement arc-openbao-adapter (KV v2, dynamic secrets, PKI, K8s auth via OpenBao)
- [ ] Implement arc-identity, arc-auth, arc-grants, arc-events, arc-audit
- [ ] arc-server wiring both engines under one identity/auth/audit
- [ ] Unit tests across all packages
- **Output**: both engines callable through arc-server.

### Phase 2 — Products + Plugins (Week 9–16)

- [ ] arc-vault-web (consumer E2E vault + infra admin UI)
- [ ] arc-cli
- [ ] arc-js-sdk v0.1
- [ ] arc-browser-extension MVP
- [ ] arc-plugin-sdk finalized; build first plugins: arc-plugin-aws, arc-plugin-github, arc-plugin-postgres, arc-plugin-oidc
- [ ] Playwright e2e
- **Output**: usable end-to-end product with a working plugin set.

### Phase 3 — Infra & Ops (Week 16–20)

- [ ] arc-helm-charts (deploy arc-server + colocated OpenBao)
- [ ] arc-terraform modules
- [ ] arc-operator (secret injection)
- [ ] Remaining plugins: gcp, azure, gitlab, bitbucket, mysql, kubernetes
- [ ] Changesets release pipeline
- [ ] Docs site

### Phase 4 — Extraction (when justified, need 2+ triggers)

Triggers: external independent consumers · different release cadence · security boundary · CI slowness.
First candidates: `arc-js-sdk`, `arc-cli`, `arc-crypto` (security-sensitive, auditable).
Method: `git filter-repo --subdirectory-filter packages/arc-crypto` (preserves history).

-----

## 7. Workspace Config

### pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
  - 'sdks/*'
  - 'integrations/*'
  - 'plugins/**'
```

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"], "outputs": [] },
    "lint": { "outputs": [] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] }
  }
}
```

### root package.json

```json
{
  "name": "arc-vault-monorepo",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "dev": "turbo run dev --parallel"
  },
  "devDependencies": { "turbo": "latest", "typescript": "^5.x", "vitest": "^1.x" },
  "engines": { "node": ">=20", "pnpm": ">=9" }
}
```

-----

## 8. Internal Package Template

```
packages/arc-xxx/
  src/index.ts        # public API, explicit named exports only
  tests/index.test.ts
  package.json        # name "@arc/xxx", private:true, exports map
  tsconfig.json
  README.md
  CLAUDE.md           # package-level agent context (incl. any license notes)
```

-----

## 9. Release Strategy

- Phase 0–3: all packages `private: true`, versioned via Turborepo.
- Phase 4+: Changesets semver for SDKs/CLI. Publish `arc-js-sdk` as `@arc/sdk`, `arc-cli` as `@arc/cli`.

-----

## 10. CI/CD Standards

Every PR must pass: `turbo typecheck` · `turbo lint` · `turbo test` · `turbo build`.
Plus a **license check** job: fail if any dependency or vendored file is BSL-1.1 (HashiCorp) or
an unreviewed AGPL source. Workflow: `.github/workflows/ci.yml`.

-----

## 11. ADR Requirements

ADR required (in `docs/arc-rfcs/`) before implementing anything touching:
package boundaries · crypto algorithm choices · protocol wire formats · auth flows ·
external API contracts · **any reuse of upstream OSS code (license boundary)**.
Format: `docs/arc-rfcs/ADR-XXX-title.md`.

-----

## 12. Claude Code Agent Coordination

- Read across packages freely (`--add-dir` if needed); WRITE to one package per session.
- Check `arc-types` before defining any interface; check `CLAUDE.md` before creating packages.
- For Engine A: prefer OpenBao **adapter** over reimplementation.
- For Engine B: **reimplement** Bitwarden crypto model; never vendor Vaultwarden (AGPL).
- Never introduce HashiCorp Vault BSL code.
- Run `pnpm turbo build` after structural changes.
- Save handoff state in `docs/arc-architecture/CURRENT_TASK.md` before ending a session.

-----

## Reference Docs (read alongside this plan)

- `REFERENCE-hashicorp-vault.md` — exhaustive Vault/OpenBao feature map for **Engine A** parity (secrets engines, auth methods, leasing, PKI, transit, policies, plugin model).
- `REFERENCE-1password-bitwarden.md` — exhaustive 1Password + Bitwarden feature map for **Engine B** parity (E2E crypto model, item types, Send, sharing, dev tools, SSO/SCIM, secrets manager).

Agents building any engine/plugin/crypto code should consult the relevant reference doc first
to understand the target behavior, then implement against OpenBao (Engine A) or reimplement the
Bitwarden crypto model (Engine B).

## Appendix — Upstream Reference Links

- OpenBao repo: <https://github.com/openbao/openbao>
- OpenBao site/docs: <https://openbao.org/>
- Vaultwarden (study only, AGPL): <https://github.com/dani-garcia/vaultwarden>
- Bitwarden org: <https://github.com/bitwarden>
- Bitwarden open-source overview: <https://bitwarden.com/open-source/>
- HashiCorp Vault (BSL — DO NOT copy): <https://github.com/hashicorp/vault/blob/main/LICENSE>
