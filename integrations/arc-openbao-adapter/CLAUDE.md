# arc-openbao-adapter — agent context

**License boundary (read before editing).**

- Target backend is **OpenBao (MPL 2.0)** — <https://github.com/openbao/openbao>. Building on it
  and shipping commercially is fine (weak copyleft; modifications to MPL files stay MPL).
- **Never** copy, port, or closely translate **HashiCorp Vault (BSL 1.1)** source into this
  package. Reading Vault docs to understand HTTP API behavior is fine; reading-then-rewriting
  BSL code is a derivation risk. If unsure, STOP and write an ADR in `docs/arc-rfcs/`.

**Scope.** Only the documented OpenBao HTTP API: `/v1/sys/*`, `/v1/<mount>/...`. No barrier,
seal, Raft, or crypto is implemented here — that lives inside OpenBao. This package just maps
arc's `@arc-vault/secrets-engine` contract onto HTTP calls.

**Deps rule.** Depends on `@arc-vault/secrets-engine` and `@arc-vault/leasing` only (plus the
runtime `fetch`). Never import app internals.
