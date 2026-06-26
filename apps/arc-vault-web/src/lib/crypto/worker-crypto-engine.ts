import type { CryptoEngine } from "@arc/sdk";
import type { EnrollResult, RecoverResult, Session } from "@arc/crypto";

interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * A {@link CryptoEngine} that runs the Argon2id-heavy enroll / unlock / recover in a dedicated
 * Web Worker, so password stretching never blocks the main thread — no frozen tab behind the
 * "Creating vault" / "Recovering…" spinner. The worker is created lazily on first use and
 * reused for the session; requests are correlated by an incrementing id.
 *
 * Only call this in the browser (guard on `typeof Worker`). Falling back to the SDK's default
 * in-process engine (no `crypto` option) is always safe — it just blocks the thread.
 */
export function createWorkerCryptoEngine(): CryptoEngine {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, PendingResolver>();

  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { id, ok, result, error } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error ?? "crypto worker error"));
    };
    w.onerror = (event) => {
      // A worker-level failure (e.g. it failed to load) rejects everything in flight so the
      // caller surfaces a real error instead of hanging, and the next call respawns it.
      const err = new Error(event.message || "crypto worker crashed");
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      worker = null;
    };
    worker = w;
    return w;
  }

  function call<T>(message: Record<string, unknown>): Promise<T> {
    const w = ensureWorker();
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      w.postMessage({ ...message, id });
    });
  }

  return {
    enroll: (masterPassword, opts) =>
      call<EnrollResult>({ op: "enroll", masterPassword, profile: opts.profile }),
    computeAuthHash: (masterPassword, keyset) =>
      call<string>({ op: "computeAuthHash", masterPassword, keyset }),
    unlock: (masterPassword, keyset) =>
      call<Session>({ op: "unlock", masterPassword, keyset }),
    recover: (recoveryKey, keyset, newMasterPassword, opts) =>
      call<RecoverResult>({
        op: "recover",
        recoveryKey,
        keyset,
        newMasterPassword,
        profile: opts.profile,
      }),
  };
}
