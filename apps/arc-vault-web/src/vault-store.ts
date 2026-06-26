import { VaultClient } from "@arc/sdk";
import { createWorkerCryptoEngine } from "@/lib/crypto/worker-crypto-engine";

// The VaultClient — and therefore every unlocked key (WK, identity/signing privs, VKs) —
// lives ONLY in this module-scoped variable. It is never written to localStorage,
// sessionStorage, IndexedDB, or any React state that could serialize (docs/12 §12.1).
let client: VaultClient | null = null;

export function initClient(baseUrl: string, onUnauthorized?: () => void): VaultClient {
  // Run the Argon2id-heavy enroll/unlock/recover in a Web Worker so it doesn't freeze the UI
  // thread (the spinner kept animating while the tab was blocked). Guard on `Worker` so any
  // non-browser context falls back to the SDK's in-process engine.
  client = new VaultClient({
    baseUrl,
    crypto: typeof Worker !== "undefined" ? createWorkerCryptoEngine() : undefined,
    onUnauthorized,
  });
  return client;
}

export function getClient(): VaultClient {
  if (!client) throw new Error("vault client not initialized");
  return client;
}

/** Drop the only reference to the client and its keys (best-effort lock). */
export function lock(): void {
  client = null;
}
