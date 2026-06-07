#!/usr/bin/env node
/**
 * CLI entrypoint. Configured entirely via environment so the same binary works in the helm
 * chart, the terraform module, and a local docker run:
 *
 *   ARC_SERVER_URL  required — base URL of the arc-server REST API (e.g. http://arc:3001)
 *   PORT            optional — port to listen on (default 8800)
 *   HOST            optional — bind address (default 0.0.0.0)
 */
import { createArcMcpHttpServer } from "./http.js";

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(`[arc-mcp-server] missing required env var: ${name}\n`);
    process.exit(2);
  }
  return v;
}

const arcServerUrl = envRequired("ARC_SERVER_URL");
const port = Number(process.env.PORT ?? 8800);
const host = process.env.HOST ?? "0.0.0.0";

const server = createArcMcpHttpServer({ arcServerUrl });

server.listen(port, host, () => {
  process.stdout.write(`[arc-mcp-server] listening on http://${host}:${port} (arc=${arcServerUrl})\n`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    process.stdout.write(`[arc-mcp-server] ${sig} received, draining...\n`);
    server.close(() => process.exit(0));
    // Hard timeout if connections won't close.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
