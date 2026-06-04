import { defineConfig } from "tsup";

// Core plugin + optional Node-built-in client (fetch only). Mirrors the GitHub plugin's
// layout — no external runtime deps, the SDK-style adapter lives behind `/node`.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/node-client.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/index.ts", "src/node-client.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
  },
]);
