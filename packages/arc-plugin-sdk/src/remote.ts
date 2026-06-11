/**
 * Out-of-process plugin host. Speaks JSON-RPC 2.0 over the child's stdio (one JSON object
 * per line on stdout; one per line on stdin), wrapping the child as an in-process
 * `SecretsPlugin` so arc-server's existing dispatch pipeline doesn't need to know whether
 * a plugin is local or remote.
 *
 * Why JSON-RPC over stdio:
 *   - No network ports → no firewall, no port conflicts, naturally process-bound lifetime.
 *   - Stable wire (LSP / Vault external plugins use the same shape) so a non-Node plugin
 *     can implement the same protocol in any language.
 *   - The child only sees its own configure / issue / renew / revoke surface — it cannot
 *     reach arc-server's database, the master vault key, or any other plugin. That's the
 *     whole point: this is the *sandbox boundary* the in-process host doesn't have.
 *
 * WASM (wasmtime) is a separate backend that will plug in behind the same `RemoteTransport`
 * later; the process backend lands first because it requires no new heavy dependencies.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "./types";

export interface RemoteProcessSpec {
  /** Executable to spawn (e.g. `node` or a path to a plugin binary). */
  command: string;
  /** Argv passed to the child. */
  args?: readonly string[];
  /** Environment vars merged on top of an *empty* env — the child sees only what we list. */
  env?: Readonly<Record<string, string>>;
  /** Working directory for the child. */
  cwd?: string;
  /** Maximum time to wait for a single RPC response (default 30 s). */
  rpcTimeoutMs?: number;
  /** Grace period after SIGTERM before sending SIGKILL on `close()` (default 5 s). */
  shutdownGraceMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Error surfaced when the remote child rejects an RPC or exits with calls in flight. */
export class RemotePluginError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "RemotePluginError";
  }
}

/**
 * Host-side view of a remote secrets plugin. Implements the standard `SecretsPlugin`
 * interface so the rest of arc-server can treat it identically to an in-process plugin.
 * Construct with `RemoteSecretsPlugin.spawn(spec)` — that awaits the `meta` handshake so
 * the returned plugin's `meta` property is real.
 */
export class RemoteSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta;

  private child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stdoutBuf = "";
  private closing = false;
  private exitReason: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly rpcTimeoutMs: number;
  private readonly shutdownGraceMs: number;

  /** Spawn the plugin process and complete the meta handshake. */
  static async spawn(spec: RemoteProcessSpec): Promise<RemoteSecretsPlugin> {
    // SECURITY: undefined env on Node's `child_process.spawn` *inherits* the parent's
    // process.env, which would hand a plugin arc-server's JWT_SECRET, BAO_TOKEN,
    // DATABASE_URL, ARC_PUBLISHER_PRIV, etc. — exactly what `RemoteProcessSpec.env`'s
    // doc forbids ("merged on top of an *empty* env"). Honor the contract by treating
    // `undefined` as the empty env. Operators who need passthrough list specific keys
    // (e.g. AWS_REGION) in `spec.env`; the build helper at `apps/arc-server`'s
    // `plugin-mounts.ts` populates them from `process.env` when the operator opts in
    // via the `env=` query param on `ARC_PLUGIN_MOUNTS`.
    const childEnv = (spec.env ?? {}) as NodeJS.ProcessEnv;
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      env: childEnv,
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handshake = new Promise<{ rpc: RemoteSecretsPlugin["rpc"]; child: ChildProcess; meta: PluginMeta }>((resolve, reject) => {
      let opened = false;
      child.once("spawn", () => {
        opened = true;
      });
      child.once("error", (err) => {
        if (!opened) reject(new RemotePluginError(`spawn failed: ${err.message}`));
      });
      // Defer the handshake one tick so the listeners below are attached first.
      queueMicrotask(() => {
        const instance = new RemoteSecretsPlugin(child, spec.rpcTimeoutMs ?? 30_000, spec.shutdownGraceMs ?? 5_000);
        instance
          .rpc("meta", {})
          .then((meta) => resolve({ rpc: instance.rpc.bind(instance), child, meta: meta as PluginMeta }))
          .catch((err) => {
            instance.close().catch(() => undefined);
            reject(err);
          });
      });
    });
    const { meta } = await handshake;
    return new RemoteSecretsPlugin(child, spec.rpcTimeoutMs ?? 30_000, spec.shutdownGraceMs ?? 5_000, meta);
  }

  private constructor(child: ChildProcess, rpcTimeoutMs: number, shutdownGraceMs: number, meta?: PluginMeta) {
    this.child = child;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.meta = meta ?? { name: "<pending>", version: "0", kind: "secrets" };

    // Stdout: line-delimited JSON responses.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));

    // Stderr is mirrored to ours so plugin author errors surface in the server logs.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // eslint-disable-next-line no-console
      process.stderr.write(`[remote-plugin] ${chunk}`);
    });

    child.once("exit", (code, signal) => {
      this.exitReason = { code, signal };
      const err = new RemotePluginError(`plugin process exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      for (const [id, p] of this.pending.entries()) {
        clearTimeout(p.timer);
        p.reject(err);
        this.pending.delete(id);
      }
    });
  }

  async configure(input: unknown): Promise<void> {
    await this.rpc("configure", { input });
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    return (await this.rpc("issue", req)) as IssuedSecret;
  }

  async renew(leaseId: string): Promise<LeaseInfo> {
    return (await this.rpc("renew", { leaseId })) as LeaseInfo;
  }

  async revoke(leaseId: string): Promise<void> {
    await this.rpc("revoke", { leaseId });
  }

  /** Graceful shutdown: SIGTERM, wait `shutdownGraceMs`, then SIGKILL. Idempotent. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.exitReason) return; // already gone
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.exitReason) this.child.kill("SIGKILL");
      }, this.shutdownGraceMs);
      this.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Send one JSON-RPC request; resolve with `result` or reject with `RemotePluginError`. */
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.exitReason) {
      return Promise.reject(new RemotePluginError(`plugin process already exited (code=${this.exitReason.code})`));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemotePluginError(`RPC '${method}' timed out after ${this.rpcTimeoutMs}ms`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const ok = this.child.stdin?.write(JSON.stringify(req) + "\n");
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RemotePluginError("plugin stdin is not writable"));
      }
    });
  }

  /** Parse line-delimited JSON-RPC responses out of the stdout buffer. */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length > 0) this.dispatchLine(line);
      nl = this.stdoutBuf.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      process.stderr.write(`[remote-plugin] non-JSON stdout line: ${line}\n`);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // late response after timeout — drop
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      p.reject(new RemotePluginError(msg.error.message, msg.error.code, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }
}
