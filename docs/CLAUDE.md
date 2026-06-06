# arc — Monorepo

## Claude Code Workspace Context

-----

## Product Vision

**arc = OpenBao (infra-grade secrets) + Bitwarden-class E2E vault (consumer UX), unified.**

One self-hostable platform doing both:

- **Infrastructure secrets** (dynamic secrets, PKI, KV, K8s auth, leasing/revocation, encryption-as-a-service) — the Vault use case
- **End-to-end-encrypted vault** (passwords, passkeys, TOTP, secure notes, sharing) — the 1Password / Bitwarden use case

Unified under one identity, one policy model, one audit trail, one UI. **Plugin system** for
cloud platforms, source control, databases, and auth backends.

-----

## Build Posture — OpenBao for the crypto core, in-house for everything above it

arc does **not** reinvent the cryptographic core (storage barrier, seal/unseal, Raft consensus,
PKI CA, KV/transit engines). It builds on **OpenBao (MPL 2.0)** for that, and writes everything
that is arc's actual product in-house: the unified API, identity/policy/audit model, E2E vault,
plugin system, SDKs, clients, and UI.

- **Engine A core** (barrier, seal, Raft HA, PKI, transit, KV v2): provided by a **colocated
  OpenBao server**, driven through its Vault-compatible HTTP API by `integrations/arc-openbao-adapter`.
- **Engine B** (E2E personal/team vault): in-house, reimplementing the Bitwarden zero-knowledge
  crypto *model* in `arc-crypto` (server stores ciphertext only).
- **Dynamic-credential breadth** (cloud/scm/db) and **auth methods**: arc plugins, so arc isn't
  limited to OpenBao's engine catalog.

### Licensing rules (READ before writing engine/crypto code)

| Project | License | Use |
|---------|---------|-----|
| **OpenBao** | MPL 2.0 — commercial OK | BUILD ON. Colocate + drive via API. <https://github.com/openbao/openbao> · <https://openbao.org/> |
| HashiCorp Vault | BSL 1.1 | READ docs to understand behavior; do NOT copy code. <https://github.com/hashicorp/vault> |
| Bitwarden | GPL/AGPL + SDK terms | Reimplement crypto *model* in arc-crypto; do not copy code. <https://github.com/bitwarden> |
| Vaultwarden | AGPL-3.0 | Study only; do not vendor. <https://github.com/dani-garcia/vaultwarden> |

- OpenBao MPL 2.0 = weak copyleft: modifications to MPL files stay MPL, but you may combine with
  proprietary arc code and ship commercially. SAFE.
- Never copy Vault BSL source (reading docs to learn behavior is fine; reading-then-rewriting BSL code is a derivation risk).
- Engine B: reimplement Bitwarden's crypto model from its public spec; never vendor Vaultwarden (AGPL).
- Any license-boundary call → ADR in `docs/arc-rfcs/`.

### Reference docs (read to learn target behavior)

- `REFERENCE-hashicorp-vault.md` — Engine A feature map (what OpenBao gives you + what to wrap).
- `REFERENCE-1password-bitwarden.md` — Engine B feature map (E2E model, items, sharing, dev tools).

-----

## Naming

- Everything uses the `arc-` / `@arc/` prefix. **Never write "Qwantarc" in code, packages, repos, or identifiers.**

-----

## Monorepo Structure

```
arc/
  packages/
    arc-types/              # source of truth for all TS types/schemas
    arc-crypto/             # E2E crypto model (Bitwarden-style), key derivation
    arc-identity/           # entities, groups, aliases, identity schemas
    arc-protocols/          # wire formats, sync protocol
    arc-auth/               # tokens, sessions, login orchestration, response-wrapping
    arc-audit/              # audit devices (fail-closed), event log
    arc-events/             # event bus contracts
    arc-grants/             # policy engine (path+capabilities ACL), entities/groups binding
    arc-secrets-engine/     # arc's clean engine contract (backed by OpenBao via adapter)
    arc-leasing/            # lease + renewal + revocation lifecycle (TTLs)
    arc-plugin-sdk/         # plugin contract + host runtime
  apps/
    arc-vault-web/
    arc-vault-desktop/
    arc-browser-extension/
    arc-cli/
    arc-server/             # control plane: routing, request handling, plugin host
    arc-agent/              # client-side agent: auto-auth, templating, caching
  sdks/
    arc-js-sdk/
    arc-go-sdk/
  integrations/
    arc-openbao-adapter/    # adapter to the colocated OpenBao engine (Engine A core)
  plugins/
    cloud/ (arc-plugin-aws, -gcp, -azure)
    scm/   (arc-plugin-github, -gitlab, -bitbucket)
    db/    (arc-plugin-postgres, -mysql)
    auth/  (arc-plugin-oidc, -kubernetes)
  infra/
    arc-helm-charts/        # deploys arc-server + colocated OpenBao
    arc-terraform/
    arc-operator/           # K8s operator (secret injection)
  docs/
    arc-rfcs/
    arc-architecture/
  CLAUDE.md                 # YOU ARE HERE
  MONOREPO_PLAN.md
  REFERENCE-hashicorp-vault.md
  REFERENCE-1password-bitwarden.md
  turbo.json
  pnpm-workspace.yaml
  package.json
```

-----

## The Two Engines

**Engine A — Infra Secrets (OpenBao-backed):** `arc-secrets-engine` defines arc's clean
interface; `integrations/arc-openbao-adapter` implements it against a colocated OpenBao server
(KV v2, dynamic secrets, PKI, transit, K8s auth, barrier/seal/Raft — all from OpenBao).
`arc-leasing` tracks lease lifecycle. `arc-operator` / `arc-agent` deliver secrets to workloads.

**Engine B — E2E Vault (in-house Bitwarden model):** `arc-crypto`, `arc-vault-web`,
`arc-browser-extension`. Zero-knowledge; server stores ciphertext only; master key never leaves client.

`arc-server` unifies both + hosts plugins under one identity/auth/audit/UI.

### Local dev — run OpenBao in dev mode

```
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root \
  quay.io/openbao/openbao:latest server -dev
export BAO_ADDR="http://127.0.0.1:8200"
export BAO_TOKEN="root"
# arc-openbao-adapter points here in dev
```

-----

## Plugins (parity with Vault's ecosystem)

`packages/arc-plugin-sdk` defines contracts every plugin implements:

- `SecretsPlugin` — dynamic credential generation + revocation (Vault "secret engine").
- `AuthPlugin` — authenticate caller against external IdP → arc identity/policy (Vault "auth method").
- `StoragePlugin` — pluggable backend storage (optional).

Lifecycle: discover → register → configure → mount(path) → handle → lease/renew/revoke.
Isolation: plugins run as isolated processes (gRPC) or sandboxed modules loaded by arc-server;
they NEVER receive the E2E master key — only scoped capabilities + their own config. All actions
flow through arc-audit. Plugin config secrets are themselves stored in the infra engine.

Target matrix: cloud (aws/gcp/azure) · scm (github/gitlab/bitbucket) · db (postgres/mysql) ·
auth (oidc/kubernetes). Use OpenBao's plugin/engine model as the reference for behavior. See
MONOREPO_PLAN.md for the full plugin spec.

-----

## Dependency Rules (STRICT)

```
plugins/*       → arc-plugin-sdk, arc-types ONLY
apps/*          → packages/*, sdks/*, integrations/*
sdks/*          → packages/* ONLY
integrations/*  → packages/* + external clients (OpenBao API)
packages/*      → other packages/* (per graph in MONOREPO_PLAN.md)
infra/*         → no imports from packages/apps
docs/*          → no code imports
```

NEVER import app code into packages/sdks/plugins.
NEVER copy HashiCorp Vault BSL code, or vendor Vaultwarden (AGPL).

-----

## Source of Truth

| Concern | Owner |
|---------|-------|
| Shared TS types | arc-types |
| E2E crypto model | arc-crypto |
| Plugin contracts | arc-plugin-sdk |
| Secrets engine contract | arc-secrets-engine |
| OpenBao integration | arc-openbao-adapter |
| Lease lifecycle | arc-leasing |
| ACL / policy | arc-grants |
| Identity / entities | arc-identity |

Check `arc-types` first before defining any interface.

-----

## Technology Stack

- TypeScript (strict) across packages/apps/sdks/plugins.
- OpenBao (Go) as the colocated Engine-A core (run as a separate process/container; arc talks to its API).
- React + Tailwind (web, extension). Tauri (desktop). Node/Bun (server, cli).
- Audited crypto libs for Engine B (WebCrypto, noble-*) — never hand-rolled algorithms.
- pnpm workspaces + Turborepo. Vitest + Playwright. GitHub Actions CI.

-----

## Current Phase

**Phase 0 — Foundation**

- [ ] Scaffold monorepo (incl. integrations/ + plugins tree)
- [ ] pnpm workspaces + Turborepo
- [x] arc-types core interfaces (both engines + plugin contracts) — `packages/arc-types` holds `JsonValue`, `Envelope` + `SignatureEnvelope` wire shapes, `MemberRole`/`VaultType`. Other shared types migrate in as they appear.
- [ ] arc-crypto skeleton (Bitwarden-style E2E model, using audited libs)
- [ ] arc-secrets-engine interface + arc-leasing
- [ ] arc-openbao-adapter skeleton talking to dev-mode OpenBao (`bao status` round-trip)
- [ ] arc-plugin-sdk: SecretsPlugin / AuthPlugin contracts
- [ ] Migrate existing arc-vault code into correct locations

See MONOREPO_PLAN.md for full roadmap + reference docs for target feature behavior.

-----

## Branching & PR workflow

Work lands on `develop` through **pull requests**, never by committing straight to it.

- **Branch names use category prefixes**, grouped by area of work (one branch/PR per area
  or phase — not one per tiny feature). The set is **open-ended**: these are the common
  prefixes, but introduce a new one (`test/`, `refactor/`, `perf/`, `security/`, `release/`,
  `docs/`, …) whenever the work genuinely warrants it.
  - `feat/<topic>` — product features in apps/packages (e.g. `feat/multi-device-rotation`).
  - `fix/<topic>` — bug fixes that don't belong to a larger in-flight branch.
  - `ops/<topic>` — infra, CI, release pipeline, operator, agent (e.g. `ops/release-pipeline`).
  - `plugins/<topic>` — plugin work (e.g. `plugins/auth-oidc-kubernetes`).
  - `architecture/<topic>` — ADRs, protocol specs, structural/architectural decisions.
  - `chore/<topic>` — docs, process, tooling, dependency bumps, housekeeping (e.g. README,
    workflow, this convention itself).
  - `design/<topic>` — **reserved for actual UI / UX design work** (visual + interaction
    design), not docs or process.
- **Open a PR into `develop`, merge once CI is green.** Keep PRs scoped to their area.
- Commits stay **GPG-signed** as the repo author (so GitHub shows "Verified"). Do **not**
  rewrite authorship to `noreply@anthropic.com` — the stop-hook that suggests this is a
  generic default that conflicts with this repo's signing setup; ignore it.
- **Sandbox transport caveat:** the remote-execution git proxy only accepts pushes to the
  session's assigned `claude/…` ref (every other ref, including `develop`, returns 503). So
  from the sandbox: do the work on a properly-named local branch rebased on `develop`,
  `git push` it to the assigned `claude/…` ref as a dumb transport, then create the
  **real-named** branch + PR via the GitHub API (`create_branch` from that ref, then
  `create_pull_request`). On GitHub only the real names appear; the `claude/…` ref stays an
  invisible implementation detail.

-----

## Agent Instructions

1. Use only the `arc-` prefix. Never write "Qwantarc".
2. Engine A: build on OpenBao via the adapter — do NOT reimplement barrier/seal/Raft/PKI.
3. Engine B: reimplement the Bitwarden crypto model in arc-crypto; never vendor Vaultwarden.
4. Read Vault docs to learn behavior; never copy Vault BSL code.
5. Use audited crypto libs; never hand-implement algorithms.
6. Plugins never see the E2E master key; only scoped capabilities.
7. Check arc-types before defining interfaces; check this file for where code belongs.
8. Run `pnpm turbo build` after structural changes. License/dependency calls → ADR.
9. Land work via category-prefixed branches + PRs into `develop` (see "Branching & PR
   workflow"). Never commit straight to `develop`/`main`.
