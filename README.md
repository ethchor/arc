# arc

[![CI](https://github.com/ethchor/arc/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/ethchor/arc/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](#prerequisites)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-f69220)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-300%20passing-2ea043)](docs/manual-testing/)
[![Engine A](https://img.shields.io/badge/Engine%20A-OpenBao%20(MPL%202.0)-5b21b6)](https://github.com/openbao/openbao)
[![Engine B](https://img.shields.io/badge/Engine%20B-zero%20knowledge-7c2d12)](docs/04-envelopes-and-aad.md)
[![ADR-002](https://img.shields.io/badge/grants-PQ%20hybrid%20(X25519%20%2B%20ML--KEM--768)-1f6feb)](docs/arc-rfcs/)
[![License](https://img.shields.io/badge/license-TBD-lightgrey)](#license)

**One platform for OpenBao-grade infrastructure secrets + Bitwarden-class end-to-end vault, unified
under one identity, one policy model, one audit trail, one UI.**

arc replaces the usual *"HashiCorp Vault for ops + 1Password for everyone else + a plugin pile to
glue them"* setup with a single self-hostable stack:

- **Engine A — infra secrets** (dynamic credentials, PKI, KV, transit encryption,
  leasing/revocation, K8s auth). Backed by a **colocated [OpenBao](https://github.com/openbao/openbao)
  server (MPL 2.0)** driven through its HTTP API by `integrations/arc-openbao-adapter`. We don't
  reinvent the barrier, seal, Raft consensus, or the PKI CA — those live in OpenBao.
- **Engine B — end-to-end vault** (passwords, TOTP, secure notes, sharing, recovery). In-house
  zero-knowledge implementation in `@arc/crypto`. **The server stores ciphertext only and
  never sees a master password, a derived key, a recovery key, or any plaintext.**

The two engines share one identity model, one authorization layer, one audit log, one UI.

> **Status — Phase 1 MVP shipping incrementally.** Engine-A (KV v2 + Transit) and the full
> Engine-B consumer surface (master-password unlock, recovery, multi-device, sharing, rotation,
> login + TOTP + notes + generic secret items) are working end-to-end across server, SDK, CLI,
> and web. Desktop (Tauri) and browser-extension shells are scaffolded but not wired up yet.
> See [`docs/STATUS.md`](docs/STATUS.md) for the live tracker — it's updated every commit.

---

## What's special about it

| Decision | What it gives you |
|---|---|
| **XChaCha20-Poly1305 + Argon2id + RFC 8785 JCS** | Modern primitives by default, not the AES-GCM/PBKDF2 set Bitwarden defaults to in 2026. 24-byte random nonces (no birthday-collision footgun), memory-hard KDF, byte-for-byte canonical signatures. See [ADR-001](docs/arc-rfcs/ADR-001-language-boundary.md). |
| **Post-quantum hybrid for vault-key grants** | Every wrapped VK on the server uses **X25519 + ML-KEM-768** with a binding HKDF salt (X-Wing-style construction). Closes the harvest-now-decrypt-later surface end-to-end. Same posture as Signal PQXDH (2023) and Apple iMessage PQ3 (2024). See [ADR-002](docs/arc-rfcs/ADR-002-post-quantum-hybrid-grants.md). |
| **TS↔Rust byte-for-byte parity** | The web/extension/CLI run [`@arc/crypto`](packages/arc-crypto) (TypeScript). The desktop runs [`vault-crypto-rs`](crates/vault-crypto-rs) (Rust). They produce identical ciphertext + signatures for identical inputs; enforced by KAT vectors in `vectors/kat.json` consumed by Rust integration tests. |
| **Rust where keys live, TS everywhere else** | Crypto core + desktop runtime are Rust (zeroize, constant-time, no GC). Blind ciphertext server is TypeScript / NestJS (no keys in process memory → memory-safety isn't gating). Documented and locked in [ADR-001](docs/arc-rfcs/ADR-001-language-boundary.md). |
| **OpenBao under the hood, not a reimplementation** | We treat OpenBao the way `kubectl` treats Kubernetes — a documented backend driven through its HTTP API. **No HashiCorp Vault BSL source is copied, ported, or read for translation.** The license boundary is enforced at the package level (`integrations/arc-openbao-adapter`). |
| **Plugin system from day one** | Same `SecretsPlugin` / `AuthPlugin` / `StoragePlugin` contracts that Vault's engine ecosystem proved. Plugins never receive the E2E master key — only scoped capabilities. |

## Quick start

```sh
# 1. Install deps + build the workspace.
pnpm install
pnpm turbo run build

# 2. Run the test suite (TS unit + e2e against sql.js + Rust parity).
pnpm turbo run test
cd crates/vault-crypto-rs && cargo test

# 3. Start a local stack:

# (a) Engine-A backend — colocated OpenBao in dev mode.
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d
export BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root

# (b) arc-server (Engine-B blind ciphertext store).
JWT_SECRET=dev-only pnpm --filter @arc/server start    # :3001
# Or with Postgres in prod mode:
#   NODE_ENV=production JWT_SECRET=... DATABASE_URL=postgres://... pnpm --filter @arc/server start
# Prod refuses to boot if DATABASE_URL or JWT_SECRET is missing.

# (c) Web app.
pnpm --filter @arc/vault-web dev                       # :3000

# (d) Optional: CLI for both engines.
pnpm --filter @arc/cli build
node apps/arc-cli/dist/bin.js --help
```

## Monorepo layout

pnpm workspaces + Turborepo. Strict dependency rules: `plugins/* → arc-plugin-sdk + arc-types only`;
`apps/* → packages/* + sdks/* + integrations/*`; `sdks/* → packages/* only`. Full graph in
[`docs/CLAUDE.md`](docs/CLAUDE.md).

```
arc/
  packages/
    arc-types/                 # JsonValue, Envelope wire shape, MemberRole/VaultType, Item union
    arc-crypto/                # Engine-B crypto: Argon2id, HKDF, XChaCha20-Poly1305, X25519,
                               # Ed25519, JCS, the versioned envelope, X25519+ML-KEM-768 hybrid seal, TOTP
    arc-leasing/               # Engine-A lease lifecycle (TTLs, renew, revoke). No backend.
    arc-secrets-engine/        # Engine-A clean contracts: KvEngine, DynamicSecretsEngine,
                               # TransitEngine, MountRegistry. Backend-agnostic.
    arc-plugin-sdk/            # Plugin contract + in-process host
  apps/
    arc-server/                # NestJS blind ciphertext store + sync authorization. Pino logging,
                               # real Postgres migration, sql.js fallback for tests.
    arc-vault-web/             # Next.js console: enroll, unlock, login/TOTP/note/secret items,
                               # folders, sharing, key rotation, devices, audit log
    arc-vault-desktop/         # Tauri shell. Crate is built + tested; shell wire-up pending.
    arc-browser-extension/     # Scaffolded; autofill flow pending.
    arc-cli/                   # arc-vault {enroll,set,get,totp-add,totp,ls,...}
  sdks/
    arc-js-sdk/                # Public TypeScript SDK (VaultClient). To be published as @arc/sdk.
  integrations/
    arc-openbao-adapter/       # OpenBaoClient + KV v2 + Transit engines. HTTP-only.
                               # docker-compose.yml ships an OpenBao dev server. Live smoke tests
                               # run against it when BAO_ADDR is set, skip otherwise.
  crates/
    vault-crypto-rs/           # Rust Engine-B crypto: byte-for-byte parity with @arc/crypto.
                               # Includes the ML-KEM-768 hybrid open + round-trip self-test.
    desktop-core/              # Webkit-free desktop runtime: in-memory session, keychain
                               # abstraction, encrypted local cache. Wraps vault-crypto-rs.
  docs/
    STATUS.md                  # Live roadmap — done / in-progress / pending, updated each commit.
    CLAUDE.md                  # Agent-facing context: licensing rules, dependency rules.
    MONOREPO_PLAN.md           # The full platform plan, organised by phase.
    01- to 16-*.md             # Protocol specs (crypto, sync, devices, audit, testing, …).
    arc-rfcs/
      ADR-001-language-boundary.md
      ADR-002-post-quantum-hybrid-grants.md
  vectors/
    kat.json                   # TS-emitted KATs the Rust crate's parity tests load.
```

## Security posture, in one screen

- **Zero-knowledge** on the server. The blind ciphertext store can be backed up, snapshotted,
  subpoenaed, or compromised at rest without revealing user secrets — they're never in its
  process memory or its database in plaintext.
- **Post-quantum-resistant grants** on every new enrollment. ML-KEM-768 + X25519 hybrid. Old
  ciphertext that's already been captured doesn't become decryptable when a quantum computer
  breaks ECC in 203X.
- **Signed mutation chain + signed vault head** detect replay / rollback / omission, not just
  point-tampering at the row level (docs/10).
- **Audit log is metadata-only**, programmatically enforced — e2e tests assert no ciphertext or
  plaintext leaks into the log volume (docs/11).
- **No hand-rolled crypto.** Every primitive comes from an audited library in the `@noble/*`
  family (TS) or RustCrypto (Rust). The hybrid combiner is the IETF-CFRG X-Wing pattern.
- **License boundary.** OpenBao (MPL 2.0) only for Engine-A. No HashiCorp Vault (BSL 1.1)
  source is copied, ported, or read for translation. The licensing rules live in
  [`docs/CLAUDE.md`](docs/CLAUDE.md) and [`integrations/arc-openbao-adapter/CLAUDE.md`](integrations/arc-openbao-adapter/CLAUDE.md).

## Contributor workflow — never push red

CI runs `pnpm build && pnpm typecheck && pnpm test`. A local **pre-push git hook**
runs the exact same chain so it's impossible to push code that would break CI.

```bash
# Installed automatically on `pnpm install` (postinstall). Re-run manually if needed:
pnpm hooks:install

# What CI runs, mirrored locally — same steps, same arguments:
pnpm ci          # → build → typecheck → test
```

`git push` invokes the hook automatically. To bypass in an emergency:
`git push --no-verify` (and own the consequence — the CI badge above will go red).

## Manual testing

A step-by-step playbook for running the whole stack locally and exercising every shipped
feature by hand lives in [`docs/manual-testing/`](docs/manual-testing/). It pairs with
the 300-test automated suite (`pnpm -r test`) — automation covers the wire shapes and
unit boundaries; the manual guide covers cross-engine UX, the live OpenBao backend,
browser passkey flows, and the kind of "does this still feel like one product" check
that's hard to assert in code.

Start with [`docs/manual-testing/README.md`](docs/manual-testing/README.md) for the TOC.
For a release-tag checklist:
[`docs/manual-testing/checklist.md`](docs/manual-testing/checklist.md).

## Where to learn more

- [`docs/STATUS.md`](docs/STATUS.md) — what's done, what's in progress, what's pending, in
  implementation order. Updated every commit.
- [`docs/manual-testing/`](docs/manual-testing/) — step-by-step local-bootstrap +
  per-feature manual flows + cross-engine e2e scripts.
- [`docs/CLAUDE.md`](docs/CLAUDE.md) — the canonical "where does code belong" map, the
  dependency rules, and the licensing posture.
- [`docs/MONOREPO_PLAN.md`](docs/MONOREPO_PLAN.md) — the full platform plan and phasing.
- [`docs/arc-rfcs/`](docs/arc-rfcs/) — architectural decision records for the calls that
  shouldn't be re-litigated by a drive-by PR (language boundary, post-quantum migration).
- [`docs/01-overview-and-goals.md`](docs/01-overview-and-goals.md) onwards — the
  16-document protocol spec (threat model, crypto protocol, envelope, identity,
  enrollment, sharing, sync, audit, clients, passkeys, developer platform, testing,
  roadmap).
- [`docs/REFERENCE-hashicorp-vault.md`](docs/REFERENCE-hashicorp-vault.md),
  [`docs/REFERENCE-1password-bitwarden.md`](docs/REFERENCE-1password-bitwarden.md) —
  parity-feature maps we measure ourselves against.

## License

To be set. Internal posture: in-house code is yours to license as you choose; consult an
attorney before publishing. The `integrations/arc-openbao-adapter` package interoperates with
OpenBao's HTTP API only and contains no copied / translated Vault BSL source — that boundary
is enforced inside the package's `CLAUDE.md`.
