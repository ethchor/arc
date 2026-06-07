/**
 * Plugin author's runtime. Wraps a {@link SecretsPlugin} instance into a JSON-RPC 2.0 loop
 * over stdio so it can be hosted out-of-process by {@link RemoteSecretsPlugin}.
 *
 * Usage from a plugin's bin entry:
 *
 *   ```ts
 *   #!/usr/bin/env node
 *   import { runSecretsPlugin } from "@arc/plugin-sdk/runtime";
 *   import { MyPlugin } from "../src";
 *
 *   runSecretsPlugin(new MyPlugin());
 *   ```
 *
 * The plugin's own logic is unchanged — it just gets called by the runtime instead of by
 * arc-server's in-process host.
 */
import type { SecretsPlugin } from "./types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * Drive `plugin` from stdin/stdout. Returns a promise that resolves when stdin closes
 * (the host disconnected) or `SIGTERM`/`SIGINT` arrives. Mostly you `await` this from a
 * top-level `main()`.
 */
export async function runSecretsPlugin(plugin: SecretsPlugin): Promise<void> {
  return new Promise<void>((resolve) => {
    let buf = "";
    let stopping = false;

    const stop = () => {
      if (stopping) return;
      stopping = true;
      // Drain stdin so any final response we already wrote actually flushes before exit.
      process.stdin.pause();
      resolve();
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) void handle(plugin, line);
        nl = buf.indexOf("\n");
      }
    });
    process.stdin.on("end", stop);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}

async function handle(plugin: SecretsPlugin, line: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    write(parseError());
    return;
  }
  if (req.jsonrpc !== "2.0" || typeof req.id !== "number" || typeof req.method !== "string") {
    write(invalidRequest(typeof req?.id === "number" ? req.id : 0));
    return;
  }

  try {
    const result = await dispatch(plugin, req.method, req.params ?? {});
    write({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    write({
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: INTERNAL_ERROR,
        message: (err as Error).message,
        data: (err as Error).stack,
      },
    });
  }
}

async function dispatch(plugin: SecretsPlugin, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "meta":
      return plugin.meta;
    case "configure":
      await plugin.configure(params.input);
      return null;
    case "issue":
      return plugin.issue({
        role: params.role as string,
        ttlSeconds: params.ttlSeconds as number | undefined,
        params: params.params as Record<string, unknown> | undefined,
      });
    case "renew":
      return plugin.renew(params.leaseId as string);
    case "revoke":
      await plugin.revoke(params.leaseId as string);
      return null;
    default:
      throw methodNotFound(method);
  }
}

function methodNotFound(method: string): Error {
  const e = new Error(`unknown method '${method}'`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e as any).code = METHOD_NOT_FOUND;
  return e;
}

function parseError(): JsonRpcError {
  return { jsonrpc: "2.0", id: 0, error: { code: PARSE_ERROR, message: "parse error" } };
}

function invalidRequest(id: number): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "invalid request" } };
}

function write(msg: JsonRpcSuccess | JsonRpcError): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
