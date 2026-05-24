import { defineConfig } from "tsup";

// Bundle everything into classic (IIFE) scripts so content scripts and the MV3 service
// worker have no import/export statements and ship no remote code.
export default defineConfig({
  entry: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
  },
  format: ["iife"],
  platform: "browser",
  target: "es2022",
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  outDir: "dist",
  outExtension: () => ({ js: ".js" }),
});
