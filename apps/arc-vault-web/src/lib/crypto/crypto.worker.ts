// Dedicated Web Worker that runs the Argon2id-heavy crypto (enroll / unlock / recover) off
// the main thread, using a **WASM** Argon2id (hash-wasm) — ~10–50× faster than the pure-JS
// fallback, and byte-identical to it (proven in @arc/crypto's argon2-wasm-parity.test.ts, so
// a vault stays interoperable across the WASM and pure-JS paths).
//
// The KDF is a synchronous, memory-hard computation; running it on the UI thread froze the tab
// while the "Creating vault" / "Recovering…" spinner kept animating. Here it runs in the worker
// *and* uses WASM, so it's both off-thread and fast.
import { enroll, unlock, computeAuthHash, recover, type Argon2idFn, type Keyset } from "@arc/crypto";
import { argon2id as wasmArgon2id } from "hash-wasm";

type ArgonProfile = "desktop" | "mobile" | "test";

// hash-wasm inlines its WASM as base64, so there's no separate .wasm asset to fetch — it
// bundles cleanly into the worker. `memorySize` is KiB, matching @arc/crypto's `m`.
const wasmArgon2: Argon2idFn = (password, salt, p) =>
  wasmArgon2id({
    password,
    salt,
    parallelism: p.p,
    iterations: p.t,
    memorySize: p.m,
    hashLength: p.dkLen,
    outputType: "binary",
  });

type WorkerRequest =
  | { id: number; op: "enroll"; masterPassword: string; profile?: ArgonProfile }
  | { id: number; op: "computeAuthHash"; masterPassword: string; keyset: Keyset }
  | { id: number; op: "unlock"; masterPassword: string; keyset: Keyset }
  | {
      id: number;
      op: "recover";
      recoveryKey: string;
      keyset: Keyset;
      newMasterPassword: string;
      profile?: ArgonProfile;
    };

// Cast to a minimal worker-scope shape so this file doesn't need the `webworker` lib (which
// conflicts with the app's `dom` lib over `self`/`postMessage`).
const ctx = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

ctx.onmessage = async (event) => {
  const msg = event.data;
  try {
    let result: unknown;
    switch (msg.op) {
      case "enroll":
        result = await enroll(msg.masterPassword, { profile: msg.profile, argon2: wasmArgon2 });
        break;
      case "computeAuthHash":
        result = await computeAuthHash(msg.masterPassword, msg.keyset, wasmArgon2);
        break;
      case "unlock":
        result = await unlock(msg.masterPassword, msg.keyset, wasmArgon2);
        break;
      case "recover":
        result = await recover(msg.recoveryKey, msg.keyset, msg.newMasterPassword, {
          profile: msg.profile,
          argon2: wasmArgon2,
        });
        break;
    }
    ctx.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
