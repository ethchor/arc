import { defineConfig } from "tsup";

// Two entry points: the core plugin (no Node-specific imports, injectable verifier) + the
// optional Node-builtin-backed default verifier (trust-bundle JWKS via fetch + RS/ES verify
// via node:crypto). Mirrors the OIDC plugin's dual-publish layout.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/node-verifier.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/index.ts", "src/node-verifier.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
  },
]);
