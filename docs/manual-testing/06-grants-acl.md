# 06 — Per-mount ACL + admin API

`@arc/grants` is the policy engine guarding `/v1/*`. The `CapabilityGuard` runs after
the JWT guard, maps HTTP method → capability, asks the engine, and 403s on deny. This
guide walks through bootstrapping a fail-closed deployment and managing policies via the
admin HTTP API.

> **Set `ARC_ENABLE_DEV_LOGIN=true` once in your shell before walking through this
> scenario** — every `curl /auth/dev-login` in the recipes below depends on it.

## A. Default mode

The default is **env-aware** (CRIT-B from the supply-chain audit). When
`ARC_DEFAULT_POLICY` is unset:

| `NODE_ENV` | Behavior when subject has zero policies |
|---|---|
| any non-production value (or unset) | **Allow** — dev/test posture |
| `production` | **Deny** — fail-closed |

`ARC_DEFAULT_POLICY=allow` / `ARC_DEFAULT_POLICY=deny` (case-insensitive) always wins
over the env-aware default. In both modes, *any* attached policy switches that subject
to strict enforcement: the default never overrides explicit policies.

## B. Fail-closed bootstrap (the production-realistic flow)

Without a bootstrap, `deny` mode would lock everyone out of `/v1/sys/policy` and the
ACL surface couldn't be administered. `ARC_ROOT_USERS` solves that: a comma-separated
list of user ids that get a sudo policy on first boot.

```bash
# Stop arc-server, then:
export ARC_DEFAULT_POLICY=deny
export ARC_ROOT_USERS=1            # the first user id created via /auth/dev-login
export ARC_ENABLE_DEV_LOGIN=true   # MED-C: required to use /auth/dev-login at all
pnpm --filter @arc/server start
```

**Important:** the user-id-to-email mapping is allocated in the order users dev-login.
Whoever logs in first is user id 1 — make sure that's you (the operator).

```bash
export ROOT_TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"root@example.com"}' | jq -r .accessToken)
# root user is now user id 1, with the sudo "root" policy auto-attached
```

Verify root can reach the admin API:

```bash
curl http://localhost:3001/v1/sys/policy -H "Authorization: Bearer $ROOT_TOKEN" | jq
# → { "data": [ { "name": "root", "scopes": [{"pathPrefix": "", "capabilities": ["sudo"]}], ... } ] }
```

A second user with no attached policies hits 403 on every `/v1/*`:

```bash
export APP_TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"app@example.com"}' | jq -r .accessToken)
curl http://localhost:3001/v1/sys/mounts -H "Authorization: Bearer $APP_TOKEN" -i
# → 403 with reason "no-policies"
```

## C. Create + attach a policy

```bash
# Decode the app user's id from the JWT
APP_USER_ID=$(echo "$APP_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .sub)
# (If `base64 -d` complains about padding, use `base64 --decode -i` or pipe through awk.)
echo "app user id is $APP_USER_ID"

# Root creates a "secret-reader" policy:
curl -X POST http://localhost:3001/v1/sys/policy \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "secret-reader",
    "scopes": [
      { "pathPrefix": "secret/", "capabilities": ["read", "list"] }
    ]
  }' | jq

# Root attaches it to the app user:
curl -X POST http://localhost:3001/v1/sys/policy/secret-reader/attach \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"subject\":\"$APP_USER_ID\"}" | jq
```

The app user can now read under `secret/` but nothing else:

```bash
curl http://localhost:3001/v1/secret/data/foo -H "Authorization: Bearer $APP_TOKEN" -i
# → 200 (or 404 if no value yet — but NOT 403)

curl http://localhost:3001/v1/secret/data/foo -X DELETE \
  -H "Authorization: Bearer $APP_TOKEN" -i
# → 403 (read-only)

curl http://localhost:3001/v1/database/creds/x -H "Authorization: Bearer $APP_TOKEN" -i
# → 403 (uncovered path)
```

## D. List capability vs. read capability

`?list=true` requires the `list` capability — `read` alone isn't enough:

```bash
# Replace the above policy with read-only (no list):
curl -X POST http://localhost:3001/v1/sys/policy \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"secret-reader","scopes":[{"pathPrefix":"secret/","capabilities":["read"]}]}'

curl -G http://localhost:3001/v1/secret/metadata/foo --data-urlencode "list=true" \
  -H "Authorization: Bearer $APP_TOKEN" -i
# → 403 (list capability missing)
```

## E. Detach + delete

```bash
curl -X POST http://localhost:3001/v1/sys/policy/secret-reader/detach \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"subject\":\"$APP_USER_ID\"}" -i
# → 204

curl -X DELETE http://localhost:3001/v1/sys/policy/secret-reader \
  -H "Authorization: Bearer $ROOT_TOKEN" -i
# → 204
```

## F. Cache behavior (`ARC_POLICY_CACHE_TTL_MS`)

The store is wrapped in a `CachingPolicyStore` (default 30s TTL per subject). Mutations
through the admin API invalidate the right entries so attach/detach takes effect on the
*very next* request, but DB-direct edits (e.g. a manual SQL `UPDATE`) wait for the TTL.

Lower the TTL for testing:

```bash
ARC_POLICY_CACHE_TTL_MS=0 pnpm --filter @arc/server start
# 0 = cache disabled; every /v1/* request hits the DB
```

## G. Validation: ACL protects itself

A non-root user can't grant themselves a policy:

```bash
curl -X POST http://localhost:3001/v1/sys/policy \
  -H "Authorization: Bearer $APP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"sneaky","scopes":[{"pathPrefix":"","capabilities":["sudo"]}]}' -i
# → 403
```

A malformed policy (unknown capability) is rejected at 400, not stored:

```bash
curl -X POST http://localhost:3001/v1/sys/policy \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"bad","scopes":[{"pathPrefix":"x/","capabilities":["frobnicate"]}]}' -i
# → 400
```

## H. Engine-B is unaffected

Per-mount ACL only gates `/v1/*`. The Engine-B vault API (`/vaults`, `/vault/*`) has its
own membership-based authorization in `VaultService` — a fresh user under `deny` mode
can still:

```bash
curl http://localhost:3001/vaults -H "Authorization: Bearer $APP_TOKEN" -i
# → 200 (empty list — but not 403)
```

So Engine-A locks down hard while Engine-B remains a normal multi-tenant consumer surface.
