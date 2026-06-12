# 09 — Troubleshooting

When something fails, the symptom usually points back to one of a small set of root
causes. This page maps the common ones.

## "Cannot find module '@arc/...'" at runtime

The CJS-published packages are `dist`-only. If you skipped `pnpm -r build` they don't
exist on disk, so Jest's `moduleNameMapper` (which points at the `dist/index.cjs` files)
can't resolve them.

```bash
pnpm -r build
```

`turbo build` is wired to `^build` in `turbo.json` — packages build in dep order. If a
single package failed, run `pnpm --filter <name> build` for the focused error.

## arc-server boot — `DATABASE_URL is required when NODE_ENV=production`

Boot-time guard refuses to start in `production` mode without a real database. Either:

- Set `DATABASE_URL` (Postgres URL).
- Or unset `NODE_ENV` — dev defaults to sql.js in-memory.

## arc-server boot — `JWT_SECRET not set; using an ephemeral random secret (dev/test only)`

Warning only; tokens are valid for the lifetime of the process but lost on restart. Set
`JWT_SECRET=<a long random string>` to persist sessions across restarts.

## `/v1/sys/seal-status` returns 503 even though OpenBao is running

The arc-server process didn't see `BAO_ADDR` at boot. Restart with it set:

```bash
BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root pnpm --filter @arc/server start
```

Mount registration happens once at boot — there's no live re-read of env vars.

## `/v1/secret/data/x` returns 404 (not 503) without BAO_ADDR

Working as intended. Mount resolution is independent of the OpenBao client (so
plugin-only deployments are valid); paths without a mount return 404. The 503 path is
reserved for the explicit OpenBao proxies (`/v1/sys/seal-status`, `/v1/sys/health`).

## "401 (no session)" on `/v1/*`

JWT missing / expired. Re-run `/auth/dev-login` — and make sure
`ARC_ENABLE_DEV_LOGIN=true` is exported in the server's environment, otherwise the
endpoint itself returns `403 dev_login_disabled` (MED-C). In dev the token has a 24h
lifetime.

## "403 dev_login_disabled" on `/auth/dev-login`

The MED-C audit remediation made the endpoint opt-in even in dev. Restart `arc-server`
with `ARC_ENABLE_DEV_LOGIN=true` set. The endpoint is always force-disabled when
`NODE_ENV=production`, regardless of the env var — use a real OAuth IdP there.

## "401 agent_token_revoked" on `POST /vault/agents/:id/intents`

The agent's JWT was minted before a `closeTask()` bumped the agent's `tokenEpoch`
(HIGH-C). Re-run the challenge-response on `POST /vault/agents/:id/auth/token` to mint
a fresh JWT at the new epoch.

## "409 intent_chain_mismatch" on `POST /vault/agents/:id/intents`

The agent signed `claims.prevChainHead` against a stale view of the chain (MED-E). The
response body carries `expected` (server's current head) and `observed` (the value the
agent signed). Fix the agent's local chain tracker and re-sign.

## "400 argon_below_floor" on `/vault/enroll` or `/vault/keyset/recover`

The client uploaded `argonParams` weaker than the server's floor (LOW-B). Production
default floor is the mobile profile (`m ≥ 64 MiB, t ≥ 2`); non-prod drops to `m ≥ 128
KiB, t ≥ 1` so the test profile works. Either upgrade the client's argon profile, or
override via `ARC_ARGON_MIN_M` / `ARC_ARGON_MIN_T` on the server side.

## "403 access denied: read on sys/mounts" under `ARC_DEFAULT_POLICY=deny`

The user has no policies attached. Either:

- Use `ARC_ROOT_USERS` to bootstrap a sudo subject (see
  [`06-grants-acl.md`](06-grants-acl.md) §B), then attach policies via the admin API.
- Or set `ARC_DEFAULT_POLICY=allow` for dev. (Reminder: the prod default is `deny`
  under `NODE_ENV=production` — CRIT-B.)

## Passkey register returns "authenticator did not return a PRF output"

The browser / authenticator doesn't support the WebAuthn PRF extension. Chrome 116+ /
Safari 17+ ship it; Firefox doesn't yet. Use a supported browser, or test via the SDK
with a Node-side fake authenticator (see `apps/arc-server/test/sdk-passkey.e2e-spec.ts`).

## Passkey unlock returns 401 "passkey counter regression"

Anti-clone check fired — the authenticator's reported signature counter went backwards
relative to what the server has stored. Real cause is almost always a cloned
authenticator. Test cause: the test rewound the counter on purpose. In production this
should never happen with a single legitimate authenticator.

## SDK passkey unlock throws on `unwrapIdentityFromPasskey`

AAD / wrap key mismatch — usually means the user's PRF salt got out of sync (the salt is
per-user-stable; if the DB was wiped after register but the credential is still on the
authenticator, the salts won't line up). Re-register the passkey.

## OpenBao smoke tests stay skipped

The `describe.skipIf(!process.env.BAO_ADDR)` guard skips live tests when there's no
backend. Bring OpenBao up and re-run with `BAO_ADDR` set:

```bash
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d
BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root pnpm --filter @arc/openbao-adapter test
```

## Plugin mount fails with `BadRequestException: aws plugin config requires a 'roles' map`

The `configure()` step rejected the config. The error message is precise — typos in the
config object are the usual cause. Check the role schema in
`plugins/cloud/arc-plugin-aws/src/types.ts`. A failed mount leaves the plugin
*unregistered* (the host rolls back), so you can retry with a corrected config.

## "MODULE_NOT_FOUND: Cannot find module 'google-auth-library'" when importing `@arc/plugin-gcp/aws-sdk`

The SDK-backed default client lives behind an optional peer dep. Install it explicitly
when you actually use the default:

```bash
pnpm --filter @arc/plugin-gcp add google-auth-library
```

(Or pass your own `IamCredentialsClient` and skip the import entirely.)

## Web UI shows "Failed to fetch" right after sign-in

CORS — the web app and arc-server are on different ports. By default arc-server allows
the dev origin; if you changed the web port or run the server behind a proxy, you'll
need to update its CORS config. The dev server enables it automatically; production
config is set per-deployment.

## Test suites fail flakily under load

`jest --runInBand` already serializes the arc-server suite (which boots full Nest apps
per `describe`). If you parallelize manually with `--maxWorkers`, expect port + sql.js
contention. Stick to `--runInBand` for arc-server e2e.
