# Setting up arc locally

This guide takes you from `git clone` to a running arc with the web console, the CLI, and
optionally the Engine-A infrastructure backend, **on one machine**, in about ten minutes. If
something doesn't work, jump to [Troubleshooting](#troubleshooting). For deeper per-surface
playbooks (passkey flows, plugin authoring, multi-device, etc.), see
[`docs/manual-testing/`](docs/manual-testing/).

> **Target audience.** Developers evaluating arc, contributors getting a workspace stood up,
> and operators rehearsing a self-host on their laptop before bringing up the Helm chart.

---

## 1 · Prerequisites

| Tool       | Version          | Why                                                                        |
| ---------- | ---------------- | -------------------------------------------------------------------------- |
| **Node**   | 22 LTS or 24 LTS | arc-server is NestJS 11; SDKs target ES2022; CI runs Node 24               |
| **pnpm**   | 10.x             | Workspace + Turborepo orchestration                                        |
| **Git**    | recent           | Pulling submodules and the pre-push hook script                            |
| **Docker** | recent (optional)| Only needed for Engine A (OpenBao) — Engine B works without it             |
| **Rust**   | stable (optional)| Only needed if you touch `crates/vault-crypto-rs` or `crates/desktop-core` |
| **Helm**   | 3.x (optional)   | Only needed to validate the chart locally — `pnpm test` does it structurally without it |

Check:

```sh
node --version       # v22.x or v24.x
pnpm --version       # 10.x
docker --version     # any recent
rustc --version      # optional
```

> **No pnpm?** `corepack enable && corepack prepare pnpm@latest --activate`.
> **Wrong Node?** Use [`fnm`](https://github.com/Schniz/fnm) or [`nvm`](https://github.com/nvm-sh/nvm):
> `fnm use 22` or `nvm install --lts`.

### Browser support for passkeys

| Browser     | Vault | Passkey register | Passkey unlock |
| ----------- | ----- | ---------------- | -------------- |
| Chrome 116+ | ✅     | ✅ (PRF)          | ✅              |
| Safari 17+  | ✅     | ✅ (PRF)          | ✅              |
| Firefox     | ✅     | ❌ (no PRF yet)   | ❌ (no PRF yet) |

The vault UI works in every modern browser; only the passkey-PRF flow needs Chrome or Safari.

---

## 2 · Clone and install

```sh
git clone https://github.com/ethchor/arc.git
cd arc

# pnpm install runs the postinstall hook that registers the local pre-push gate
# (build → typecheck → test). You'll see "✓ git hooks installed" near the end.
pnpm install

# Build the full workspace — about 90 seconds cold, 10 seconds warm thanks to turbo cache.
pnpm build
```

---

## 3 · Run the API server

`arc-server` (`apps/arc-server`) ships with a dev profile that runs without external
dependencies — in-memory database, in-memory blob store, ephemeral JWT secret.

```sh
# ARC_ENABLE_DEV_LOGIN=true is required to use POST /auth/dev-login (audit MED-C) — the
# server refuses it by default, even in non-production, so deploys that forget to set
# NODE_ENV don't accidentally ship a "log in as anyone" RPC.
ARC_ENABLE_DEV_LOGIN=true pnpm --filter @arc/server start
```

You should see, near the end of the boot log:

```
[arc-vault] JWT_SECRET not set; using an ephemeral random secret (dev/test only).
INFO ... Nest application successfully started
INFO ... arc-vault API listening on :3001
```

Verify in another shell:

```sh
curl -s http://localhost:3001/metrics | head -2
# # HELP arc_process_cpu_user_seconds_total Total user CPU time spent in seconds.
# # TYPE arc_process_cpu_user_seconds_total counter
```

If you see Prometheus metrics, the server is up.

---

## 4 · Run the web console

In a second shell:

```sh
pnpm --filter @arc/vault-web dev
# > Ready on http://localhost:3002
```

Open <http://localhost:3002>:

1. Click **"Create account"**, pick any email, and choose a master password.
2. You're now enrolled. The server stored your wrapped private keys; **it never saw the
   master password or any derived key**. You can confirm with `/metrics` or by inspecting
   the rows in the in-memory DB.
3. Create a vault, add an item, log out, log back in with the master password — done.

---

## 5 · Optional — Engine A (infrastructure secrets)

Engine A is backed by OpenBao behind the `arc-openbao-adapter`. Spin it up with the bundled
compose file:

```sh
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d

# Tell the server where to find it. Restart the server after exporting these.
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN=root
```

Stop the existing server (Ctrl-C) and start it again with the env vars exported in the same
shell. The server's boot log will now show **`Engine-A enabled`** instead of the
`Engine-A disabled (BAO_ADDR unset); /v1/* will return 503` you saw before.

Probe:

```sh
curl -s -H 'Authorization: Bearer <a-jwt>' http://localhost:3001/v1/sys/seal-status
# { "sealed": false, "version": "...", ... }
```

When you're done:

```sh
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml down
```

---

## 6 · Optional — CLI

The CLI works against a running server. From the repo root:

```sh
pnpm --filter @arc/cli build
node apps/arc-cli/dist/bin.js --help
```

Useful starting points are in [`docs/manual-testing/07-cli.md`](docs/manual-testing/07-cli.md).

---

## 7 · Optional — Rust crypto + desktop core

If you'll touch the Rust crates (cross-platform crypto parity, desktop runtime):

```sh
# In the workspace root.
cargo test --manifest-path crates/vault-crypto-rs/Cargo.toml
cargo test --manifest-path crates/desktop-core/Cargo.toml
```

You should see all parity tests pass, including `jcs_matches_ts` and
`pq_seal_opens_a_ts_produced_envelope`. CI runs the same commands.

---

## 8 · Running the test suite

The full chain CI runs is just:

```sh
pnpm ci    # = pnpm build && pnpm typecheck && pnpm test
```

For a focused single suite:

```sh
# All vitest packages (extension, helm chart structural, sdk, etc.)
pnpm exec turbo run test --filter='!@arc/server'

# Just the server's e2e + unit jest suites (this one is RAM-heavy, ~2 GiB peak).
pnpm --filter @arc/server test
```

The **pre-push hook** (installed at `pnpm install`) runs the same chain on `git push`, so
local pushes never bring down `develop`. To bypass it intentionally:
`git push --no-verify` — but use sparingly; CI will catch anything you skip.

---

## 9 · Production-style boot (optional)

The dev profile is intentionally permissive. To prove your install would also survive a real
prod start:

```sh
JWT_SECRET="$(openssl rand -hex 32)" \
DATABASE_URL=postgres://arc:arc@localhost:5432/arc \
NODE_ENV=production \
ARC_DEFAULT_POLICY=deny \
ARC_ROOT_USERS=alice@example.com \
pnpm --filter @arc/server start
```

The server now refuses to boot without `DATABASE_URL` and `JWT_SECRET`, defaults the policy
mode to **deny**, runs TypeORM migrations (not `synchronize`), and disables `dev-login`
regardless of `ARC_ENABLE_DEV_LOGIN`. This is the posture the Helm chart and Terraform module
deploy with.

For the full deploy story, see:

- **[`infra/arc-helm-charts/`](infra/arc-helm-charts/)** — Helm chart for Kubernetes
- **[`infra/arc-terraform/`](infra/arc-terraform/)** — Terraform module wrapping the chart
- **[`apps/arc-operator/`](apps/arc-operator/)** — Kubernetes operator that reconciles
  `ArcSecret` + `ArcDynamicCredential` CRDs into K8s `Secret`s

---

## Environment variables — full reference

Every variable defaults to a sane dev value. Set them when you want production posture or
a non-default endpoint.

### Server (`arc-server`)

| Variable                                | Dev default                  | Required in prod                                                   | Used by                |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------ | ---------------------- |
| `DATABASE_URL`                          | in-memory sql.js             | **yes** — server refuses to boot without it under `NODE_ENV=production` | server boot            |
| `NODE_ENV`                              | `development`                | set to `production` for the strict path (migrations only, no synchronize) | many                   |
| `JWT_SECRET`                            | per-boot random              | **yes**                                                            | auth                   |
| `LOG_LEVEL`                             | `debug` (dev) / `info` (prod)| optional                                                           | logger                 |
| `ARC_ENABLE_DEV_LOGIN`                  | unset (disabled)             | **leave unset** — required to be `true` for `/auth/dev-login` to work, ignored when `NODE_ENV=production` | auth (MED-C)           |
| `ARC_DEFAULT_POLICY`                    | `allow` (dev) / `deny` (prod)| `deny`                                                             | grants engine          |
| `ARC_ROOT_USERS`                        | unset                        | required if `ARC_DEFAULT_POLICY=deny` (bootstrap sudo subjects)    | grants engine          |
| `ARC_POLICY_CACHE_TTL_MS`               | `30000`                      | tune                                                               | grants engine          |
| `ARC_PLUGIN_MANIFEST`                   | `optional` (dev) / `required` (prod) | `required`                                                | plugin host (MED-D)    |
| `ARC_PLUGIN_TRUST_ANCHORS`              | unset                        | required if `ARC_PLUGIN_MANIFEST=required`                         | plugin host            |
| `ARC_ARGON_MIN_M` / `ARC_ARGON_MIN_T`   | dev floor: 128 / 1; prod floor: 65536 / 2 | override staging KDF floor without flipping NODE_ENV | enroll / recover (LOW-B) |
| `ARC_DEVICE_INACTIVE_DAYS`              | unset (disabled)             | optional — auto-revoke devices idle for N days                     | devices                |
| `BAO_ADDR` / `BAO_TOKEN` / `BAO_NAMESPACE` | unset (Engine A disabled)  | required to enable Engine A                                        | server, adapter        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | unset (no traces)            | optional — point at an OTLP/HTTP collector                         | observability          |

### Web console (`arc-vault-web`)

| Variable                | Dev default              | Notes                                                                      |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | `http://localhost:3001`  | Set to your real `arc-server` URL in production builds                     |
| `NEXT_OUTPUT`           | unset                    | Set to `export` for the desktop static build                               |

### Adapter / integration tests

| Variable     | Dev default                  | Notes                                                          |
| ------------ | ---------------------------- | -------------------------------------------------------------- |
| `BAO_ADDR`   | unset → live tests skip      | `http://127.0.0.1:8200` against the bundled compose file       |
| `BAO_TOKEN`  | unset → live tests skip      | `root` in dev mode                                             |

---

## Troubleshooting

**`pnpm install` warns "Unsupported engine: wanted: {node: \">=24\"}"**
Harmless on Node 22 LTS — every command in this guide is tested against both. If you want
the warning gone, switch to Node 24.

**`pnpm --filter @arc/server start` says `Error: Cannot find module '.../dist/main.js'`**
You skipped the build step. Run `pnpm build` first (or `pnpm --filter @arc/server build`
if you only want the server).

**`POST /auth/dev-login` returns 403 `dev_login_disabled`**
You forgot `ARC_ENABLE_DEV_LOGIN=true`. Restart the server with it set. In production the
endpoint is force-disabled — use a real OAuth IdP instead.

**Server boots but `/metrics` 404s**
You're on `:3002` (the web app). The API server is `:3001`.

**`@arc/server#test` exits 137 / OOM**
Jest needs ~2 GiB. Either run `pnpm test` on a host with more RAM, or run a single suite:
`pnpm --filter @arc/server exec jest test/vault.e2e-spec.ts --no-coverage`.

**The web console says "Server unreachable" on `http://localhost:3002`**
Check the server is listening on `:3001` (`curl http://localhost:3001/metrics`). If you've
changed the port, set `NEXT_PUBLIC_API_URL` and restart the web dev server.

**OpenBao container exits immediately**
The compose file expects ports `8200` to be free. `docker compose -f
integrations/arc-openbao-adapter/docker-compose.yml logs openbao` shows the cause.

**Pre-push hook fires on every push and is slow**
Expected — it runs the same chain CI does. To bypass for one push: `git push --no-verify`.
To remove it permanently: `git config --unset core.hooksPath`.

For deeper symptom→fix tables, see [`docs/manual-testing/09-troubleshooting.md`](docs/manual-testing/09-troubleshooting.md).

---

## What next?

- **[Manual testing playbook](docs/manual-testing/)** — step-by-step scenarios per surface
- **[Architecture decision records](docs/arc-rfcs/)** — every consequential design call
- **[STATUS.md](docs/STATUS.md)** — live tracker of what's shipped, in progress, and pending
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branching convention + commit + PR workflow
