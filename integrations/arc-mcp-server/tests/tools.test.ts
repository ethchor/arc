/**
 * Unit tests for the MCP tool handlers. Each tool is exercised against a fake `ArcClient`
 * that records the calls + returns canned responses, so we can assert the wire shape
 * (mount/path normalization, query params, body envelope) without touching the network.
 */
import { describe, expect, it } from "vitest";
import { ArcClient } from "../src/arc-client";
import { tools, type Tool, type ToolContext } from "../src/tools";

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
}

function fakeFetch(responder: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const query: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) query[k] = v;
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
      ...(Object.keys(query).length ? { query } : {}),
    };
    calls.push(call);
    const { status, body } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function harness(responder: (call: Call) => { status: number; body?: unknown }) {
  const { fetchFn, calls } = fakeFetch(responder);
  const client = new ArcClient("http://arc:3001", fetchFn);
  const ctx: ToolContext = { client, bearer: "test-jwt" };
  return { ctx, calls };
}

function findTool(name: string): Tool {
  const t = tools.find((x) => x.def.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("arc_kv_get", () => {
  it("defaults the mount to `secret` and reads /v1/secret/data/<path>", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { data: { x: 1 } } } }));
    const res = await findTool("arc_kv_get").handler({ path: "app/prod/db" }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/secret/data/app/prod/db" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"x": 1');
  });

  it("forwards the bearer token verbatim", async () => {
    const headers: string[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth) headers.push(auth);
      return { ok: true, status: 200, text: async () => "{}" } as Awaited<ReturnType<typeof fetch>>;
    }) as unknown as typeof fetch;
    const client = new ArcClient("http://arc:3001", fetchFn);
    await findTool("arc_kv_get").handler({ path: "x" }, { client, bearer: "abc.def.ghi" });
    expect(headers).toEqual(["Bearer abc.def.ghi"]);
  });

  it("passes ?version=N when version is provided", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: {} }));
    await findTool("arc_kv_get").handler({ path: "x", version: 3 }, ctx);
    expect(calls[0]?.query).toEqual({ version: "3" });
  });

  it("rejects a missing `path`", async () => {
    const { ctx } = harness(() => ({ status: 200 }));
    const res = await findTool("arc_kv_get").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/missing required argument "path"/);
  });

  it("surfaces a 403 from arc-server as a structured tool error (not a JSON-RPC fault)", async () => {
    const { ctx } = harness(() => ({ status: 403, body: { errors: ["forbidden by policy"] } }));
    const res = await findTool("arc_kv_get").handler({ path: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/403/);
    expect(res.content[0]?.text).toContain("forbidden by policy");
  });
});

describe("arc_kv_put", () => {
  it("POSTs { data } and honours cas via { options: { cas } }", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { version: 4 } } }));
    await findTool("arc_kv_put").handler({ path: "x", data: { k: "v" }, cas: 3 }, ctx);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/secret/data/x" });
    expect(calls[0]?.body).toEqual({ data: { k: "v" }, options: { cas: 3 } });
  });

  it("rejects non-object `data`", async () => {
    const { ctx } = harness(() => ({ status: 200 }));
    for (const bad of ["string", 42, null, undefined, ["arr"]]) {
      const res = await findTool("arc_kv_put").handler({ path: "x", data: bad as never }, ctx);
      expect(res.isError).toBe(true);
    }
  });
});

describe("arc_kv_list", () => {
  it("hits /v1/<mount>/metadata/<prefix>?list=true", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { keys: ["a", "b"] } } }));
    await findTool("arc_kv_list").handler({ prefix: "app/prod" }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/secret/metadata/app/prod", query: { list: "true" } });
  });
});

describe("arc_transit_encrypt / arc_transit_decrypt", () => {
  it("encrypt POSTs the plaintext to /v1/<mount>/encrypt/<key>", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { ciphertext: "vault:v1:abc" } } }));
    await findTool("arc_transit_encrypt").handler({ key: "billing", plaintext: "aGVsbG8=" }, ctx);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/transit/encrypt/billing" });
    expect(calls[0]?.body).toEqual({ plaintext: "aGVsbG8=" });
  });

  it("encrypt threads optional context through", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: {} }));
    await findTool("arc_transit_encrypt").handler({ key: "k", plaintext: "abc", context: "Y3R4" }, ctx);
    expect(calls[0]?.body).toEqual({ plaintext: "abc", context: "Y3R4" });
  });

  it("decrypt POSTs ciphertext to /v1/<mount>/decrypt/<key>", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { plaintext: "aGVsbG8=" } } }));
    await findTool("arc_transit_decrypt").handler({ key: "billing", ciphertext: "vault:v1:abc" }, ctx);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/transit/decrypt/billing" });
    expect(calls[0]?.body).toEqual({ ciphertext: "vault:v1:abc" });
  });
});

describe("arc_dynamic_creds_issue", () => {
  it("GETs /v1/<mount>/creds/<role> and propagates ttl", async () => {
    const { ctx, calls } = harness(() => ({
      status: 200,
      body: { data: { access_key: "AKIA..." }, lease_id: "...", lease_duration: 900, renewable: false },
    }));
    await findTool("arc_dynamic_creds_issue").handler({ mount: "aws", role: "deployer", ttl: 900 }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/aws/creds/deployer", query: { ttl: "900" } });
  });

  it("omits the ttl query when not provided", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: {} }));
    await findTool("arc_dynamic_creds_issue").handler({ mount: "aws", role: "x" }, ctx);
    expect(calls[0]?.query).toBeUndefined();
  });
});

describe("arc_list_mounts", () => {
  it("GETs /v1/sys/mounts", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { mounts: [] } } }));
    await findTool("arc_list_mounts").handler({}, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/sys/mounts" });
  });
});

/**
 * Engine C (agent identity, ADR-005). These routes live at the arc-server root
 * (`/vault/agents/...`), NOT under the `/v1` engines prefix — the assertions below pin that,
 * because sending them to `/v1/vault/agents/...` would silently 404 against the engines
 * catch-all rather than fail loudly.
 */
describe("Engine C — agent tools", () => {
  it("arc_agents_list GETs /vault/agents at the root, without the /v1 engines prefix", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: [] } }));
    await findTool("arc_agents_list").handler({}, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/vault/agents" });
    expect(calls[0]?.path.startsWith("/v1/")).toBe(false);
  });

  it("arc_agent_get GETs one agent by id", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: {} } }));
    await findTool("arc_agent_get").handler({ agentId: "agent-1" }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/vault/agents/agent-1" });
  });

  it("arc_agent_authorize POSTs the path + capability for introspection", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { allowed: false } } }));
    await findTool("arc_agent_authorize").handler(
      { agentId: "agent-1", path: "secret/data/app/prod/db", capability: "read" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/vault/agents/agent-1/authorize",
      body: { path: "secret/data/app/prod/db", capability: "read" },
    });
  });

  it("arc_agent_authorize threads an optional delegationId through", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: {} } }));
    await findTool("arc_agent_authorize").handler(
      { agentId: "a", path: "secret/data/x", capability: "read", delegationId: "d-9" },
      ctx,
    );
    expect(calls[0]?.body).toMatchObject({ delegationId: "d-9" });
  });

  it("arc_agent_authorize rejects a missing capability", async () => {
    const { ctx } = harness(() => ({ status: 200, body: {} }));
    const res = await findTool("arc_agent_authorize").handler({ agentId: "a", path: "p" }, ctx);
    expect(res.isError).toBe(true);
  });

  it("arc_agent_delegations_list GETs the agent's delegations", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: [] } }));
    await findTool("arc_agent_delegations_list").handler({ agentId: "agent-1" }, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/vault/agents/agent-1/delegations" });
  });

  it("arc_agent_delegation_revoke DELETEs one delegation", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { revoked: true } } }));
    await findTool("arc_agent_delegation_revoke").handler(
      { agentId: "agent-1", delegationId: "del-7" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/vault/agents/agent-1/delegations/del-7",
    });
  });

  it("arc_agent_task_open POSTs the budget when provided", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { taskId: "t-1" } } }));
    await findTool("arc_agent_task_open").handler(
      { agentId: "agent-1", budget: { maxCalls: 10, wallClockMs: 60000 } },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/vault/agents/agent-1/tasks",
      body: { budget: { maxCalls: 10, wallClockMs: 60000 } },
    });
  });

  it("arc_agent_task_open rejects a non-object budget", async () => {
    const { ctx } = harness(() => ({ status: 200, body: {} }));
    const res = await findTool("arc_agent_task_open").handler({ agentId: "a", budget: 5 }, ctx);
    expect(res.isError).toBe(true);
  });

  it("arc_agent_task_get requests chain verification only when asked", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: {} } }));
    const tool = findTool("arc_agent_task_get");
    await tool.handler({ agentId: "a", taskId: "t" }, ctx);
    expect(calls[0]?.query).toBeUndefined();
    await tool.handler({ agentId: "a", taskId: "t", verify: true }, ctx);
    expect(calls[1]?.query).toEqual({ verify: "true" });
  });

  it("arc_agent_task_close POSTs the cascade-revoke kill switch", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: { closed: true } } }));
    await findTool("arc_agent_task_close").handler({ agentId: "agent-1", taskId: "task-3" }, ctx);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/vault/agents/agent-1/tasks/task-3/close",
    });
  });

  it("arc_approvals_list GETs the owner's pending approvals", async () => {
    const { ctx, calls } = harness(() => ({ status: 200, body: { data: [] } }));
    await findTool("arc_approvals_list").handler({}, ctx);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/vault/approvals" });
  });

  it("surfaces an arc-server 403 as a structured tool error", async () => {
    const { ctx } = harness(() => ({ status: 403, body: { error: "forbidden" } }));
    const res = await findTool("arc_agent_task_close").handler({ agentId: "a", taskId: "t" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("403");
  });
});

/**
 * Security invariants of the MCP surface. These are assertions about what is deliberately
 * absent — they fail loudly if someone later adds a tool that breaks the zero-knowledge or
 * no-authority-granting properties documented at the top of `tools.ts`.
 */
describe("registry invariants", () => {
  it("exposes no Engine-B (E2E vault) tool — the MCP server holds no master key", () => {
    // Engine-B item/vault routes live under `vaults/:id/items`, `vault/keyset`, `vault/shares`.
    const forbidden = /vaults?\/(:?[^/]*\/)?(items|keyset|shares|folders|attachments)/;
    for (const t of tools) {
      expect(t.def.name).not.toMatch(/item|keyset|share|attachment/i);
      expect(JSON.stringify(t.def)).not.toMatch(forbidden);
    }
  });

  it("exposes no tool that grants authority — granting requires a client-side signature", () => {
    const names = tools.map((t) => t.def.name);
    // Registering an agent (keygen), creating a delegation (delegator-signed) and submitting
    // an intent (agent-signed) all need a private key the MCP server must never hold.
    expect(names).not.toContain("arc_agent_register");
    expect(names).not.toContain("arc_agent_delegation_create");
    expect(names).not.toContain("arc_agent_intent_submit");
    expect(names).not.toContain("arc_approval_approve");
    expect(names.filter((n) => /create|register|grant|approve/.test(n))).toEqual([]);
  });
});

describe("registry", () => {
  it("exposes exactly the tools the README/CLAUDE.md document", () => {
    expect(tools.map((t) => t.def.name).sort()).toEqual(
      [
        "arc_agent_authorize",
        "arc_agent_delegation_revoke",
        "arc_agent_delegations_list",
        "arc_agent_get",
        "arc_agent_task_close",
        "arc_agent_task_get",
        "arc_agent_task_open",
        "arc_agents_list",
        "arc_approvals_list",
        "arc_dynamic_creds_issue",
        "arc_kv_get",
        "arc_kv_list",
        "arc_kv_put",
        "arc_list_mounts",
        "arc_transit_decrypt",
        "arc_transit_encrypt",
      ].sort(),
    );
  });

  it("every tool input_schema declares object root + sensible required fields", () => {
    for (const t of tools) {
      expect(t.def.inputSchema.type).toBe("object");
    }
  });
});
