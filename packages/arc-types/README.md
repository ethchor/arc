# @arc/types

Single source of truth for the **types and wire shapes** every other arc package
references. Pure types — no runtime, no imports, zero deps. Anything that builds against
arc types (plugins, SDKs, server, UI clients) can take this package without pulling in
crypto, network, or storage code.

What lives here:

- `JsonValue` — the narrow JSON-serialisable type arc uses everywhere AAD or item
  payloads are canonicalised via RFC 8785 JCS.
- `Envelope`, `SignatureEnvelope` — the versioned envelope wire shape (docs/04). The
  runtime helpers that produce and consume envelopes live in `@arc/crypto`; every other
  consumer only needs the shape.
- `MemberRole`, `VaultType` (and the string-literal arrays for runtime validation) — the
  cross-cutting vault domain types referenced by server entities, the SDK, the web UI,
  and the CLI.

What does **not** live here: implementation details, runtime values that need crypto or
networking, package-internal shapes. If a type is only used inside one package, it stays
there.

See `docs/CLAUDE.md` (`## Source of Truth`) for the canonical "where does this type live"
table.
