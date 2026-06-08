import { defineConfig } from "tsup";

// Three entry points:
//  1. core plugin (no AWS-SDK dep) for in-process consumers,
//  2. SDK-backed StsClient factory (optional peer dep — kept external),
//  3. OOP `bin.cjs` for the out-of-process plugin host: a single self-contained CJS
//     executable that arc-server's `RemoteSecretsPlugin.spawn` invokes. The AWS SDK stays
//     external on the bin too — operators install `@aws-sdk/client-sts` once in the
//     deploy image rather than pay for a ~10MB bundled copy in every release artifact.
//     This keeps the manifest's pinned SHA-256 stable across machines (the SDK version
//     is determined at install time, not at sign time).
//
// Dual-publish ESM + CJS for the in-process surfaces so arc-server's CommonJS Jest
// runner can `require()` the core plugin directly. The bin is CJS-only since the OOP
// host doesn't care which module system it gets.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/aws-sdk-sts-client.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["@aws-sdk/client-sts"],
  },
  {
    entry: ["src/index.ts", "src/aws-sdk-sts-client.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
    external: ["@aws-sdk/client-sts"],
  },
  {
    entry: { bin: "src/bin.ts" },
    format: ["cjs"],
    clean: false,
    // Bundle the SDK + plugin-sdk runtime into a single self-contained executable so
    // `node dist/bin.cjs` works without any node_modules lookup at the operator's
    // deploy path. Only Node built-ins + the optional peer SDK stay external.
    noExternal: ["@arc/plugin-sdk"],
    external: ["@aws-sdk/client-sts"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
