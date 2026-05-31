# ADR-001 — Language boundary

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** ethchor
- **Supersedes:** —

## Context

arc is a zero-knowledge platform. The most important security property is not
*"the implementation is memory-safe"* — it is *"the server, the backups, and
the operator can never see a key or a plaintext"*. That property changes which
processes hold valuable bytes in memory, which in turn changes where Rust
actually buys safety and where it just costs months.

We need a durable rule so that future contributors — human or agent — don't
drift the codebase one component at a time toward an "it's all Rust because
Rust is safe" monoculture (slow, expensive, and *not actually* an improvement
for processes that never see plaintext), or toward an "it's all TypeScript
because it's easier" monoculture (cheap, but wrong for the components that
*do* hold keys).

## Decision

| Layer | Language | Rationale |
|---|---|---|
| Engine-B crypto core (`packages/arc-crypto`, `crates/arc-vault-crypto`) | **TS + Rust, parity-tested** | The TS core runs in browser/extension/Node; the Rust core runs in desktop/agent. Both produce byte-identical output (doc 15 §15.1). Rust earns its keep here: `Zeroizing` buffers, constant-time primitives, no GC pinning key bytes. |
| Desktop runtime (`crates/desktop-core`, `apps/arc-vault-desktop`) | **Rust (Tauri shell)** | The VEK and device-private key live in this process. WebView never holds the master key — that property only holds if the host process is Rust with deterministic zeroize. |
| Engine-A barrier / seal / Raft / PKI / transit | **Go (OpenBao binary)** — not reimplemented | OpenBao (MPL 2.0) is independently audited and battle-tested. We drive it over its HTTP API via `integrations/arc-openbao-adapter`. Re-implementing the barrier in Rust would take years and gain nothing on the threat model. |
| Engine-A contracts (`packages/arc-secrets-engine`, `arc-leasing`, `arc-plugin-sdk`) | **TypeScript** | Pure interface + lifecycle logic, no crypto, no key bytes. TS gives us the same library surface across CLI, server, and SDK. |
| Control plane / blind ciphertext store (`apps/arc-server`) | **TypeScript (NestJS)** | The server is *by design* a blind ciphertext store and sync-authorization oracle. It never decrypts, never holds a key, never sees plaintext. Memory-safety of this process is **not** what protects user data — the zero-knowledge protocol is. NestJS gives velocity on RBAC, routing, sync ordering, TypeORM. Rewriting in Rust trades months of working Engine-B sync code for ~zero threat-model gain. |
| CLI (`apps/arc-cli`) | **TypeScript** | Shares the Engine-B crypto core via `@arc/crypto`; identical decrypt path to web. Sub-300ms startup is fine for a CLI; Rust here would re-implement what already works. |
| Public SDK (`sdks/arc-js-sdk`) | **TypeScript** | The primary integration surface for app authors. A future `sdks/arc-go-sdk` and `sdks/arc-rust-sdk` are in scope when there is demand from sidecar / agent users. |
| Web client (`apps/arc-vault-web`) | **Next.js / React (TypeScript)** | Product UX surface. The XSS-while-unlocked threat is mitigated by CSP, never-persist-keys, short auto-lock (doc 12) — not by host-language choice. |
| Browser extension (`apps/arc-browser-extension`) | **TypeScript** (today) | Content-script + service-worker; same crypto as web. See *Open questions* on a possible WASM crypto module. |
| Plugins | **TypeScript contract; native runtime per plugin** | The `@arc/plugin-sdk` is TS so the contract is universally consumable. Individual plugins (cloud/SCM/DB connectors) pick their own language. |
| Future `arc-agent` (sidecar/templating daemon) | **Rust** | Holds short-lived dynamic credentials in memory, talks to OpenBao, renders templates. Same threat profile as `desktop-core` → same language. |
| Future `arc-operator` (Kubernetes) | **Go** | Ecosystem expectation; uses controller-runtime. Does not hold long-lived key material. |

## Explicitly rejected alternatives

1. **"Rewrite `arc-server` in Rust (axum/actix) for safety."** Rejected. The
   server holds no key, no plaintext, no recovery material. Its memory is full
   of opaque ciphertext envelopes, RBAC rows, and sync sequence numbers.
   Memory-safety bugs in this process do not break zero-knowledge. The cost
   (months of porting the working sync/grant/membership code) does not buy a
   meaningful improvement on the threat model.

2. **"Rewrite `arc-cli` in Rust for a single binary."** Rejected for v1. The
   CLI uses the same `@arc/crypto` path as the web client, so parity is
   automatic. A Rust port becomes attractive *if and when* we ship `arc-agent`
   and want one shared crypto-holding binary — at which point this ADR is
   revisited.

3. **"Implement Engine-A (barrier/seal/Raft) ourselves in Rust."** Rejected.
   Replacing OpenBao would mean re-auditing a vault-of-vaults from scratch.
   Adapter pattern (`arc-openbao-adapter`) keeps the option open to swap or
   add backends later (`integrations/arc-vault-adapter` if a customer
   contractually needs HashiCorp Vault; `integrations/arc-native-engine` if
   we ever build one) without that being a v1 dependency.

4. **"All-TypeScript, including desktop and crypto core."** Rejected. JS GC
   makes deterministic zeroize impossible; constant-time primitives in JS
   are best-effort at best. For processes that hold the VEK or
   identity-private key in memory, Rust is the correct default.

## Consequences

- **Code review.** Any PR that moves a component from one column to another
  in the table above requires an ADR update — not a casual rewrite. A drive-by
  "let's port `arc-server` to Rust" PR gets closed with a link to this doc.
- **Dependencies.** Engine-A correctness depends on the OpenBao project
  staying healthy (MPL 2.0, currently active). Mitigation: the adapter
  interface (`@arc/secrets-engine`) is small and backend-agnostic; switching
  backends is a contained change.
- **Hiring / contribution.** Two language tracks (Rust + TS) is more surface
  than one, but it matches the only-rust-where-it-matters principle. A
  contributor working on the web client never needs to touch Rust; a
  contributor working on the crypto core needs both for parity testing
  (which is exactly the property we want from the parity tests anyway).
- **Build / CI.** The Rust crates compile without GUI deps (`crates/desktop-core`
  has no Tauri/GTK linkage), so they live in normal CI. The Tauri shell
  (`apps/arc-vault-desktop/src-tauri`) is built locally / on release runners
  only, since it pulls webkit2gtk. This is already the layout.

## Open questions

- **Post-quantum hybrid wrap of the recovery key** (X25519 + ML-KEM-768).
  Should be retrofitted to `arc-crypto` (TS + Rust) when a vetted ML-KEM
  implementation ships in `@noble/post-quantum` / a Rust crate at the same
  audit bar as the current primitives. Cheap now, expensive after the
  recovery format is in production.
- **Native browser-extension WASM crypto.** Compiling `arc-vault-crypto`
  (Rust) to WASM for the extension would let us run a memory-safer crypto
  path inside the service worker. Open: bundle size, startup latency,
  Manifest V3 constraints on WASM.
- **`arc-agent` location.** A separate `apps/arc-agent` Rust crate, or
  shared code with `desktop-core` via a new `crates/agent-core`? Decide
  when the agent's first concrete use case (sidecar template rendering vs.
  systemd unit secret injection) is locked.

## References

- `docs/MONOREPO_PLAN.md` — the platform layout this ADR formalizes the
  language axis of.
- `docs/04-crypto-protocol.md`, `docs/15-testing-review-and-operations.md`
  §15.1 — the TS↔Rust parity contract that the dual-language Engine-B
  core depends on.
- `docs/12-clients-sessions-and-extension.md` §12.2 — why the desktop has
  to be a Rust host process, not a TS one.
- `integrations/arc-openbao-adapter/CLAUDE.md` — the BSL boundary that
  keeps us off HashiCorp Vault source and on OpenBao MPL.
