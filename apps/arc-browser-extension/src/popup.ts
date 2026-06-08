// Popup runs under the extension's own CSP (no inline scripts). Keys never live here; it
// lists metadata from the background worker and fetches a single credential on demand.
import type { Creds, LoginMeta, UnlockResponse } from "./messages";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(r as T)));
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setStatus(text: string): void {
  byId("status").textContent = text;
}

let all: LoginMeta[] = [];

function chip(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function render(filter = ""): void {
  const list = byId("list");
  list.textContent = "";
  const q = filter.trim().toLowerCase();
  const rows = all.filter((m) => !q || [m.title, m.username, m.url].some((s) => s.toLowerCase().includes(q)));

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = all.length === 0 ? "No logins yet." : "No matches.";
    list.appendChild(empty);
    return;
  }

  for (const m of rows) {
    const row = document.createElement("div");
    row.className = "row";

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = m.title;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = m.username || m.url;
    meta.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      chip("Fill", async () => {
        const creds = await send<Creds | null>({ type: "arc:get", id: m.id });
        const tabId = await activeTabId();
        if (creds && tabId) {
          chrome.tabs.sendMessage(tabId, { type: "arc:fillValues", username: creds.username, password: creds.password });
          setStatus("Filled the active page");
        }
      }),
      chip("User", async () => {
        await navigator.clipboard.writeText(m.username);
        setStatus("Username copied");
      }),
      chip("Pass", async () => {
        const creds = await send<Creds | null>({ type: "arc:get", id: m.id });
        if (creds) {
          await navigator.clipboard.writeText(creds.password);
          setStatus("Password copied (clears in 20s)");
          setTimeout(() => void navigator.clipboard.writeText("").catch(() => {}), 20_000);
        }
      }),
    );

    row.append(meta, actions);
    list.appendChild(row);
  }
}

async function showVault(): Promise<void> {
  byId("unlock-view").hidden = true;
  byId("vault-view").hidden = false;
  all = (await send<LoginMeta[]>({ type: "arc:list" })) ?? [];
  render();
}

byId<HTMLButtonElement>("unlock").addEventListener("click", async () => {
  setStatus("Unlocking…");
  const resp = await send<UnlockResponse>({
    type: "arc:unlock",
    baseUrl: byId<HTMLInputElement>("baseUrl").value,
    email: byId<HTMLInputElement>("email").value,
    masterPassword: byId<HTMLInputElement>("pw").value,
  });
  if (resp.ok) {
    setStatus("");
    await showVault();
  } else {
    setStatus(`Error: ${resp.error ?? "unknown"}`);
  }
});

// Passkey-first unlock (ADR-008). The primary path: no email field, no password — one tap.
byId<HTMLButtonElement>("passkey-unlock").addEventListener("click", async () => {
  setStatus("Waiting for passkey…");
  const resp = await send<UnlockResponse>({
    type: "arc:passkeyUnlock",
    baseUrl: byId<HTMLInputElement>("baseUrl").value,
  });
  if (resp.ok) {
    setStatus("");
    await showVault();
  } else {
    setStatus(`Error: ${resp.error ?? "unknown"}`);
  }
});

// Reveal the master-password fallback form on demand.
byId<HTMLButtonElement>("show-pw").addEventListener("click", () => {
  byId("pw-form").hidden = false;
  byId("show-pw").hidden = true;
  byId<HTMLInputElement>("email").focus();
});

byId<HTMLInputElement>("search").addEventListener("input", (e) => render((e.target as HTMLInputElement).value));

byId<HTMLButtonElement>("fillpage").addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: "arc:doFill" });
  setStatus("Origin-bound fill requested for this page");
});
