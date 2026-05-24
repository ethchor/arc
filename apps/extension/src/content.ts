// Isolated-world content script. Holds NO key material. Autofill is user-initiated (the
// popup triggers it); the script asks the background worker for a credential bound to this
// page's origin and types the returned values into the form.
import type { DoFill, FillResponse } from "./messages";

function fill(username: string, password: string): void {
  const userField = document.querySelector<HTMLInputElement>(
    'input[type="email"], input[autocomplete="username"], input[name*="user" i]',
  );
  const passField = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (userField) {
    userField.value = username;
    userField.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (passField) {
    passField.value = password;
    passField.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function requestFill(): void {
  chrome.runtime.sendMessage({ type: "arc:requestFill", pageUrl: location.href }, (resp: FillResponse) => {
    if (resp && resp.ok) fill(resp.username, resp.password);
  });
}

chrome.runtime.onMessage.addListener((message: DoFill) => {
  if (message.type === "arc:doFill") requestFill();
});
