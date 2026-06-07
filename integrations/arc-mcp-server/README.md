# `@arc/mcp-server`

arc exposed over the [Model Context Protocol](https://modelcontextprotocol.io). Lets any
MCP-capable agent authenticate with an arc JWT and call **infrastructure-secret operations**
as MCP tools — fetch a secret, mint a dynamic credential, encrypt via transit — each
authorized by `@arc/grants` and recorded in the audit log on the arc-server side.

The E2E vault (Engine B) is intentionally **not** exposed: the server stores ciphertext only
and the master key never leaves the human client. Tools cover Engine A only.

## Tools

| Tool                       | Verb | arc-server path |
|----------------------------|------|------|
| `arc_kv_get`               | read | `GET /v1/<mount>/data/<path>` |
| `arc_kv_put`               | write | `POST /v1/<mount>/data/<path>` |
| `arc_kv_list`              | list | `GET /v1/<mount>/metadata/<prefix>?list=true` |
| `arc_transit_encrypt`      | encrypt | `POST /v1/<mount>/encrypt/<key>` |
| `arc_transit_decrypt`      | decrypt | `POST /v1/<mount>/decrypt/<key>` |
| `arc_dynamic_creds_issue`  | issue | `GET /v1/<mount>/creds/<role>` |
| `arc_list_mounts`          | discover | `GET /v1/sys/mounts` |

## Running

```sh
# point at your arc-server, pick a port
ARC_SERVER_URL=https://arc.example.com PORT=8800 pnpm --filter @arc/mcp-server start
```

In Kubernetes, run it alongside `arc-server` as a separate Deployment (the helm chart will
ship a sub-template once this lands in `infra/arc-helm-charts`).

## Auth flow

1. Agent obtains an arc JWT via one of the auth methods on arc-server, e.g.
   `POST /v1/auth/oidc/login { role: "ci", jwt: "<oidc-id-token>" }` (OIDC plugin) or
   `POST /v1/auth/kubernetes/login { role: "deployer", jwt: "<sa-token>" }`
   (Kubernetes plugin).
2. Agent connects to this server with `Authorization: Bearer <arc-jwt>`.
3. The server forwards the bearer to arc-server on every tool dispatch. `JwtAuthGuard` +
   `CapabilityGuard` gate the call against the policies attached to the agent's identity.

## Trust boundary

This service is a **protocol adapter**, not a policy decision point. It does not parse the
JWT and does not maintain a session. The authorization decision is always made by arc-server
against `@arc/grants`. If the agent's policy doesn't cover the path, arc-server returns 403
and the MCP tool result carries `isError: true` with the underlying error.

## Testing

```sh
pnpm --filter @arc/mcp-server test
```

Twenty-plus unit tests cover the tool handlers with a fake `fetch`; three integration tests
boot the real HTTP server and drive it with the MCP SDK's `Client` over `StreamableHTTP`.
