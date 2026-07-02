export interface UnlockRequest {
  type: "arc:unlock";
  baseUrl: string;
  email: string;
  masterPassword: string;
}
/**
 * Username-less passkey unlock (ADR-008). The user doesn't type an email — the popup
 * triggers a WebAuthn prompt that picks the resident credential, and the background
 * worker resolves the account on the server, signs in, and unwraps via PRF in one step.
 * On modern browsers this is one biometric gesture; in the worst case it's two with
 * **zero typing**, vs. email + master-password today.
 */
export interface PasskeyUnlockRequest {
  type: "arc:passkeyUnlock";
  baseUrl: string;
}
export interface UnlockResponse {
  ok: boolean;
  error?: string;
}

/** Item metadata for the popup list — no password. */
export interface LoginMeta {
  id: string;
  title: string;
  url: string;
  username: string;
}

export interface Creds {
  username: string;
  password: string;
}

export interface ListRequest {
  type: "arc:list";
}
export interface GetRequest {
  type: "arc:get";
  id: string;
}

/** Origin-bound auto-fill for the current page (docs/12 §12.4). */
export interface FillRequest {
  type: "arc:requestFill";
  pageUrl: string;
}
export type FillResponse =
  | { ok: true; username: string; password: string }
  | { ok: false; reason: string };

/** Content-script messages (from the popup, via chrome.tabs.sendMessage). */
export interface DoFill {
  type: "arc:doFill";
}
export interface FillValues {
  type: "arc:fillValues";
  username: string;
  password: string;
  /**
   * The credential's saved URL. The content script origin-binds the *explicit* fill against
   * it (docs/12 §12.4) — even a popup-chosen credential must not be typed into a page whose
   * origin doesn't match the saved site (else a phishing page gets it on one click).
   */
  savedUrl: string;
}
/** Content-script reply to `arc:fillValues` so the popup can report success vs an origin block. */
export interface FillValuesResult {
  filled: boolean;
  reason?: "origin_mismatch";
}

/** Worker status — used by the popup to skip re-entering credentials when the worker is alive + unlocked. */
export interface StatusRequest {
  type: "arc:status";
}
export interface StatusResponse {
  unlocked: boolean;
  /** Seconds until auto-lock, or null when locked / no clock. */
  lockInSeconds: number | null;
}

/** Configure the auto-lock TTL (seconds). Persisted in `chrome.storage.session`. */
export interface SetAutolockRequest {
  type: "arc:setAutolock";
  ttlSeconds: number;
}

export type BackgroundMessage =
  | UnlockRequest
  | PasskeyUnlockRequest
  | FillRequest
  | ListRequest
  | GetRequest
  | StatusRequest
  | SetAutolockRequest;
export type ContentMessage = DoFill | FillValues;
