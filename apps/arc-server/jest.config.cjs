/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  setupFiles: ["<rootDir>/test/setup.ts"],
  testMatch: ["<rootDir>/test/**/*.e2e-spec.ts", "<rootDir>/src/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    // Resolve workspace packages to their TS source so ts-jest transforms them
    // (avoids ESM/CJS friction with the built dist).
    "^@arc/crypto$": "<rootDir>/../../packages/arc-crypto/src/index.ts",
    "^@arc/sdk$": "<rootDir>/../../sdks/arc-js-sdk/src/index.ts",
    "^@arc/cli$": "<rootDir>/../../apps/arc-cli/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testTimeout: 30000,
};
