# 00 — Prerequisites

> **Quickstart elsewhere.** [`SETUP.md`](../../SETUP.md) at the repo root is the canonical
> step-by-step "go from `git clone` to running on a laptop." This file is the more detailed
> per-section prerequisites + env reference that the manual-test playbooks below cross-link to.

## Toolchain

| Tool | Version | Why |
|------|---|---|
| **Node** | 22 LTS or 24 LTS | arc-server is NestJS 11; SDKs target ES2022; CI runs Node 24; `engines.node = ">=24"` (Node 22 still works with a harmless pnpm warning) |
| **pnpm** | 10.x | Workspace + Turborepo orchestration |
| **Docker** | any recent | Optional — only for `OpenBao` (Engine-A). Engine-B works without it |
| **Rust** | stable | Optional — needed only if you touch `crates/vault-crypto-rs`, `crates/desktop-core`, or `crates/arc-agent` |

Check:

```bash
node --version       # v22.x or v24.x
pnpm --version       # 10.x
docker --version     # any
rustc --version      # optional
```

If `pnpm` is missing: `corepack enable && corepack prepare pnpm@latest --activate`.

## Browser support

| Browser | Engine-B vault | Passkey register | Passkey unlock |
|---|---|---|---|
| Chrome 116+ | ✅ | ✅ (with PRF) | ✅ |
| Safari 17+ | ✅ | ✅ (with PRF) | ✅ |
| Firefox 122+ | ✅ | ❌ (no PRF yet) | ❌ (no PRF yet) |

The vault UI itself works in every modern browser. The passkey flow specifically needs
the WebAuthn PRF extension; until Firefox ships it, use Chrome / Safari for the passkey
manual-test scenarios (Section 03).

## Environment variables

Every variable is optional and defaults to a sane dev value. Set them when you want
production posture (`prod`-column) or a non-default endpoint. Several defaults are
**env-aware** — they flip behaviour when `NODE_ENV=production` so a forgotten env var
fails closed in production but stays permissive in dev.

| Variable | Dev default | Prod default / requirement | Used by |
|---|---|---|---|
| `DATABASE_URL` | sql.js in-memory | **required** (`NODE_ENV=production` refuses to start without it) | arc-server |
| `NODE_ENV` | `development` | `production` enables the strict path (migrations only, no synchronize) | arc-server |
| `JWT_SECRET` | random per-boot | **required** in prod | arc-server (MED-C) |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | optional | arc-server |
| `ARC_ENABLE_DEV_LOGIN` | unset (disabled) | force-disabled when `NODE_ENV=production` | auth (MED-C) — **set to `true` in dev to use `/auth/dev-login`** |
| `BAO_ADDR` | (unset → Engine-A disabled) | required to use OpenBao | arc-server, adapter tests |
| `BAO_TOKEN` | (unset) | required if Engine-A enabled | adapter |
| `BAO_NAMESPACE` | (unset) | optional | adapter |
| `ARC_DEFAULT_POLICY` | `allow` (dev) / **`deny`** (prod) | `deny` | grants module (CRIT-B) |
| `ARC_POLICY_CACHE_TTL_MS` | `30000` | tune | grants module |
| `ARC_ROOT_USERS` | (unset) | comma list of subject ids — required if `ARC_DEFAULT_POLICY=deny` | grants module |
| `ARC_PLUGIN_MANIFEST` | `optional` (dev) / **`required`** (prod) | `required` | plugin host (MED-D) |
| `ARC_PLUGIN_TRUST_ANCHORS` | (unset) | comma list of `<publisher>=<b64url-pub>` — required if `ARC_PLUGIN_MANIFEST=required` | plugin host |
| `ARC_ARGON_MIN_M` | `128` KiB (dev) / `65536` KiB = 64 MiB (prod) | override staging KDF floor without flipping NODE_ENV | enroll / recover (LOW-B) |
| `ARC_ARGON_MIN_T` | `1` (dev) / `2` (prod) | override staging KDF iteration floor | enroll / recover (LOW-B) |
| `ARC_DEVICE_INACTIVE_DAYS` | unset (auto-revoke disabled) | optional — number of days after which an untrusted, idle approved device is auto-revoked | devices |
| `ARC_PASSKEY_RP_ID` | `localhost` | the public hostname | passkey service |
| `ARC_PASSKEY_RP_NAME` | `arc` | display name in OS dialogs | passkey service |
| `ARC_PASSKEY_ORIGIN` | `http://localhost:5173` | the public origin (https in prod) | passkey service |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset → tracing disabled) | OTLP/HTTP collector URL (e.g. `http://otel-collector:4318`); the trace exporter appends `/v1/traces` if not present | observability |
| `OTEL_SERVICE_NAME` | `arc-server` | overrides the `service.name` resource attribute | observability |
| `OTEL_SERVICE_VERSION` | `0.0.0` | overrides the `service.version` resource attribute | observability |
| `OTEL_LOG_LEVEL` | (unset) | set to `debug` to enable verbose OTel diagnostic logs | observability |

`/metrics` is always on — no env required. Prometheus scrapes the endpoint
un-authenticated; access control lives at the network layer (bind the metrics port to
the internal interface, or front the route with nginx/envoy if the deployment needs auth).

> **`ARC_ENABLE_DEV_LOGIN=true` is required by every manual-test scenario below** that
> calls `POST /auth/dev-login` or uses `VaultClient.devLogin()`. The audit MED-C
> remediation made it opt-in even in dev so that a forgotten `NODE_ENV` in a deployed
> image doesn't silently ship a "log in as anyone" RPC. Export it once in your shell
> before walking through the scenarios:
>
> ```bash
> export ARC_ENABLE_DEV_LOGIN=true
> ```

## Ports the local stack uses

| Port | What | Override |
|---|---|---|
| 3000 | Web UI (Next.js dev) | `pnpm --filter @arc/vault-web dev -- -p <port>` |
| 3001 | arc-server (NestJS) | `PORT=3002 pnpm --filter @arc/server start` |
| 8200 | OpenBao dev mode | docker-compose service port mapping |
| 5173 | (matches `ARC_PASSKEY_ORIGIN` default; not actually a listening port — just the WebAuthn origin claim) | env |

If you change the web UI port, also update `ARC_PASSKEY_ORIGIN` to match for the passkey
flow to verify the assertion origin correctly.

## Sanity check

Before going further:

```bash
pnpm install          # warm caches; check workspace links
pnpm build            # turbo build all packages
pnpm test             # vitest + jest across the workspace
```

If `pnpm test` is green, every module compiled and every unit/integration boundary holds.
The manual flows below are about UX + browser + cross-engine behavior.
