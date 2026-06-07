# arc-mcp-server — agent context

**Scope.** Stateless HTTP service that exposes arc-server's Engine-A surface (KV v2, transit,
dynamic credentials, sys/mounts) as **Model Context Protocol** tools. Any MCP-capable agent
authenticates with an arc JWT (obtained via the OIDC / Kubernetes auth methods in
`@arc/plugin-{oidc,kubernetes}` → `POST /v1/auth/<mount>/login`) and calls `tools/list` and
`tools/call` over Streamable HTTP.

**Trust model.** The MCP server is **not** the authorization decision point — it forwards the
agent's bearer to arc-server verbatim, and `JwtAuthGuard` + `CapabilityGuard` (against
`@arc/grants`) gate every call. The bearer is captured per-request at connection time so
concurrent requests from different agents can never share a token.

**Engine B is not exposed.** The E2E vault is zero-knowledge: the server has only ciphertext,
and the master key never leaves the human client. Surfacing Engine B over MCP would
fundamentally break that property; do not add Engine-B tools here.

**Deps rule.** Workspace deps are none. External runtime dep is the official
`@modelcontextprotocol/sdk` only — arc-server's REST API is reached through plain `fetch`. Do
not import `@arc/server` or any arc-server-internal package: arc-mcp-server is an
*integration*, not a server-internal module.

**Transport.** Streamable HTTP, stateless mode. `POST /mcp` for the JSON-RPC surface (the
SDK handles transport framing). `GET /healthz` for liveness. Sessions / SSE notifications are
not used today (tool-only server); if they're added, capture the bearer at session create.
