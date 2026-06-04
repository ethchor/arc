import { defineConfig } from "tsup";

export default defineConfig([
  { entry: ["src/index.ts", "src/node-client.ts"], format: ["esm"], dts: true, clean: true },
  { entry: ["src/index.ts", "src/node-client.ts"], format: ["cjs"], dts: true, clean: false },
]);
