"use client";

/**
 * Typed bindings for the Tauri shell. When the web app runs inside the desktop shell
 * (`apps/arc-vault-desktop`), these forward to the Rust `#[tauri::command]`s defined in
 * `src-tauri/src/lib.rs`. When the app runs in a regular browser (`next dev`), `isDesktop`
 * returns false and callers fall back to the in-browser crypto path.
 *
 * Why the dance: the bindings depend on `@tauri-apps/api`, which `next dev` happily bundles
 * but only actually wires to a real backend inside the Tauri WebView. The
 * `window.__TAURI_INTERNALS__` sniff is the official Tauri v2 detect.
 *
 * Public surface (matches the Rust commands 1:1):
 *
 *   Session    — setAutolock / lock / isLocked / touch
 *   Device     — generateDeviceKeypair / loadGrant / wrapVekForDevice
 *   Item ops   — encryptItem / decryptItem  (VEK never crosses to the WebView)
 *   Cache      — cacheOpen / cacheUpsert / cacheGet / cacheList
 *   Events     — onLocked(cb)                (subscribe to the lock-tick event)
 */

import type { Event } from "@tauri-apps/api/event";

// The two helpers we touch — dynamically imported so plain browser builds don't crash
// at import time when @tauri-apps/api can't find the backend.
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _listen: ((evt: string, cb: (e: Event<unknown>) => void) => Promise<() => void>) | null = null;

/** True when running inside the Tauri WebView. Stable across renders + safe in SSR. */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function ensureLoaded(): Promise<void> {
  if (_invoke && _listen) return;
  if (!isDesktop()) throw new Error("tauri bindings called outside the desktop shell");
  const core = (await import("@tauri-apps/api/core")) as { invoke: typeof _invoke };
  const event = (await import("@tauri-apps/api/event")) as { listen: typeof _listen };
  _invoke = core.invoke;
  _listen = event.listen;
}

async function call<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await ensureLoaded();
  return (await _invoke!(cmd, args)) as T;
}

// --- Envelope shape mirrors `arc-vault-crypto::Envelope` on the Rust side. -------------
export interface DesktopEnvelope {
  v: number;
  suite: string;
  n: string;
  ct: string;
  tag: string;
  aad: string;
}

export interface CachedItemDto {
  item_id: string;
  ciphertext: DesktopEnvelope;
  wrapped_item_key: DesktopEnvelope;
  version: number;
  key_version: number;
  seq: number;
}

// --- Session lifecycle -----------------------------------------------------------------

export const setAutolock = (secs: number): Promise<void> => call("vault_set_autolock", { secs });
export const lock = (): Promise<void> => call("vault_lock");
export const isLocked = (): Promise<boolean> => call<boolean>("vault_is_locked");
export const touch = (): Promise<void> => call("vault_touch");

// --- Device + grants -------------------------------------------------------------------

/** Returns the device public key (hex). The private key stays in the OS keychain. */
export const generateDeviceKeypair = (): Promise<string> => call<string>("vault_device_keypair");

export const loadGrant = (input: {
  vaultId: string;
  keyVersion: number;
  grant: DesktopEnvelope;
}): Promise<void> =>
  call("vault_load_grant", {
    vaultId: input.vaultId,
    keyVersion: input.keyVersion,
    grant: input.grant,
  });

export const wrapVekForDevice = (input: {
  vaultId: string;
  devicePubHex: string;
}): Promise<DesktopEnvelope> =>
  call<DesktopEnvelope>("vault_wrap_vek_for_device", {
    vaultId: input.vaultId,
    devicePubHex: input.devicePubHex,
  });

// --- Item encrypt/decrypt (narrowly scoped — VEK stays Rust-side) ----------------------

export interface EncryptedItemFromRust {
  ciphertext: DesktopEnvelope;
  wrapped_item_key: DesktopEnvelope;
}

export const encryptItem = (input: {
  vaultId: string;
  itemId: string;
  version: number;
  plaintext: string;
}): Promise<EncryptedItemFromRust> =>
  call<EncryptedItemFromRust>("vault_encrypt_item", {
    vaultId: input.vaultId,
    itemId: input.itemId,
    version: input.version,
    plaintext: input.plaintext,
  });

export const decryptItem = (input: {
  vaultId: string;
  itemId: string;
  version: number;
  keyVersion: number;
  ciphertext: DesktopEnvelope;
  wrappedItemKey: DesktopEnvelope;
}): Promise<string> =>
  call<string>("vault_decrypt_item", {
    vaultId: input.vaultId,
    itemId: input.itemId,
    version: input.version,
    keyVersion: input.keyVersion,
    ciphertext: input.ciphertext,
    wrappedItemKey: input.wrappedItemKey,
  });

// --- Local ciphertext cache (docs/12 §12.2) --------------------------------------------

export const cacheOpen = (path: string): Promise<void> => call("cache_open", { path });

export const cacheUpsert = (vaultId: string, item: CachedItemDto): Promise<void> =>
  call("cache_upsert", { vaultId, item });

export const cacheGet = (vaultId: string, itemId: string): Promise<CachedItemDto | null> =>
  call<CachedItemDto | null>("cache_get", { vaultId, itemId });

export const cacheList = (vaultId: string): Promise<CachedItemDto[]> =>
  call<CachedItemDto[]>("cache_list", { vaultId });

// --- Lock-tick subscription ------------------------------------------------------------

/**
 * Subscribe to the shell-emitted lock event. The returned function unsubscribes — call
 * it from a React `useEffect` cleanup.
 *
 * The shell emits this when the session transitions from unlocked → locked (idle TTL
 * expired). The web app listens to drop in-memory keys + redirect to the unlock screen
 * without polling Rust on every input.
 */
export async function onLocked(cb: () => void): Promise<() => void> {
  await ensureLoaded();
  return _listen!("arc://vault-locked", () => cb());
}
