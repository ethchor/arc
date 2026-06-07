# @arc/sdk

Official TypeScript SDK for [arc](https://github.com/ethchor/arc) — the zero-knowledge vault
crypto core plus the sync/secrets API. Works in Node and the browser; serves both the
**consumer** (master-password vault) and **machine-identity** (service-account) modes.

The package is **self-contained**: arc's crypto core is bundled in, and the only runtime
dependencies are the audited [`@noble/*`](https://github.com/paulmillr/noble-hashes) primitive
libraries (kept external on purpose, so they show up in your lockfile and audit).

## Install

```sh
npm i @arc/sdk          # or: pnpm add @arc/sdk / yarn add @arc/sdk
```

Ships dual ESM + CJS with full type declarations.

## Quick start — consumer vault

```ts
import { VaultClient } from "@arc/sdk";

const arc = new VaultClient({ baseUrl: "https://arc.example.com" });

// Enrollment derives keys client-side; the server only ever sees ciphertext.
await arc.enroll({ email: "me@example.com", masterPassword: "…" });

// Later, on any device:
await arc.unlock({ email: "me@example.com", masterPassword: "…" });

const vaults = await arc.listVaults();
const item = await arc.createItem(vaults[0].id, {
  type: "login",
  fields: { username: "me", password: "…", url: "https://app" },
});
```

## Quick start — machine identity / agents

```ts
const arc = new VaultClient({ baseUrl: "https://arc.example.com" });
// e.g. a token obtained from one of arc's auth methods (OIDC / Kubernetes):
arc.setToken(process.env.ARC_TOKEN!);
```

## Device management

```ts
const devices = await arc.listDevices();      // approved devices + lastSeenAt + trusted
await arc.touchDevice(deviceId);              // keep a device fresh (avoids auto-revoke)
await arc.revokeDevice(deviceId);             // explicit retirement
```

The full surface (vaults, items, folders, sharing, key rotation, passkeys, device
enrollment/approval) is exported from the package root and fully typed.

---

## Maintainers — before the first publish

Two things are deliberately left for you to finalize; the publish workflow
(`.github/workflows/publish-sdk.yml`) **refuses to run until they're done**:

1. **License.** `package.json` says `"SEE LICENSE IN LICENSE"` but there is no `LICENSE`
   file yet (the repo license is still TBD). Add a `LICENSE` to `sdks/arc-js-sdk/` (or the
   repo root) before publishing — npm packages need one to be usable.
2. **npm scope.** The package name is `@arc/sdk`, which requires owning the `@arc`
   organization on npm. If you don't, rename `name` (and the matching references in
   `apps/arc-server/{package.json,jest.config.cjs}` + the SDK e2e tests) to a scope you
   control, e.g. `@your-org/arc-sdk`.

Publishing is a manual `workflow_dispatch` (or a `sdk-v*` tag) and requires an `NPM_TOKEN`
repo secret; nothing publishes automatically.
