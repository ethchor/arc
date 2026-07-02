import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Argon2id parity tests run the pure-JS `@noble/hashes` implementation at the real
    // production memory parameters (m=65536 KiB, t=4) to prove it stays byte-identical to the
    // hash-wasm path. That single call takes ~5s on a fast machine — right at vitest's default
    // 5000ms testTimeout — so on a loaded CI runner it tips over and fails the `node` job as a
    // spurious timeout (not a real failure; it passes locally and in the pre-push gate). Give
    // the crypto suite generous headroom. This changes nothing about what is tested.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
