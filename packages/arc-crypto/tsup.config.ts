import { defineConfig } from "tsup";

// Per-format bundling strategy:
// - ESM (web, extension, modern bundlers): leave every dep external. Browser/Next.js
//   bundlers handle ESM-only deps natively and pick a browser-safe `@noble/hashes`
//   subpath; inlining hashes here would drag in `cryptoNode.js` and break the
//   browser-extension IIFE build.
// - CJS (Jest+ts-jest, NestJS server tests): `@noble/post-quantum` is ESM-only and Node
//   refuses to `require()` it from CJS. Bundling it (plus `@noble/hashes`, whose
//   `utils.js` it depends on at a version that doesn't match our root install) inlines
//   the whole thing into a self-contained CJS dist that any CommonJS consumer can load.
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
    noExternal: ["@noble/post-quantum", "@noble/hashes"],
  },
]);
