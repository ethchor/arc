import { defineConfig } from "tsup";

// Dual-publish ESM + CJS so arc-server's CommonJS Jest runner can `require()` it.
// No workspace deps so neither bundle needs noExternal.
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
  },
]);
