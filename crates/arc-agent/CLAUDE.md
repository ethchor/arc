# arc-agent — agent context

**Scope.** Workload sidecar (Rust binary). Reads a YAML config describing what secrets to
fetch and where to write them, then runs once (init-container mode) or stays running
(sidecar mode) and refreshes leases before they expire. Pairs with arc-operator as the two
"deliver secrets to workloads" surfaces (CLAUDE.md §two-engines: "arc-operator / arc-agent
deliver secrets to workloads").

**Trust model.** arc-agent carries an arc JWT obtained via the configured auth method.
`@arc/grants` on arc-server is the only policy decision point — the agent does not infer
authorization locally and does not retry-with-different-creds on 403. On 401 (token
revoked / cache miss), one re-login + retry; on 403, propagate immediately.

**Deps rule.** No workspace deps. External crates only: clap, serde/serde_yaml/serde_json,
tokio (rt-multi-thread, signal), reqwest (rustls-tls, json), tera (templating), thiserror,
tracing, async-trait, zeroize, libc. **Do not import arc-vault-crypto or any other
workspace crate** — the agent talks to arc-server through plain HTTP. If we ever wanted
in-process Engine-B decryption (unlikely for a sidecar), the contract is the same as the
desktop shell.

**Module layout.**
```
config.rs   — serde schema, default values, validate()
arc.rs      — HTTP client + JWT lifecycle (login, refresh-ahead, 401-retry-once)
template.rs — tera wrapper (autoescape OFF; strict missing-field errors)
sink.rs     — per-sink state machine: tick → fetch → render → write atomically → on_change
on_change.rs — command exec or signal-to-PID
runner.rs   — schedule + run; sinks fail independently; SIGTERM drain
main.rs     — CLI (run --once | run | validate)
```

**Why Tera.** Jinja-style is widely understood; autoescape is per-template (we set it off
globally — these are config files, not HTML). Missing dotted-variable access errors by
default, which is what we want: typos become loud sink-tick failures.

**Atomic writes.** Each rendered file lands at `<dir>/.<filename>.tmp` first with the
desired mode, then `rename` swaps it in. POSIX guarantees rename atomicity inside the same
directory, so workloads consuming the file never see a half-written version.

**Token zeroization.** The cached arc JWT lives in a `CachedJwt` wrapper whose `Drop` calls
`String::zeroize()`. Not foolproof (Rust may move the bytes elsewhere before drop) but
better than nothing for a secrets sidecar.
