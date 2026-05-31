import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // @noble/post-quantum is ESM-only. Leaving it external in the CJS bundle would
  // produce `require("@noble/post-quantum/ml-kem.js")` calls that Node refuses to
  // load from CommonJS. Bundling it inline gives us a pure-CJS dist that any
  // CommonJS consumer (Jest with ts-jest, NestJS server, current CLI) can load
  // without ESM gymnastics.
  noExternal: ["@noble/post-quantum"],
});
