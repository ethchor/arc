/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  setupFiles: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.e2e-spec.ts", "<rootDir>/src/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    // @arc/crypto, @arc/leasing, @arc/secrets-engine, @arc/openbao-adapter are all
    // "type": "module" and Jest's CommonJS loader can't `require()` ESM from source.
    // Their tsup configs each emit a CJS bundle (crypto inlines @noble/*; the rest
    // build standalone) so we point Jest at those built CJS dists. Turbo's "test:
    // depends on ^build" guarantees they exist before tests run.
    // @arc/sdk and @arc/cli stay on source for fast iteration.
    "^@arc/crypto$": "<rootDir>/../../packages/arc-crypto/dist/index.cjs",
    "^@arc/grants$": "<rootDir>/../../packages/arc-grants/dist/index.cjs",
    "^@arc/leasing$": "<rootDir>/../../packages/arc-leasing/dist/index.cjs",
    "^@arc/plugin-sdk$": "<rootDir>/../../packages/arc-plugin-sdk/dist/index.cjs",
    "^@arc/secrets-engine$": "<rootDir>/../../packages/arc-secrets-engine/dist/index.cjs",
    "^@arc/openbao-adapter$": "<rootDir>/../../integrations/arc-openbao-adapter/dist/index.cjs",
    "^@arc/plugin-aws$": "<rootDir>/../../plugins/cloud/arc-plugin-aws/dist/index.cjs",
    "^@arc/plugin-azure$": "<rootDir>/../../plugins/cloud/arc-plugin-azure/dist/index.cjs",
    "^@arc/plugin-gcp$": "<rootDir>/../../plugins/cloud/arc-plugin-gcp/dist/index.cjs",
    "^@arc/plugin-github$": "<rootDir>/../../plugins/scm/arc-plugin-github/dist/index.cjs",
    "^@arc/plugin-gitlab$": "<rootDir>/../../plugins/scm/arc-plugin-gitlab/dist/index.cjs",
    "^@arc/plugin-bitbucket$": "<rootDir>/../../plugins/scm/arc-plugin-bitbucket/dist/index.cjs",
    "^@arc/sdk$": "<rootDir>/../../sdks/arc-js-sdk/src/index.ts",
    "^@arc/cli$": "<rootDir>/../../apps/arc-cli/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testTimeout: 30000,
};
