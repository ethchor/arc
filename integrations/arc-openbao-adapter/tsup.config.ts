import { defineConfig } from "tsup";

// Same dual-format pattern as @arc/secrets-engine + @arc/crypto:
// - ESM build leaves workspace deps external (modern bundlers resolve them fine).
// - CJS build inlines workspace deps so CommonJS consumers (the NestJS server's Jest
//   runner, in particular) get a self-contained bundle without us having to dual-publish
//   `@arc/leasing` or `@arc/secrets-engine` just to satisfy `require()`.
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
    noExternal: ["@arc/leasing", "@arc/secrets-engine"],
  },
]);
