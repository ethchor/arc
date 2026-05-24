// Popup runs under the extension's own CSP (no inline scripts). It collects the unlock
// inputs, asks the background worker to unlock, and — on Fill — tells the active tab's
// content script to perform a user-initiated, origin-bound autofill.
import type { UnlockResponse } from "./messages";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

byId<HTMLButtonElement>("unlock").addEventListener("click", () => {
  const baseUrl = byId<HTMLInputElement>("baseUrl").value;
  const email = byId<HTMLInputElement>("email").value;
  const masterPassword = byId<HTMLInputElement>("pw").value;
  chrome.runtime.sendMessage(
    { type: "arc:unlock", baseUrl, email, masterPassword },
    (resp: UnlockResponse) => {
      byId<HTMLElement>("status").textContent = resp.ok ? "unlocked" : `error: ${resp.error ?? "unknown"}`;
    },
  );
});

byId<HTMLButtonElement>("fill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "arc:doFill" });
});
