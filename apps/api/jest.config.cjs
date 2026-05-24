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
    "^@arc-vault/crypto$": "<rootDir>/../../packages/vault-crypto/src/index.ts",
    "^@arc-vault/sdk$": "<rootDir>/../../packages/vault-sdk/src/index.ts",
    "^@arc-vault/cli$": "<rootDir>/../../apps/cli/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testTimeout: 30000,
};
