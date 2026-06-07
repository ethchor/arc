/**
 * WASM/wasmtime backend for the out-of-process plugin host. Reuses the
 * {@link RemoteSecretsPlugin} transport (JSON-RPC over stdio) from `./remote.ts` and
 * adds a runtime that the host shells out to: **wasmtime** running the plugin as a WASI
 * preview-1 command.
 *
 * Why wasmtime over Node's built-in `node:wasi`:
 *   - wasmtime is the production-grade sandbox the Bytecode Alliance maintains. Its
 *     `--env-inherit=none --dir=none --tcplisten=none` profile is the right default for an
 *     untrusted plugin — Node's `node:wasi` runs in-process and shares the Node heap.
 *   - The plugin still speaks the same line-delimited JSON-RPC 2.0 over stdio it would
 *     in any other transport, so the plugin author writes their code once.
 *
 * What WASM buys you over a Node subprocess:
 *   - Cannot fork, exec, or open arbitrary sockets — only the WASI imports wasmtime
 *     exposes. With the default profile, that's stdio only.
 *   - Cannot read or write the host filesystem unless we explicitly `--dir` a path in.
 *   - Cannot reach the host's memory; the WASM linear memory is fully isolated.
 *
 * Operators must have **wasmtime** on `PATH` (or pass `wasmtimePath`) in any image that
 * mounts a WASM plugin. The wasmtime binary is not bundled — there's no Node-side
 * runtime to ship.
 */
import type { RemoteProcessSpec } from "./remote";

export interface WasmPluginSpec {
  /** Filesystem path to the plugin's `.wasm` file. Compiled to WASI preview-1. */
  wasmPath: string;
  /**
   * Path to the wasmtime binary. Defaults to `wasmtime` (resolved via `PATH`). Use this
   * to pin a specific version baked into the deployment image.
   */
  wasmtimePath?: string;
  /**
   * Argv passed to the WASM module (after wasmtime's own flags). Most plugins won't need
   * any — config flows over the JSON-RPC `configure` call.
   */
  args?: readonly string[];
  /**
   * Env vars exposed to the WASM module. **Empty by default** (wasmtime is invoked with
   * `--env-inherit=none`). Anything you list here is passed through verbatim, so leak
   * audit applies: don't put secrets here that the plugin shouldn't see.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Filesystem grants for the plugin, mapped as `host=guest`. Off by default — the WASM
   * cannot see any host paths unless you list them. The host path is opened read-only
   * unless you suffix `:rw` (e.g. `/var/run/plugin-state=/state:rw`).
   *
   * Most plugins shouldn't need any: state belongs in arc's KV, not on disk.
   */
  dirs?: readonly string[];
  /**
   * Forwarded to {@link RemoteSecretsPlugin.spawn} verbatim. Useful to bump the RPC
   * timeout for heavyweight plugins.
   */
  rpcTimeoutMs?: number;
  shutdownGraceMs?: number;
}

/**
 * Build the {@link RemoteProcessSpec} that runs a WASM plugin under wasmtime with a
 * deny-by-default sandbox profile. Pass the result to
 * {@link RemoteSecretsPlugin.spawn} (or arc-server's `PluginsService.mountRemoteSecretsPlugin`).
 *
 * The wasmtime invocation pins these defaults:
 *   - `--env-inherit=none`        — only env vars you list pass through
 *   - `--dir=none`                — no filesystem access unless you list dirs
 *   - `--tcplisten=none`          — cannot listen on a socket
 *   - WASI preview-1 (the stable target most language toolchains hit today)
 */
export function buildWasmtimeSpec(spec: WasmPluginSpec): RemoteProcessSpec {
  const wasmtime = spec.wasmtimePath ?? "wasmtime";

  // wasmtime invocation form:
  //   wasmtime run <profile flags> <wasm path> -- <plugin argv>
  const flags: string[] = [
    "run",
    // Deny-by-default WASI environment.
    "--env-inherit=none",
    "--dir=none",
    "--tcplisten=none",
  ];

  // --env=K=V for each authorized env var. wasmtime supports the same flag repeated.
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    flags.push(`--env=${k}=${v}`);
  }
  for (const d of spec.dirs ?? []) {
    flags.push(`--dir=${d}`);
  }

  return {
    command: wasmtime,
    args: [...flags, spec.wasmPath, "--", ...(spec.args ?? [])],
    // Empty host env: wasmtime itself doesn't need anything, and we already pass any
    // plugin-visible env through `--env=` so it lands inside the sandbox.
    env: {},
    rpcTimeoutMs: spec.rpcTimeoutMs,
    shutdownGraceMs: spec.shutdownGraceMs,
  };
}
