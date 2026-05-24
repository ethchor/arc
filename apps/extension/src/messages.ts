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

export interface FillRequest {
  type: "arc:requestFill";
  pageUrl: string;
}
export type FillResponse =
  | { ok: true; username: string; password: string }
  | { ok: false; reason: string };

export interface DoFill {
  type: "arc:doFill";
}

export type BackgroundMessage = UnlockRequest | FillRequest;
