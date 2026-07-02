# arc — Production Hardening

The minimum env contract + boot-time gates the arc-server enforces before serving real
traffic. Read this *before* your first non-dev deployment. Pair with doc 15 (crypto
correctness + KAT parity) and the helm chart README.

This doc only covers the **operational** posture (env vars, fail-closed boot gates,
hardening defaults). For the crypto-correctness checklist that gates a real-data
deployment, see [`15-testing-review-and-operations.md`](15-testing-review-and-operations.md)
§15.6.

-----

## 0. The minimum contract

A production arc-server **will refuse to boot** without these set:

| Variable | Required | What happens if missing |
|---|---|---|
| `NODE_ENV=production` | **MUST** | Flips every fail-closed default below. The `NODE_ENV !== "production"` check is exclusive — `"prod"` / `"Production"` / unset all mean "non-prod" and the dev defaults apply. |
| `JWT_SECRET` | **MUST** | Boot throws `JWT_SECRET is required in production`. In dev, a random ephemeral is generated + logged at warning level. |
| `DATABASE_URL` | **strongly recommended** | Unset → in-memory `sql.js` (data not persisted, dev only). |
| `BAO_ADDR` (+ optional `BAO_TOKEN`, `BAO_NAMESPACE`) | required to use Engine A | Unset → Engine B keeps working, every `/v1/*` returns 503 with `{ engine: "A", configured: false }`. |
| `ARC_ROOT_USERS` | required iff `ARC_DEFAULT_POLICY=deny` (i.e. always in prod) | Unset → boot logs `"ARC_DEFAULT_POLICY=deny but ARC_ROOT_USERS is unset — no subject can manage…"` and the deploy is unusable. |
| `ARC_PASSKEY_RP_ID` / `ARC_PASSKEY_RP_NAME` / `ARC_PASSKEY_ORIGIN` | required iff passkeys are enabled | Dev defaults `localhost` / `arc` / `http://localhost:3002,tauri://localhost` — passkeys registered under these can never be used from a real domain. |

If you set those five, the env-aware defaults below take over and the server is in a
fail-closed posture.

-----

## 1. The env-aware defaults (auto-flipped by `NODE_ENV=production`)

The June 2026 supply-chain audit established the rule: **explicit env wins; otherwise
fail closed in prod, fail open in dev**. Three variables follow it.

### 1.1 `ARC_DEFAULT_POLICY` (CRIT-B)
*Where:* `apps/arc-server/src/grants/grants.module.ts:34`.

| `NODE_ENV` | `ARC_DEFAULT_POLICY` | Behaviour |
|---|---|---|
| `production` | unset | `deny` (fail-closed); boot warns to set `ARC_ROOT_USERS` |
| `production` | `allow` | `allow` (operator opt-out, **not recommended**) |
| `production` | `deny` (explicit) | `deny` |
| `production` | invalid (e.g. `garbage`) | `deny` (fail-closed) |
| non-prod | unset | `allow` (dev ergonomics) |
| non-prod | invalid | `allow` (warns) |

In `deny` mode every `/v1/*` request from a user with **zero attached policies** returns
**403**. Bootstrap an admin via `ARC_ROOT_USERS=<comma-separated user IDs>` (gets `sudo`
capability) and attach per-mount policies to everyone else; see
[`manual-testing/06-grants-acl.md`](manual-testing/06-grants-acl.md) for the full dance.

### 1.2 `ARC_ENABLE_DEV_LOGIN` (MED-C)
*Where:* `apps/arc-server/src/auth/auth.service.ts:8`.

`POST /auth/dev-login` mints a real JWT for any email — useful for `curl` testing,
catastrophic in prod. The gate is:

- `NODE_ENV !== "production"`, **AND**
- `ARC_ENABLE_DEV_LOGIN === "true"`.

**Both** must be true. In `production` even an explicit `ARC_ENABLE_DEV_LOGIN=true` is
refused — this closes the old fail-open. Verify in your prod env that the var is **not
set** to `true` (or, better, not set at all).

### 1.3 `ARC_PLUGIN_MANIFEST` (MED-D)
*Where:* `apps/arc-server/src/plugins/plugin-manifest.service.ts`.

| `NODE_ENV` | `ARC_PLUGIN_MANIFEST` | Behaviour |
|---|---|---|
| `production` | unset / invalid | `required` (every plugin must ship a verified manifest) |
| `production` | `optional` (explicit) | `optional` (operator opt-out, **not recommended**) |
| non-prod | unset | `optional` |

In `required` mode unsigned plugins refuse to register and the corresponding mount is
left unregistered. Set `ARC_PLUGIN_TRUST_ANCHORS` to a comma-separated list of the public
keys you accept.

-----

## 2. Variable reference (every env var the server reads)

Grouped by concern. Items marked **prod**: review explicitly before going live.

### Identity / auth
| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | random ephemeral in dev; **required** in prod | Symmetric HS256 secret for arc-issued JWTs. |
| `ARC_ENABLE_DEV_LOGIN` | unset | See §1.2. **Never** set in prod. |
| `ARC_ROOT_USERS` | unset | Comma-separated user IDs with `sudo`. Required with `ARC_DEFAULT_POLICY=deny`. |
| `ARC_ARGON_MIN_M` / `ARC_ARGON_MIN_T` | 65 536 KiB / 2 (prod) | Argon2id parameter floors. Per-platform benchmarks should land at or above these. |
| **`ARC_PASSKEY_RP_ID`** | `localhost` | Real domain in prod (e.g. `vault.example.com`). Cannot be changed for already-registered passkeys. |
| **`ARC_PASSKEY_RP_NAME`** | `arc` | Display name shown by the OS passkey UI. |
| **`ARC_PASSKEY_ORIGIN`** | `http://localhost:3002,tauri://localhost` | Comma-separated allowed origins (web + desktop shell). |

### Engine-A backend
| Variable | Default | Notes |
|---|---|---|
| `BAO_ADDR` | unset | URL of the colocated OpenBao. Unset → Engine A disabled (503). |
| `BAO_TOKEN` | unset | OpenBao token. Match your OpenBao's policy posture. |
| `BAO_NAMESPACE` | unset | Optional; pinned `X-Vault-Namespace`. |

### Engines / ACL
| Variable | Default | Notes |
|---|---|---|
| `ARC_DEFAULT_POLICY` | env-aware (see §1.1) | `allow` (dev) / `deny` (prod). |
| `ARC_POLICY_CACHE_TTL_MS` | `30000` | Per-subject policy cache TTL. |

### Plugins
| Variable | Default | Notes |
|---|---|---|
| `ARC_PLUGIN_MANIFEST` | env-aware (see §1.3) | `optional` (dev) / `required` (prod). |
| `ARC_PLUGIN_TRUST_ANCHORS` | unset | Comma-separated public keys for manifest verification. |
| `ARC_PLUGIN_MOUNTS` | unset | Declarative mount list (path + plugin name + config ref). |
| `ARC_PUBLISHER_PRIV` | unset | Plugin author signing key (used by `tools/arc-plugin-sign`, **not** the server). |

### Network / transport
| Variable | Default | Notes |
|---|---|---|
| **`CORS_ORIGINS`** | `http://localhost:3002,tauri://localhost` | Comma-separated. Production: set to your real web + desktop origins. The dev default is a soft failure (just means no real origin can reach the API). |

### Persistence
| Variable | Default | Notes |
|---|---|---|
| **`DATABASE_URL`** | in-memory `sql.js` (dev only) | Postgres URL in prod. Migrations run at boot (`synchronize: false`). |
| `ARC_BLOB_BACKEND` | `memory` | `memory` (lost on restart) / `filesystem` / `s3`. **Must** be non-`memory` in prod. |
| `ARC_BLOB_DIR` | `/var/lib/arc/blobs` | When `ARC_BLOB_BACKEND=filesystem`. |
| `ARC_BLOB_S3_BUCKET` | required for `s3` | Plus `_PREFIX`, `_REGION`, `_ENDPOINT` (MinIO / R2 / S3-compat). |

### Devices
| Variable | Default | Notes |
|---|---|---|
| `ARC_DEVICE_INACTIVE_DAYS` | 40 | Untrusted devices unseen this long are auto-revoked. |
| `ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS` | 30 min | How often the sweep runs. |

### Agents / Engine-C
| Variable | Default | Notes |
|---|---|---|
| `ARC_AGENT_ATTESTATION` | **`required` in prod**, `optional` in dev/test | Agents must attest at registration in production unless you set `optional` (SEC-H7). An explicit value always wins. |
| `ARC_SPIFFE_ENFORCE` | **`true` in prod**, `false` in dev/test | Requires cryptographic SVID validation via the X.509 / JWKS bundles below (SEC-H7). **Boot fails in prod** with enforce on + no bundles — so a stock prod deploy must configure a bundle or explicitly set `ARC_SPIFFE_ENFORCE=false`. |
| `ARC_SPIFFE_TRUST_DOMAINS` | unset | Comma-separated SPIFFE trust domains accepted. |
| `ARC_SPIFFE_TRUST_BUNDLES` | unset | X.509 trust bundles (file paths). |
| `ARC_SPIFFE_JWKS_BUNDLES` | unset | JWKS bundles for JWT-SVID. |
| `ARC_SPIFFE_REQUIRED_AUDIENCE` | unset | Audience claim that SVIDs must carry. |

-----

## 3. Boot-time fail-closed gates

The server checks these **before serving traffic**. A misconfigured prod deploy crashes
loud, not silent.

- `JWT_SECRET` missing under `NODE_ENV=production` → `throw new Error("JWT_SECRET is required in production")`.
- `ARC_DEFAULT_POLICY=deny` + `ARC_ROOT_USERS` unset → boot logs `WARN` (deploy is up but unusable; surfaces in your alert pipeline).
- `ARC_SPIFFE_ENFORCE=true` with no `*_TRUST_BUNDLES` / `*_JWKS_BUNDLES` under `NODE_ENV=production` → boot throws.
- Helm chart (`arc-helm-charts/arc/templates/secret.yaml`) refuses to render without `arcServer.secret.jwtSecret` set (MED-B).
- OpenBao image tag pinned to `2.3.1` everywhere (CI matrix, `docker-compose.yml`, helm chart) — never `:latest` (MED-I).

-----

## 4. Recommended env template

Drop into your secrets manager / sealed-secret / `.env.production`:

```bash
# core
NODE_ENV=production
JWT_SECRET=                         # openssl rand -hex 32  (32+ bytes)
DATABASE_URL=postgres://arc:***@db.internal:5432/arc

# ACL bootstrap (else Engine A is unreachable)
ARC_DEFAULT_POLICY=deny             # belt-and-braces; also the prod default
ARC_ROOT_USERS=1                    # internal user id(s) with sudo

# Web/desktop origins — replace localhost defaults
CORS_ORIGINS=https://vault.example.com,tauri://localhost
ARC_PASSKEY_RP_ID=vault.example.com
ARC_PASSKEY_RP_NAME=Acme arc
ARC_PASSKEY_ORIGIN=https://vault.example.com,tauri://localhost

# Engine A (OpenBao) — colocated container, see helm chart
BAO_ADDR=http://openbao.arc.svc.cluster.local:8200
BAO_TOKEN=                          # injected; rotate via your secrets manager

# Plugins — fail-closed by default in prod
# ARC_PLUGIN_MANIFEST=required        (prod default; uncomment only to opt out)
ARC_PLUGIN_TRUST_ANCHORS=ed25519:ZXh4...,ed25519:Yzc4...

# Persistence — never `memory` in prod
ARC_BLOB_BACKEND=s3
ARC_BLOB_S3_BUCKET=arc-blobs
ARC_BLOB_S3_REGION=us-west-2

# DO NOT SET in prod:
# ARC_ENABLE_DEV_LOGIN=true          # MED-C: refused in prod regardless
```

-----

## 5. Pre-deploy checklist

Run through this before flipping traffic. Cross-refs the audit-remediation checklist
already present in [`manual-testing/checklist.md`](manual-testing/checklist.md) (June
2026 audit row).

- [ ] `NODE_ENV=production` set in the runtime environment (not just at build).
- [ ] `JWT_SECRET` set + ≥ 32 bytes of entropy + rotated on a documented cadence.
- [ ] `DATABASE_URL` points at the prod Postgres + the role has only the perms it needs.
- [ ] `ARC_ROOT_USERS` lists the actual humans/agents who must keep working under `deny`.
- [ ] `ARC_PASSKEY_RP_ID` / `ORIGIN` match the real domain the web app is served from.
- [ ] `CORS_ORIGINS` matches the deployed web + desktop origins exactly (no `localhost`).
- [ ] `ARC_ENABLE_DEV_LOGIN` is unset in the environment (grep your secrets manager).
- [ ] `ARC_PLUGIN_MANIFEST=required` (or unset — same effect in prod).
- [ ] `ARC_PLUGIN_TRUST_ANCHORS` lists the publisher keys you've vetted.
- [ ] `ARC_BLOB_BACKEND` ≠ `memory`; the backing volume / bucket is backed up.
- [ ] OpenBao image tag is the pinned `2.3.1` (or whichever the CI matrix asserts).
- [ ] TLS in front of arc-server with HSTS; modern cipher config (doc 15 §15.5).
- [ ] Rate-limit / lockout enabled on `/vault/unlock` + directory lookups (doc 15 §15.5).
- [ ] Pino logs configured for JSON + shipped to an aggregator; no key material in the
      stream (the e2e enforces this — see the audit invariant in `vault.e2e-spec.ts`).
- [ ] `pnpm --filter @arc/server migration:show` lists every migration as `[X]` applied.
- [ ] The crypto-correctness checklist (doc 15 §15.6) is green: KAT parity, no
      forbidden patterns, recovery flow tested.
- [ ] Helm chart deployed with `arcServer.secret.jwtSecret` set (MED-B; chart refuses
      to render without it).

-----

## 6. Known caveats

These are **not** boot-time blockers but you should know they exist before scaling.

- **Lease registry is durable** as of [#113](https://github.com/ethchor/arc/issues/113).
  The arc-id → backend-id binding is persisted in Postgres (`engines/typeorm-lease-store.ts`
  + `engines/lease-sweep.service.ts`), so it survives a server restart and is shared across
  replicas — renew/revoke take a `SELECT … FOR UPDATE` row lock. No single-node restriction
  anymore; just point every replica at the same `DATABASE_URL`.
- **`ARC_BLOB_BACKEND=memory`** loses every attachment on restart. The default is `memory`
  so a brand-new dev install works without setup; fail closed by treating any prod
  config with `memory` as a bug.
- **Audit retention** is currently unbounded — see doc 11 for the minimization story;
  rotation/retention policy is per-deployer (your SIEM, not arc).

-----

## 7. See also

- [`15-testing-review-and-operations.md`](15-testing-review-and-operations.md) §15.5 +
  §15.6 — the crypto-correctness side of "ready for prod".
- [`manual-testing/checklist.md`](manual-testing/checklist.md) — feature-by-feature
  smoke + the audit-remediation regression list (24/24 findings).
- [`manual-testing/06-grants-acl.md`](manual-testing/06-grants-acl.md) — the deny-mode
  bootstrap dance (root user → policies → attach).
- [`../infra/arc-helm-charts/arc/README.md`](../infra/arc-helm-charts/arc/README.md) —
  the chart that bakes most of this in for you.
