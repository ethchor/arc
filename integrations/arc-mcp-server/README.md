# `@arc/mcp-server`

arc exposed over the [Model Context Protocol](https://modelcontextprotocol.io). Lets any
MCP-capable agent authenticate with an arc JWT and call **infrastructure-secret operations**
as MCP tools — fetch a secret, mint a dynamic credential, encrypt via transit — plus
**Engine-C agent-identity operations**: inspect the agent fleet, ask what an agent may
actually reach, and revoke that authority. Every call is authorized by `@arc/grants` and
recorded in the audit log on the arc-server side.

Two exclusions are deliberate and load-bearing:

- **Engine B (the E2E vault) is not exposed.** The server stores ciphertext only and the
  master key never leaves the human client; exposing it here would break that property.
- **No Engine-C operation that requires a private key is exposed** — registering an agent
  (client-side keygen), creating a delegation (delegator-signed), submitting an intent
  (agent-signed) or approving one (WebAuthn). This server holds no signing key, so the
  Engine-C surface is *read + revoke*: it can tell you what an agent may do and take that
  authority away, but it cannot grant authority.

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

### Engine C — agent identity (ADR-005)

These routes are mounted at the arc-server **root**, not under `/v1`.

| Tool                            | Verb | arc-server path |
|---------------------------------|------|------|
| `arc_agents_list`               | list | `GET /vault/agents` |
| `arc_agent_get`                 | read | `GET /vault/agents/<id>` |
| `arc_agent_authorize`           | introspect | `POST /vault/agents/<id>/authorize` |
| `arc_agent_delegations_list`    | list | `GET /vault/agents/<id>/delegations` |
| `arc_agent_delegation_revoke`   | revoke | `DELETE /vault/agents/<id>/delegations/<did>` |
| `arc_agent_task_open`           | open | `POST /vault/agents/<id>/tasks` |
| `arc_agent_task_get`            | read | `GET /vault/agents/<id>/tasks/<tid>[?verify=true]` |
| `arc_agent_task_close`          | kill switch | `POST /vault/agents/<id>/tasks/<tid>/close` |
| `arc_approvals_list`            | list | `GET /vault/approvals` |

`arc_agent_authorize` answers *"what can this agent actually reach?"* — it evaluates the
effective-authority meet (delegation ∩ delegator ceiling ∩ agent ceiling) without performing
the action or consuming the delegation's call budget.

`arc_agent_task_close` is the one-shot kill switch: closing a task cascade-revokes its
delegations and every lease issued under it.

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
