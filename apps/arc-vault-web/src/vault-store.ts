import { VaultClient } from "@arc/sdk";

// The VaultClient — and therefore every unlocked key (WK, identity/signing privs, VKs) —
// lives ONLY in this module-scoped variable. It is never written to localStorage,
// sessionStorage, IndexedDB, or any React state that could serialize (docs/12 §12.1).
let client: VaultClient | null = null;

export function initClient(baseUrl: string): VaultClient {
  client = new VaultClient({ baseUrl });
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
