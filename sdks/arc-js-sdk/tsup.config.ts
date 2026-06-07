import { defineConfig } from "tsup";

// Publishable build. Two decisions matter for shipping to npm:
//
//  1. **Bundle the workspace crypto** (`@arc/crypto`, and the type-only `@arc/types`).
//     An external consumer can't resolve `workspace:*`, so the SDK inlines arc's crypto
//     code and ships self-contained.
//  2. **Keep the audited crypto libs external.** `@noble/*` stay as real, visible
//     dependencies of the published package — security-sensitive code should be an
//     auditable dependency in the consumer's lockfile, not silently bundled.
//
// Dual ESM + CJS so the SDK works in both `import` and `require()` consumers.
// `dts.resolve` forces the type bundler to INLINE the workspace packages' types (e.g.
// `Envelope`, `JsonValue`) into the emitted .d.ts instead of leaving a dangling
// `import ... from "@arc/crypto"` that an external consumer can't resolve.
const dts = { resolve: ["@arc/crypto", "@arc/types"] } as const;

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts,
    clean: true,
    sourcemap: true,
    noExternal: ["@arc/crypto", "@arc/types"],
  },
  {
    entry: ["src/index.ts"],
    format: ["cjs"],
    dts,
    clean: false,
    sourcemap: true,
    noExternal: ["@arc/crypto", "@arc/types"],
  },
]);
