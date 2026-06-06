import { defineConfig } from "tsup";

// Core plugin (no Node-specific imports, injectable reviewer) + the optional Node-builtin
// default TokenReviewer (fetch). Mirrors the SCM/cloud/oidc plugins' dual-publish layout.
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
