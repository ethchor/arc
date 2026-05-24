# arc-vault

A zero-knowledge, end-to-end encrypted vault designed to serve **two** product surfaces
from **one** cryptographic protocol:

1. a **consumer password manager** (autofill, passkeys, browser/mobile UX, recovery), and
2. **developer / team secrets infrastructure** (RBAC, APIs, service accounts, CI/CD,
   audit, org governance, delegated access).

The server is a **blind ciphertext store**. It holds salts, wrapped keys, ciphertext, and
non-content metadata only. It never receives the master password, any derived key, the
recovery key, a Vault Key, an Item Key, or any plaintext.

> **Status: design only.** This repository currently contains the architecture and protocol
> specification under [`docs/`](docs/). No application code, scaffolding, or dependencies
> exist yet. The docs are written to be implementation-ready: a follow-up pass can scaffold
> the monorepo and build Phase 1 directly from them.

## Where to start

Read [`docs/README.md`](docs/README.md) — it is the index, glossary, status legend, and a
**coverage matrix** mapping every design requirement to the section that satisfies it.

## Target stack (intended, not yet built)

A Turborepo monorepo:

- `apps/api` — NestJS + TypeORM + Postgres + JWT (sync authorization + blind blob store)
- `apps/web` — Next.js web client
- `apps/desktop` — Tauri (Rust core crypto, OS keychain, SQLCipher offline cache)
- `apps/extension` — browser extension (autofill, origin-bound)
- `packages/vault-crypto` — shared TypeScript crypto (Argon2id, HKDF, XChaCha20-Poly1305,
  X25519/Ed25519, the versioned envelope)

The Rust core and the TypeScript core implement the **same** wire protocol and envelope so
ciphertext and signatures are portable across every client.
