import { defineConfig } from "tsup";

// Two entry points: core plugin (no SDK dep) + the optional google-auth-library-backed
// default IAM Credentials client. Mirrors the AWS plugin's layout — keeps the SDK as an
// optional peer dep so callers who inject their own client (tests, custom signers,
// metadata-server token sources) don't pay for it.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/google-auth-client.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["google-auth-library"],
  },
  {
    entry: ["src/index.ts", "src/google-auth-client.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
    external: ["google-auth-library"],
  },
]);
