/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  setupFiles: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.e2e-spec.ts", "<rootDir>/src/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    // @arc/crypto pulls in the ESM-only @noble/post-quantum, which Jest's CommonJS
    // loader can't process from source. tsup's CJS bundle inlines that dep, so we
    // point at the built dist instead — turbo's "test: depends on ^build" guarantees
    // it exists. @arc/sdk and @arc/cli stay on source for fast iteration.
    "^@arc/crypto$": "<rootDir>/../../packages/arc-crypto/dist/index.cjs",
    "^@arc/sdk$": "<rootDir>/../../sdks/arc-js-sdk/src/index.ts",
    "^@arc/cli$": "<rootDir>/../../apps/arc-cli/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testTimeout: 30000,
};
