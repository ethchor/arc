import { defineConfig } from "tsup";

// ESM-only — the MCP SDK ships ESM, and arc-mcp-server is a runnable Node service, not a
// library other workspace packages need to `require()`. Two entries: the library export and
// the bin entrypoint (which adds a shebang).
export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  target: "node22",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  shims: false,
  banner: { js: "" },
});
