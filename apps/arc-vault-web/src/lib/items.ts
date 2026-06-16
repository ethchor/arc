import type { PulledItem } from "@arc/sdk";
import type { TotpAlgorithm } from "@arc/types";

/**
 * Decrypted item shapes. The server stores ciphertext; once unwrapped on this device,
 * `PulledItem.data` carries one of these. Kept here (shared) so multiple views can
 * project items the same way without re-deriving the discriminated union per file.
 */
export interface LoginData {
  type: "login";
  title: string;
  fields: { url: string; username: string; password: string };
}

export interface TotpData {
  type: "totp";
  key: string;
  secret: string;
  issuer?: string;
  account?: string;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

export interface NoteData {
  type: "note";
  title: string;
  body: string;
}

export interface SecretData {
  type: "secret";
  key: string;
  value: string;
}

// PulledItem.data is JsonValue | null. The strict union doesn't structurally overlap with
// our concrete item shapes, so we cast through `unknown` after discriminating on `type`.
export const asLogin = (i: PulledItem): LoginData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "login" ? (i.data as unknown as LoginData) : null;
};
export const asTotp = (i: PulledItem): TotpData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "totp" ? (i.data as unknown as TotpData) : null;
};
export const asNote = (i: PulledItem): NoteData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "note" ? (i.data as unknown as NoteData) : null;
};
export const asSecret = (i: PulledItem): SecretData | null => {
  const d = i.data as unknown as { type?: string } | null;
  return d?.type === "secret" ? (i.data as unknown as SecretData) : null;
};

export const itemTitle = (i: PulledItem): string =>
  asLogin(i)?.title ?? asTotp(i)?.key ?? asNote(i)?.title ?? asSecret(i)?.key ?? i.id;

export const itemSubtitle = (i: PulledItem): string => {
  const l = asLogin(i);
  if (l) return l.fields.username;
  const t = asTotp(i);
  if (t) return t.issuer ? `${t.issuer}${t.account ? ` · ${t.account}` : ""}` : (t.account ?? "TOTP");
  const n = asNote(i);
  if (n) return n.body.split("\n")[0]?.slice(0, 60) ?? "Note";
  if (asSecret(i)) return "Secret";
  return "";
};
