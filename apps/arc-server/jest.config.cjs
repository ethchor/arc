/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  setupFiles: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.e2e-spec.ts", "<rootDir>/src/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    // @arc/crypto, @arc/secrets-engine, @arc/openbao-adapter are all "type": "module"
    // and Jest's CommonJS loader can't `require()` ESM from source. Their tsup configs
    // emit a CJS bundle that inlines the ESM-only deps (crypto inlines @noble/*; the
    // engine + adapter inline @arc/leasing) so we point Jest at those built CJS dists.
    // Turbo's "test: depends on ^build" guarantees they exist before tests run.
    // @arc/sdk and @arc/cli stay on source for fast iteration.
    "^@arc/crypto$": "<rootDir>/../../packages/arc-crypto/dist/index.cjs",
    "^@arc/secrets-engine$": "<rootDir>/../../packages/arc-secrets-engine/dist/index.cjs",
    "^@arc/openbao-adapter$": "<rootDir>/../../integrations/arc-openbao-adapter/dist/index.cjs",
    "^@arc/sdk$": "<rootDir>/../../sdks/arc-js-sdk/src/index.ts",
    "^@arc/cli$": "<rootDir>/../../apps/arc-cli/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testTimeout: 30000,
};
