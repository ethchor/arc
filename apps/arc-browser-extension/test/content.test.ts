// @vitest-environment happy-dom
/**
 * Content-script tests. Drive `onPasswordFocus` with a happy-dom document + a stubbed
 * chrome.runtime.sendMessage so we can assert the overlay show/hide behavior without
 * loading the extension in a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SendMessage extends ReturnType<typeof vi.fn> {}
let sendMessage: SendMessage;

beforeEach(() => {
  sendMessage = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage,
      onMessage: { addListener: vi.fn() },
    },
  };
  Object.defineProperty(window, "location", {
    value: { href: "https://example.com/login", protocol: "https:" },
    writable: true,
  });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.resetModules();
});

async function loadModule() {
  const mod = await import("../src/content");
  mod.__internal.resetOverlayState();
  return mod;
}

function makePasswordField(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "password";
  document.body.appendChild(input);
  return input;
}

describe("onPasswordFocus — inline suggestion overlay", () => {
  it("shows the overlay when the background returns an origin-matched credential", async () => {
    const mod = await loadModule();
    sendMessage.mockImplementation((_msg, cb) => cb({ ok: true, username: "u", password: "p" }));

    mod.onPasswordFocus(makePasswordField());

    expect(sendMessage).toHaveBeenCalledWith(
      { type: "arc:requestFill", pageUrl: "https://example.com/login" },
      expect.any(Function),
    );
    const overlay = document.getElementById("arc-vault-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toBe("Use arc");
  });

  it("does NOT show the overlay when the background reports no match", async () => {
    const mod = await loadModule();
    sendMessage.mockImplementation((_msg, cb) => cb({ ok: false, reason: "no credential" }));

    mod.onPasswordFocus(makePasswordField());

    expect(document.getElementById("arc-vault-overlay")).toBeNull();
  });

  it("does NOT show the overlay on non-HTTPS pages", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "http://example.com/login", protocol: "http:" },
      writable: true,
    });
    const mod = await loadModule();

    mod.onPasswordFocus(makePasswordField());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("arc-vault-overlay")).toBeNull();
  });

  it("does NOT show the overlay twice on the same page (anti-spam)", async () => {
    const mod = await loadModule();
    sendMessage.mockImplementation((_msg, cb) => cb({ ok: true, username: "u", password: "p" }));

    mod.onPasswordFocus(makePasswordField());
    expect(document.getElementById("arc-vault-overlay")).not.toBeNull();

    document.getElementById("arc-vault-overlay")?.remove();
    mod.onPasswordFocus(makePasswordField());
    expect(document.getElementById("arc-vault-overlay")).toBeNull();
  });

  it("only fires for password-typed inputs", async () => {
    const mod = await loadModule();
    const text = document.createElement("input");
    text.type = "text";
    document.body.appendChild(text);

    mod.onPasswordFocus(text);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("overlay click → fills the form", () => {
  it("clicking the overlay fills username + password into the page fields", async () => {
    const mod = await loadModule();
    const user = document.createElement("input");
    user.type = "text";
    user.autocomplete = "username";
    document.body.appendChild(user);
    const pw = makePasswordField();

    sendMessage.mockImplementation((_msg, cb) =>
      cb({ ok: true, username: "alice@example.com", password: "hunter2" }),
    );
    mod.onPasswordFocus(pw);
    document.getElementById("arc-vault-overlay")?.click();

    expect(user.value).toBe("alice@example.com");
    expect(pw.value).toBe("hunter2");
    expect(document.getElementById("arc-vault-overlay")).toBeNull();
  });
});
