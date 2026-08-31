# arc-mcp-server — agent context

**Scope.** Stateless HTTP service that exposes arc-server's Engine-A surface (KV v2, transit,
dynamic credentials, sys/mounts) and its Engine-C agent-identity control plane (agents,
delegations, tasks, approvals) as **Model Context Protocol** tools. Any MCP-capable agent
authenticates with an arc JWT (obtained via the OIDC / Kubernetes / SPIFFE auth methods in
`@arc/plugin-{oidc,kubernetes,spiffe}` → `POST /v1/auth/<mount>/login`) and calls `tools/list`
and `tools/call` over Streamable HTTP.

**Route prefixes.** Engine-A tools target `/v1/*`; Engine-C controllers are mounted at the
arc-server **root** (`vault/agents/*`, `vault/approvals/*`). `ArcClient` defaults to `/v1` —
pass `{ root: true }` for Engine-C, or the call silently hits the engines catch-all.

**Trust model.** The MCP server is **not** the authorization decision point — it forwards the
agent's bearer to arc-server verbatim, and `JwtAuthGuard` + `CapabilityGuard` (against
`@arc/grants`) gate every call. The bearer is captured per-request at connection time so
concurrent requests from different agents can never share a token.

**Engine B is not exposed.** The E2E vault is zero-knowledge: the server has only ciphertext,
and the master key never leaves the human client. Surfacing Engine B over MCP would
fundamentally break that property; do not add Engine-B tools here.

**Engine C is read + revoke only.** Registering an agent (client-side keygen), creating a
delegation (delegator-signed), submitting an intent (agent-signed) and approving one
(WebAuthn) all require a private key this server must never hold. So the Engine-C tools can
*inspect* authority (`arc_agent_authorize`) and *remove* it (`arc_agent_delegation_revoke`,
`arc_agent_task_close`) but can never grant it. Both invariants are pinned by tests in
`tests/tools.test.ts` → `describe("registry invariants")`; if you add a tool that trips them,
that is the design telling you no, not a failing test to update.

**Deps rule.** Workspace deps are none. External runtime dep is the official
`@modelcontextprotocol/sdk` only — arc-server's REST API is reached through plain `fetch`. Do
not import `@arc/server` or any arc-server-internal package: arc-mcp-server is an
*integration*, not a server-internal module.

**Transport.** Streamable HTTP, stateless mode. `POST /mcp` for the JSON-RPC surface (the
SDK handles transport framing). `GET /healthz` for liveness. Sessions / SSE notifications are
not used today (tool-only server); if they're added, capture the bearer at session create.
