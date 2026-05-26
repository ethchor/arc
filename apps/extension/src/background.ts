// MV3 service worker: the ONLY place the unlocked session and crypto keys live (docs/12 §12.4).
// The content script never receives key material — only the specific values to fill, and only
// after this worker enforces HTTPS + registrable-domain origin binding. The popup (a privileged
// extension page, not the page DOM) may list metadata and fetch a single credential on demand.
import { VaultClient } from "@arc-vault/sdk";
import { originMatches } from "./origin";
import type { BackgroundMessage, Creds, FillResponse, LoginMeta, UnlockResponse } from "./messages";

interface LoginEntry extends LoginMeta {
  password: string;
}

let client: VaultClient | null = null;
let logins: LoginEntry[] = [];

async function unlock(baseUrl: string, email: string, masterPassword: string): Promise<UnlockResponse> {
  try {
    client = new VaultClient({ baseUrl });
    await client.devLogin(email);
    await client.unlock(masterPassword);
    const vaults = await client.listVaults();
    const next: LoginEntry[] = [];
    for (const v of vaults) {
      const { items } = await client.pull(v.id, 0);
      for (const item of items) {
        if (item.deleted) continue;
        const d = item.data as
          | { type?: string; title?: string; fields?: { url?: string; username?: string; password?: string } }
          | null;
        if (d?.type === "login" && d.fields?.url) {
          next.push({
            id: item.id,
            title: d.title ?? d.fields.url,
            url: d.fields.url,
            username: d.fields.username ?? "",
            password: d.fields.password ?? "",
          });
        }
      }
    }
    logins = next;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type === "arc:unlock") {
    void unlock(message.baseUrl, message.email, message.masterPassword).then(sendResponse);
    return true;
  }
  if (message.type === "arc:list") {
    const metas: LoginMeta[] = logins.map(({ id, title, url, username }) => ({ id, title, url, username }));
    sendResponse(metas);
    return true;
  }
  if (message.type === "arc:get") {
    const found = logins.find((l) => l.id === message.id);
    const creds: Creds | null = found ? { username: found.username, password: found.password } : null;
    sendResponse(creds);
    return true;
  }
  if (message.type === "arc:requestFill") {
    const match = logins.find((l) => originMatches(message.pageUrl, l.url));
    const resp: FillResponse = match
      ? { ok: true, username: match.username, password: match.password }
      : { ok: false, reason: "no credential bound to this origin" };
    sendResponse(resp);
    return true;
  }
  return false;
});
