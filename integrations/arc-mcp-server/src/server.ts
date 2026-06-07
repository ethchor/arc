/**
 * Build an MCP `Server` instance bound to a specific caller bearer token. The server is
 * **stateless** in the strict sense: each incoming HTTP request constructs a fresh `Server`
 * with the caller's bearer captured at construction, so a request from agent A can never
 * accidentally use agent B's token to dispatch a tool call.
 *
 * Tool implementations live in `./tools.ts` — this file is the wiring layer between the MCP
 * protocol (`tools/list`, `tools/call`) and the arc-server REST API.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ArcClient } from "./arc-client.js";
import { tools, type ToolContext } from "./tools.js";

export interface BuildServerOptions {
  client: ArcClient;
  /** Bearer token to forward to arc-server on every tool dispatch from this server. */
  bearer: string;
  /** Optional server identity override (mostly for tests). */
  name?: string;
  version?: string;
}

export function buildArcMcpServer(opts: BuildServerOptions): Server {
  const server = new Server(
    { name: opts.name ?? "arc-mcp-server", version: opts.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.def),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const tool = tools.find((t) => t.def.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    const ctx: ToolContext = { client: opts.client, bearer: opts.bearer };
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, ctx);
      return result;
    } catch (err) {
      // Validation / pre-flight errors (missing required arg, wrong type) — surface as a
      // tool error so the agent gets a structured response instead of a JSON-RPC fault.
      return {
        content: [{ type: "text", text: (err as Error).message }],
        isError: true,
      };
    }
  });

  return server;
}
