import { defineConfig } from "tsup";

// Dual-publish ESM + CJS so arc-server's CommonJS Jest runner can `require()` LeaseError /
// LeaseManager directly (previously only @arc/secrets-engine + @arc/openbao-adapter consumed
// leasing, and they inline it via tsup's noExternal). Once arc-server depends on it at
// runtime that workaround doesn't apply.
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
