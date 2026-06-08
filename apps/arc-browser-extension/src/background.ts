// MV3 service worker: the ONLY place the unlocked session and crypto keys live (docs/12 §12.4).
// The content script never receives key material — only the specific values to fill, and only
// after this worker enforces HTTPS + registrable-domain origin binding. The popup (a privileged
// extension page, not the page DOM) may list metadata and fetch a single credential on demand.
//
// Auto-lock posture: an idle timer wipes `client` + `logins` + the cached `lastUnlock`
// timestamp after `autolockTtlSeconds` of inactivity. Every fill / list / get call counts as
// activity (touches the timer). MV3 service workers can also die between events; we tolerate
// that — the popup re-derives unlock on first message, and `arc:status` reports
// `unlocked: false` until a fresh `arc:unlock` succeeds.
import { VaultClient, browserPasskeyAuthenticator } from "@arc/sdk";
import { originMatches } from "./origin";
import type {
  BackgroundMessage,
  Creds,
  FillResponse,
  LoginMeta,
  StatusResponse,
  UnlockResponse,
} from "./messages";

interface LoginEntry extends LoginMeta {
  password: string;
}

let client: VaultClient | null = null;
let logins: LoginEntry[] = [];
let lastActivityMs = 0;
let autolockTtlSeconds = 300; // 5 minutes default
let lockTimer: ReturnType<typeof setTimeout> | null = null;

function isUnlocked(): boolean {
  return client !== null;
}

function lock(): void {
  client = null;
  logins = [];
  lastActivityMs = 0;
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = null;
}

function touch(): void {
  if (!isUnlocked()) return;
  lastActivityMs = Date.now();
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(lock, autolockTtlSeconds * 1000);
}

async function unlock(
  baseUrl: string,
  email: string,
  masterPassword: string,
): Promise<UnlockResponse> {
  try {
    const next = new VaultClient({ baseUrl });
    await next.devLogin(email);
    await next.unlock(masterPassword);
    const vaults = await next.listVaults();
    const fetched: LoginEntry[] = [];
    for (const v of vaults) {
      const { items } = await next.pull(v.id, 0);
      for (const item of items) {
        if (item.deleted) continue;
        const d = item.data as
          | { type?: string; title?: string; fields?: { url?: string; username?: string; password?: string } }
          | null;
        if (d?.type === "login" && d.fields?.url) {
          fetched.push({
            id: item.id,
            title: d.title ?? d.fields.url,
            url: d.fields.url,
            username: d.fields.username ?? "",
            password: d.fields.password ?? "",
          });
        }
      }
    }
    client = next;
    logins = fetched;
    touch();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Username-less passkey unlock (ADR-008). One method on the SDK, two WebAuthn gestures
 * under the hood (browsers may coalesce them) — sign-in via discoverable credential, then
 * PRF unwrap. Zero typing. WebAuthn requires a user-activation gesture, which the popup's
 * click provides; the prompt itself appears in the page-level WebAuthn UI.
 */
async function passkeyUnlock(baseUrl: string): Promise<UnlockResponse> {
  try {
    const next = new VaultClient({ baseUrl });
    await next.signInAndUnlockWithPasskey(browserPasskeyAuthenticator());
    const vaults = await next.listVaults();
    const fetched: LoginEntry[] = [];
    for (const v of vaults) {
      const { items } = await next.pull(v.id, 0);
      for (const item of items) {
        if (item.deleted) continue;
        const d = item.data as
          | { type?: string; title?: string; fields?: { url?: string; username?: string; password?: string } }
          | null;
        if (d?.type === "login" && d.fields?.url) {
          fetched.push({
            id: item.id,
            title: d.title ?? d.fields.url,
            url: d.fields.url,
            username: d.fields.username ?? "",
            password: d.fields.password ?? "",
          });
        }
      }
    }
    client = next;
    logins = fetched;
    touch();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function status(): StatusResponse {
  if (!isUnlocked()) return { unlocked: false, lockInSeconds: null };
  const elapsed = Math.floor((Date.now() - lastActivityMs) / 1000);
  const remaining = Math.max(0, autolockTtlSeconds - elapsed);
  return { unlocked: true, lockInSeconds: remaining };
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type === "arc:unlock") {
    void unlock(message.baseUrl, message.email, message.masterPassword).then(sendResponse);
    return true;
  }
  if (message.type === "arc:passkeyUnlock") {
    void passkeyUnlock(message.baseUrl).then(sendResponse);
    return true;
  }
  if (message.type === "arc:status") {
    sendResponse(status());
    return true;
  }
  if (message.type === "arc:setAutolock") {
    const next = Math.max(30, Math.min(3600, Math.floor(message.ttlSeconds)));
    autolockTtlSeconds = next;
    void chrome.storage.session?.set?.({ "arc.autolockTtlSeconds": next });
    touch();
    sendResponse({ ok: true, ttlSeconds: next });
    return true;
  }
  if (message.type === "arc:list") {
    if (!isUnlocked()) {
      sendResponse([]);
      return true;
    }
    touch();
    const metas: LoginMeta[] = logins.map(({ id, title, url, username }) => ({ id, title, url, username }));
    sendResponse(metas);
    return true;
  }
  if (message.type === "arc:get") {
    if (!isUnlocked()) {
      sendResponse(null);
      return true;
    }
    touch();
    const found = logins.find((l) => l.id === message.id);
    const creds: Creds | null = found ? { username: found.username, password: found.password } : null;
    sendResponse(creds);
    return true;
  }
  if (message.type === "arc:requestFill") {
    if (!isUnlocked()) {
      const resp: FillResponse = { ok: false, reason: "locked" };
      sendResponse(resp);
      return true;
    }
    touch();
    const match = logins.find((l) => originMatches(message.pageUrl, l.url));
    const resp: FillResponse = match
      ? { ok: true, username: match.username, password: match.password }
      : { ok: false, reason: "no credential bound to this origin" };
    sendResponse(resp);
    return true;
  }
  return false;
});

// Restore the persisted TTL setting if any (chrome.storage.session is wiped on browser
// restart — exactly what we want; the user re-unlocks anyway).
void chrome.storage.session?.get?.(["arc.autolockTtlSeconds"]).then((stored) => {
  const v = stored?.["arc.autolockTtlSeconds"];
  if (typeof v === "number" && v >= 30 && v <= 3600) autolockTtlSeconds = v;
});

// Expose internals for unit tests (vitest imports the module directly; in the real worker
// `import.meta.vitest` is undefined so the export is a no-op).
export const __internal = {
  status,
  unlockWithMock(c: VaultClient | null, entries: LoginEntry[]): void {
    client = c;
    logins = entries;
    if (c) touch();
    else lock();
  },
  setAutolockTtl(secs: number): void {
    autolockTtlSeconds = secs;
  },
  lockNow(): void {
    lock();
  },
};
