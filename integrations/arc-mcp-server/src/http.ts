/**
 * HTTP front-end for the arc MCP server.
 *
 * Layout:
 *  - `GET  /healthz`   — liveness; no auth required.
 *  - `POST /mcp`       — MCP Streamable HTTP endpoint. Authorization: Bearer <jwt> is
 *                         required; the bearer is forwarded verbatim to arc-server.
 *
 * Each request creates a fresh `Server` + `StreamableHTTPServerTransport` pair bound to that
 * request's bearer — so concurrent requests never share the captured token.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { ArcClient } from "./arc-client.js";
import { buildArcMcpServer } from "./server.js";

export interface HttpOptions {
  /** Base URL of arc-server, e.g. http://arc-server:3001. */
  arcServerUrl: string;
  /** Optional fetch override (tests inject a fake). */
  fetchFn?: typeof fetch;
}

export function createArcMcpHttpServer(opts: HttpOptions): HttpServer {
  const client = new ArcClient(opts.arcServerUrl, opts.fetchFn);

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        respondJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "POST" && (req.url === "/mcp" || req.url?.startsWith("/mcp?"))) {
        await handleMcp(req, res, client);
        return;
      }
      respondJson(res, 404, { error: "not found" });
    } catch (err) {
      // Last-resort guard so a handler crash doesn't tear down the process.
      if (!res.headersSent) respondJson(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, client: ArcClient): Promise<void> {
  const bearer = extractBearer(req.headers.authorization);
  if (!bearer) {
    res.setHeader("WWW-Authenticate", "Bearer realm=\"arc\"");
    respondJson(res, 401, { error: "Authorization: Bearer <token> required" });
    return;
  }

  const server = buildArcMcpServer({ client, bearer });
  // Stateless mode (`sessionIdGenerator: undefined`): each POST is self-contained, no
  // `Mcp-Session-Id` correlation, no SSE notifications. Right for a tool-only adapter where
  // every request brings its own bearer + ephemeral server instance.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function extractBearer(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
