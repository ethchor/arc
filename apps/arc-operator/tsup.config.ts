import { defineConfig } from "tsup";

// ESM-only runnable service, like @arc/mcp-server. Bundle main + leave kube-client deps
// external (large transitive graph from @kubernetes/client-node — they stay on disk).
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
  shims: false,
});
