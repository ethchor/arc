import { defineConfig } from "tsup";

// Per-format strategy mirrors @arc/crypto:
// - ESM: leave every dep external. Modern bundlers (web/extension/Next.js) resolve
//   `@arc/leasing` from the workspace and won't trip over the ESM-only sibling.
// - CJS: inline `@arc/leasing`. The CommonJS Jest runner in apps/arc-server can't
//   `require()` an ESM-only sibling, and we don't want to dual-publish leasing just
//   for one call (`normalizeMount`). Inlining produces a self-contained CJS bundle.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/index.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
    noExternal: ["@arc/leasing"],
  },
]);
