// Isolated-world content script. Holds NO key material. Two affordances:
//
//  1. Explicit fill — popup sends `arc:doFill` (origin-matched) or `arc:fillValues`
//     (specific credential). Same as the original scaffold.
//
//  2. Inline suggestion overlay — when a password field gets focused on an HTTPS page,
//     the script asks the background worker if it has an origin-matched credential. If
//     yes, a small floating "Use arc" affordance appears anchored above the field; one
//     click fills. Shown at most once per page load (a re-show would feel spammy).
//
// Both affordances are user-initiated: the overlay is a visible button that the user must
// click, never an auto-fill on focus.
import type { ContentMessage, FillResponse } from "./messages";

const OVERLAY_ID = "arc-vault-overlay";
let overlayShown = false;

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

function removeOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

function showOverlay(target: HTMLInputElement, onClick: () => void): void {
  removeOverlay();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "tooltip");
  overlay.textContent = "Use arc";
  // Inline styling: no external CSS, and we want predictable layout independent of the
  // host page's CSS. Anchor above the focused field, fall back to fixed top-right.
  const r = target.getBoundingClientRect();
  Object.assign(overlay.style, {
    position: "absolute",
    top: `${window.scrollY + r.top - 32}px`,
    left: `${window.scrollX + r.left}px`,
    padding: "4px 10px",
    background: "#0b0d12",
    color: "#fafafa",
    font: "12px/1 system-ui, sans-serif",
    border: "1px solid #2d2d2d",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    cursor: "pointer",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);
  overlay.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
    removeOverlay();
  });
  document.body.appendChild(overlay);
  // Drop the overlay if the user clicks anywhere else.
  const onDocClick = (evt: MouseEvent) => {
    if (evt.target !== overlay) {
      removeOverlay();
      document.removeEventListener("mousedown", onDocClick, true);
    }
  };
  document.addEventListener("mousedown", onDocClick, true);
}

/**
 * Focus handler — when a password field is focused, ask the background worker for an
 * origin-matched credential, and if one exists, render the inline suggestion overlay.
 *
 * Exported for unit tests; the runtime wires it via the focusin listener below.
 */
export function onPasswordFocus(target: HTMLInputElement): void {
  if (overlayShown) return;
  if (location.protocol !== "https:") return;
  if (target.type !== "password") return;
  chrome.runtime.sendMessage(
    { type: "arc:requestFill", pageUrl: location.href },
    (resp: FillResponse) => {
      if (!resp || !resp.ok) return;
      overlayShown = true;
      showOverlay(target, () => fill(resp.username, resp.password));
    },
  );
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.type === "password") {
        onPasswordFocus(target);
      }
    },
    { passive: true },
  );
}

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  if (message.type === "arc:doFill") {
    chrome.runtime.sendMessage({ type: "arc:requestFill", pageUrl: location.href }, (resp: FillResponse) => {
      if (resp && resp.ok) fill(resp.username, resp.password);
    });
  } else if (message.type === "arc:fillValues") {
    fill(message.username, message.password);
  }
});

// Test hook — reset between cases.
export const __internal = {
  resetOverlayState(): void {
    overlayShown = false;
    removeOverlay();
  },
};
