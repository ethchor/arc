// Dedicated Web Worker that runs the Argon2id-heavy crypto (enroll / unlock / recover) off
// the main thread. The KDF is a synchronous, multi-second, memory-hard computation; running
// it on the UI thread freezes the tab while the "Creating vault" / "Recovering…" spinner
// keeps animating (CSS animations run on the compositor). Here it runs in the worker, so the
// UI stays responsive and the spinner is honest.
//
// It reuses the SDK's `inProcessCryptoEngine` — the exact same crypto path as Node/CLI — so
// there is a single source of truth for the derivation; the worker only moves *where* it runs.
import { inProcessCryptoEngine } from "@arc/sdk";
import type { Keyset } from "@arc/crypto";

type ArgonProfile = "desktop" | "mobile" | "test";

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
        result = await inProcessCryptoEngine.enroll(msg.masterPassword, { profile: msg.profile });
        break;
      case "computeAuthHash":
        result = await inProcessCryptoEngine.computeAuthHash(msg.masterPassword, msg.keyset);
        break;
      case "unlock":
        result = await inProcessCryptoEngine.unlock(msg.masterPassword, msg.keyset);
        break;
      case "recover":
        result = await inProcessCryptoEngine.recover(
          msg.recoveryKey,
          msg.keyset,
          msg.newMasterPassword,
          { profile: msg.profile },
        );
        break;
    }
    ctx.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
