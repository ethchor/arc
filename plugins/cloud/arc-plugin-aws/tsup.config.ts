import { defineConfig } from "tsup";

// Two entry points: the core plugin (no SDK dep) and the optional SDK-backed StsClient
// factory. Splitting them keeps callers who inject their own StsClient (tests, custom
// signers, future Lambda-instance-credentials variant) from paying for the AWS SDK import.
//
// Dual-publish ESM + CJS so arc-server's CommonJS Jest runner can `require()` the core
// plugin directly.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/aws-sdk-sts-client.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    // @aws-sdk/client-sts is an optional peer dep — leave external in both bundles so
    // nothing pulls it in unless `@arc/plugin-aws/aws-sdk` is the imported path.
    external: ["@aws-sdk/client-sts"],
  },
  {
    entry: ["src/index.ts", "src/aws-sdk-sts-client.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
    external: ["@aws-sdk/client-sts"],
  },
]);
