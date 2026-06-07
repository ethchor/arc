/**
 * End-to-end HTTP test: boots the real arc-mcp-server on a random port, with a fake fetch
 * standing in for arc-server. Drives it with the MCP SDK Client over Streamable HTTP and
 * asserts: tools/list returns the seven tools, tools/call(arc_kv_get) round-trips through
 * the fake arc-server, and a request with no Authorization header is rejected with 401.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArcMcpHttpServer } from "../src/http";

const calls: { url: string; headers: Record<string, string>; body?: unknown }[] = [];

const fakeFetch = (async (url: string, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[k.toLowerCase()] = v;
  }
  calls.push({
    url,
    headers,
    ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
  });
  // Canned arc-server response for the one route the test triggers.
  const body = { data: { data: { db_url: "postgres://..." }, metadata: { version: 2 } } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Awaited<ReturnType<typeof fetch>>;
}) as unknown as typeof fetch;

describe("arc-mcp-server HTTP", () => {
  let port: number;
  let httpServer: ReturnType<typeof createArcMcpHttpServer>;

  beforeAll(async () => {
    httpServer = createArcMcpHttpServer({ arcServerUrl: "http://arc:3001", fetchFn: fakeFetch });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("GET /healthz returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("POST /mcp with no bearer returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("MCP client lists tools and calls arc_kv_get round-trip", async () => {
    calls.length = 0;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer agent-jwt-from-oidc-login" } },
    });
    const client = new Client({ name: "arc-mcp-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual(
      [
        "arc_dynamic_creds_issue",
        "arc_kv_get",
        "arc_kv_list",
        "arc_kv_put",
        "arc_list_mounts",
        "arc_transit_decrypt",
        "arc_transit_encrypt",
      ].sort(),
    );

    const call = await client.callTool({ name: "arc_kv_get", arguments: { path: "app/prod/db" } });
    expect(call.isError).toBeFalsy();
    const content = call.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("postgres://");

    // Verify the fake arc-server saw a properly-authenticated, properly-routed call.
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("http://arc:3001/v1/secret/data/app/prod/db");
    expect(calls[0]?.headers.authorization).toBe("Bearer agent-jwt-from-oidc-login");

    await transport.close();
  });
});
