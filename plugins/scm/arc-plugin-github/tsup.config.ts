import { defineConfig } from "tsup";

// Two entry points: core plugin (no Node-specific imports) + the optional
// Node-builtin-backed default client (RS256 JWT via node:crypto + fetch). Mirrors the
// AWS/GCP plugins' layout.
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
