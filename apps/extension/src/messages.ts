export interface UnlockRequest {
  type: "arc:unlock";
  baseUrl: string;
  email: string;
  masterPassword: string;
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
}

export type BackgroundMessage = UnlockRequest | FillRequest | ListRequest | GetRequest;
export type ContentMessage = DoFill | FillValues;
