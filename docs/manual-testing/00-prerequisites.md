# 00 — Prerequisites

## Toolchain

| Tool | Version | Why |
|------|---|---|
| **Node** | 20.x or 22.x | arc-server is NestJS 11; SDKs target ES2022; passkey node-client uses `node:crypto` |
| **pnpm** | 10.x | Workspace + Turborepo orchestration |
| **Docker** | any recent | Optional — only for `OpenBao` (Engine-A). Engine-B works without it |
| **Rust** | stable | Optional — needed only if you touch `crates/vault-crypto-rs` or `crates/desktop-core` |

Check:

```bash
node --version       # v20+ or v22+
pnpm --version       # 10.x
docker --version     # any
rustc --version      # optional
```

If `pnpm` is missing: `corepack enable && corepack prepare pnpm@latest --activate`.

## Browser support

| Browser | Engine-B vault | Passkey register | Passkey unlock |
|---|---|---|---|
| Chrome 116+ | ✅ | ✅ (with PRF) | ⚠ web UI pending |
| Safari 17+ | ✅ | ✅ (with PRF) | ⚠ web UI pending |
| Firefox 122+ | ✅ | ❌ (no PRF yet) | ❌ (no PRF yet) |

The vault UI itself works in every modern browser. The passkey flow specifically needs
the WebAuthn PRF extension; until Firefox ships it, use Chrome / Safari for the passkey
manual-test scenarios (Section 03).

## Environment variables

Every variable is optional and defaults to a sane dev value. Set them when you want
production posture (`prod`-column) or a non-default endpoint.

| Variable | Dev default | Prod requirement | Used by |
|---|---|---|---|
| `DATABASE_URL` | sql.js in-memory | **required** (`NODE_ENV=production` refuses to start without it) | arc-server |
| `NODE_ENV` | `development` | `production` enables the strict path (migrations only, no synchronize) | arc-server |
| `JWT_SECRET` | random per-boot | **required** in prod | arc-server |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | optional | arc-server |
| `BAO_ADDR` | (unset → Engine-A disabled) | required to use OpenBao | arc-server, adapter tests |
| `BAO_TOKEN` | (unset) | required if Engine-A enabled | adapter |
| `BAO_NAMESPACE` | (unset) | optional | adapter |
| `ARC_DEFAULT_POLICY` | `allow` | `deny` | grants module |
| `ARC_POLICY_CACHE_TTL_MS` | `30000` | tune | grants module |
| `ARC_ROOT_USERS` | (unset) | comma list of user ids when `ARC_DEFAULT_POLICY=deny` | grants module |
| `ARC_PASSKEY_RP_ID` | `localhost` | the public hostname | passkey service |
| `ARC_PASSKEY_RP_NAME` | `arc` | display name in OS dialogs | passkey service |
| `ARC_PASSKEY_ORIGIN` | `http://localhost:5173` | the public origin (https in prod) | passkey service |

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
pnpm -r build         # turbo build all packages
pnpm -r test          # 300 tests should pass (some skipped without BAO_ADDR)
```

If `pnpm -r test` is green, every module compiled and every unit/integration boundary holds.
The manual flows below are about UX + browser + cross-engine behavior.
