import { defineConfig } from "tsup";

// Dual-publish ESM + CJS so arc-server's CommonJS Jest runner can `require()` PluginHost
// and the contract types directly. arc-plugin-sdk has no workspace deps so neither bundle
// needs `noExternal`.
//
// Two entry points:
//   - index    — host-side surface (PluginHost, RemoteSecretsPlugin, contracts)
//   - runtime  — plugin-author surface (runSecretsPlugin), exposed at @arc/plugin-sdk/runtime
export default defineConfig([
  {
    entry: ["src/index.ts", "src/runtime.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/index.ts", "src/runtime.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
  },
]);
