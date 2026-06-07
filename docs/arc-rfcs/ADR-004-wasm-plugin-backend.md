# ADR-004 — WASM plugin backend (wasmtime + WASI preview-1)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** ethchor
- **Depends on:** The out-of-process plugin host (process backend over stdio) shipped in #18

## Context

The in-process plugin host runs every plugin in arc-server's heap. That's fine for the
trusted, first-party plugins we ship (`@arc/plugin-aws` etc.) but it doesn't give us a
sandbox for **third-party / untrusted plugins** — a malicious or buggy plugin can read
arc-server's memory, open any socket, touch the filesystem at arc-server's privileges.

#18 introduced the *transport abstraction*: plugins talk to the host over **JSON-RPC 2.0
on stdio** and the host (`RemoteSecretsPlugin`) treats them identically to in-process
plugins. The process backend gave us OS-level sandboxing (separate heap, env-var
isolation, killable). It still leaves filesystem and network reachable subject to the
host's own permissions.

WebAssembly is a strictly stronger sandbox: the plugin can't make syscalls except through
the WASI imports the host hands it, can't reach memory outside its linear memory, and is
completely deterministic from the host's perspective.

## Decision

Ship a **wasmtime-based WASM backend** that reuses the JSON-RPC-over-stdio transport
from #18 verbatim. The plugin author writes their `SecretsPlugin` exactly the same way —
they just compile it to a WASI preview-1 command instead of a Node script.

### What ships

- `@arc/plugin-sdk` → `buildWasmtimeSpec({ wasmPath, env?, dirs?, ... })` constructs a
  `RemoteProcessSpec` that runs the `.wasm` through wasmtime under a **deny-by-default
  WASI profile**:
  - `--env-inherit=none` (only env vars the spec lists are visible)
  - `--dir=none` (no filesystem unless explicitly granted via `dirs`)
  - `--tcplisten=none` (cannot accept connections)
- arc-server `PluginsService.mountWasmSecretsPlugin(spec, mountPath, config)` is a thin
  convenience wrapper around `mountRemoteSecretsPlugin(buildWasmtimeSpec(spec), …)`.
- The plugin's host-side behaviour (`configure / issue / renew / revoke`) is unchanged.
  The same `runSecretsPlugin(plugin)` stdio runtime works inside a WASI binary — plugin
  authors target WASI by compiling with their language's WASI tooling (rustc
  `wasm32-wasip1`, TinyGo `-target=wasi`, etc.).

### What the operator does

1. Install wasmtime in the deployment image (or pin `wasmtimePath` in the spec).
2. Build the plugin to a `.wasm` file. The plugin's stdio loop is identical to the
   process-backend runtime.
3. Mount it: `PluginsService.mountWasmSecretsPlugin({ wasmPath: '/plugins/aws.wasm' }, …)`.

### What this is **not**

- **An in-process WASM runtime.** Node 22's `node:wasi` runs in the Node heap and would
  defeat the isolation point. We deliberately shell out to wasmtime, which Bytecode
  Alliance maintains as a production sandbox.
- **A bundled wasmtime binary.** wasmtime is ~50 MB; bundling it would double the
  arc-server image size and tie us to a specific wasmtime version. Operators install
  the version they trust.
- **Network-attached.** Default profile has no `--tcplisten`/`--inherit-network`. A
  plugin that needs network either calls out to host services through the (forthcoming)
  capability bus, or its mount spec adds an explicit network grant — which is an
  operator decision, not a plugin author's.

## Why wasmtime, not Node's `node:wasi`

| | wasmtime (this ADR) | Node `node:wasi` |
|---|---|---|
| Process boundary | yes (separate child) | no (Node heap) |
| Persistent stdio | native (one process, long-running) | one-shot `start()` per invocation |
| Maturity | stable; production-deployed | "experimental" Node warning |
| Sandbox depth | proper WASI sandbox | shares Node's syscall surface |
| Binary required | yes (operator installs once) | no |

The trade-off is the runtime install. We pay that to keep the security story honest.

## Test

- `@arc/plugin-sdk` 6 unit tests on `buildWasmtimeSpec` — sandbox flags pinned, env / dir
  pass-through, wasmtime path override, argv after `--`, RPC timeout propagation.
- arc-server 1 spec on `mountWasmSecretsPlugin` — wasmtime-not-installed surfaces as a
  BadRequest carrying the spawn error (same as any unspawnable process plugin).

Full round-trip through a real `.wasm` lives in the production-image smoke tests, not in
CI (wasmtime + a compiled fixture would balloon the CI image).

## Migration

None — purely additive. Existing in-process and process-backend plugins keep working.
