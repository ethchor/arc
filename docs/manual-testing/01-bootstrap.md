# 01 — Bootstrap the local stack

End state of this section: `arc-server` running on `:3001`, the web UI on `:3000`, and
(optionally) OpenBao on `:8200`. Three terminal windows, ~3 minutes.

## 1. Install + build

```bash
git clone https://github.com/ethchor/arc.git
cd arc
pnpm install
pnpm build            # turbo handles the dep graph; ~90s clean, ~10s incremental
```

If `pnpm build` fails, run `pnpm typecheck` to isolate the failing package.

## 2. Start arc-server

Terminal A:

```bash
ARC_ENABLE_DEV_LOGIN=true pnpm --filter @arc/server start
```

Defaults (when `NODE_ENV` is not `production`): sql.js in-memory DB (data lives only as
long as the process), `ARC_DEFAULT_POLICY=allow`, JWT secret freshly random per boot,
plugin manifests optional, Engine-A disabled (no `BAO_ADDR`). Logs come out in
pretty-printed pino format.

`ARC_ENABLE_DEV_LOGIN=true` is the MED-C opt-in that lets `/auth/dev-login` work in dev;
without it the endpoint 403s even in non-production so deploys that forgot `NODE_ENV`
can't accidentally ship a "log in as anyone" RPC. Every manual-test scenario below uses
dev-login, so this is the one env var you reliably need.

Verify it's up:

```bash
curl http://localhost:3001/v1/sys/mounts -H "Authorization: Bearer fake" -i
# → 401 (no session) — proves auth + Engine-A routing both exist
```

### Optional — Postgres backing store

If you want data to persist across restarts:

```bash
docker run --rm -d --name arc-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=arc -e POSTGRES_DB=arc postgres:16
DATABASE_URL=postgres://postgres:arc@127.0.0.1:5432/arc pnpm --filter @arc/server start
```

Set `NODE_ENV=production` too if you want the strict prod profile (migrations only, no
synchronize). The init schema (`1717200000000-init-schema.ts`) plus the grants
(`1717300000000-grants-schema.ts`) and passkey (`1717400000000-passkey-schema.ts`)
migrations all run automatically.

## 3. Start the web UI

Terminal B:

```bash
pnpm --filter @arc/vault-web dev
# Next.js dev server on http://localhost:3002
```

Open `http://localhost:3002` — you should see the **Sign in** screen. The default base
URL `http://localhost:3001` matches Terminal A.

## 4. (Optional) Start OpenBao for Engine-A

Terminal C:

```bash
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d
# OpenBao dev mode listens on :8200 with root token "root"

# point arc-server at it and restart Terminal A
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN=root
pnpm --filter @arc/server start
```

Verify Engine-A:

```bash
# from any logged-in client (see 02-engine-b-vault.md for getting a token):
curl http://localhost:3001/v1/sys/mounts -H "Authorization: Bearer $TOKEN"
# → {"data":[{"path":"secret/","type":"kv-v2",...},{"path":"transit/",...},{"path":"pki/",...},{"path":"database/",...}]}
```

## 5. (Optional) Run the CLI against this server

```bash
node apps/arc-cli/dist/bin.js --base-url http://localhost:3001 --help
```

The CLI exposes the same operations the web UI uses; full command map in
[`07-cli.md`](07-cli.md).

## What's running now

```
:3001  arc-server      (NestJS / TypeORM / sql.js or Postgres / pino)
:3002  arc-vault-web   (Next.js dev)
:8200  OpenBao         (dev mode; optional, gates Engine-A surface)
```

Next: [`02-engine-b-vault.md`](02-engine-b-vault.md).
