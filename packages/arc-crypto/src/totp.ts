/**
 * Time-based one-time passwords (RFC 6238) on top of HMAC-based one-time passwords
 * (RFC 4226). All TOTP generation happens client-side: the vault server only ever sees
 * the encrypted item envelope, never the secret or the code.
 *
 * Defaults match the Bitwarden / 1Password convention so secrets pasted from existing
 * vaults work without configuration: 30-second period, 6 digits, HMAC-SHA1. The other
 * algorithms (SHA-256, SHA-512) and digit lengths (7, 8) are supported but rare.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/sha1";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { base32Decode } from "./keys";
import { VaultCryptoError } from "./types";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpOptions {
  /** Step size in seconds. RFC 6238 default = 30. */
  period?: number;
  /** Number of output digits. RFC 6238 allows 6–8; Bitwarden default = 6. */
  digits?: number;
  /** HMAC inner hash. RFC 6238 default = SHA-1. */
  algorithm?: TotpAlgorithm;
  /** Override the current time (seconds since epoch). Tests + replay analysis. */
  time?: number;
}

export interface TotpCode {
  /** Zero-padded decimal string of length `digits`. */
  code: string;
  /** Seconds left before this code rolls. Useful for UI countdowns. */
  secondsRemaining: number;
}

const HASHERS: Record<TotpAlgorithm, typeof sha1> = {
  SHA1: sha1,
  SHA256: sha256,
  SHA512: sha512,
};

/**
 * Normalize a user-pasted base32 secret: strip whitespace + padding, uppercase. Bitwarden,
 * 1Password, and Google Authenticator URIs all hand out variants of these. After normalize,
 * the result is the strict RFC 4648 alphabet that {@link base32Decode} consumes.
 */
function decodeSecret(secretBase32: string): Uint8Array {
  const normalized = secretBase32.replace(/[\s=]+/g, "").toUpperCase();
  if (normalized.length === 0) throw new VaultCryptoError("totp: empty secret");
  return base32Decode(normalized);
}

function counterBytes(counter: number): Uint8Array {
  // 64-bit big-endian counter (RFC 4226 §5.3). counter fits comfortably in a JS Number
  // for any TOTP timestamp until year 5391 at period=30.
  const buf = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

function truncate(hmacResult: Uint8Array, digits: number): string {
  // RFC 4226 §5.3 dynamic truncation.
  const offset = (hmacResult[hmacResult.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmacResult[offset] ?? 0) & 0x7f) << 24) |
    (((hmacResult[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmacResult[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmacResult[offset + 3] ?? 0) & 0xff);
  const mod = 10 ** digits;
  return (code % mod).toString().padStart(digits, "0");
}

/** Low-level HOTP (RFC 4226). Use {@link totpCode} for the time-based wrapper. */
export function hotpCode(
  secretBase32: string,
  counter: number,
  opts: { digits?: number; algorithm?: TotpAlgorithm } = {},
): string {
  const digits = opts.digits ?? 6;
  if (digits < 6 || digits > 8) throw new VaultCryptoError("totp: digits must be 6, 7, or 8");
  const hasher = HASHERS[opts.algorithm ?? "SHA1"];
  const secret = decodeSecret(secretBase32);
  const tag = hmac(hasher, secret, counterBytes(counter));
  return truncate(tag, digits);
}

/** TOTP (RFC 6238). Default options match Bitwarden / Google Authenticator. */
export function totpCode(secretBase32: string, opts: TotpOptions = {}): TotpCode {
  const period = opts.period ?? 30;
  if (period <= 0) throw new VaultCryptoError("totp: period must be > 0");
  const nowSec = opts.time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(nowSec / period);
  const code = hotpCode(secretBase32, counter, {
    digits: opts.digits,
    algorithm: opts.algorithm,
  });
  return { code, secondsRemaining: period - (nowSec % period) };
}

/**
 * Parsed `otpauth://` URI fields (Google Authenticator's de-facto interop format).
 * Spec: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export interface OtpauthFields {
  /** Always `"totp"` today — HOTP URIs are accepted but issue a warning since we don't
   *  store a counter alongside HOTP items. */
  type: "totp" | "hotp";
  /** Base32 secret, normalized (uppercase, no padding/whitespace). */
  secret: string;
  /** Service / company. Pulled from the `?issuer=` query param if present, else from
   *  the label prefix (`Issuer:Account`). */
  issuer?: string;
  /** User-facing account identifier (email, username, …). */
  account?: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
}

const ALG_FROM_URI: Record<string, TotpAlgorithm> = {
  SHA1: "SHA1",
  SHA256: "SHA256",
  SHA512: "SHA512",
};

/**
 * Parse `otpauth://totp/<label>?secret=<base32>&issuer=...` URIs (Google Authenticator
 * format). Throws on anything that isn't a recognisable TOTP URI; partial fields use the
 * RFC 6238 defaults at code-generation time, so a minimal URI like
 * `otpauth://totp/?secret=JBSWY3DPEHPK3PXP` round-trips cleanly.
 */
export function parseOtpauthUri(uri: string): OtpauthFields {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new VaultCryptoError("otpauth: not a parsable URI");
  }
  if (url.protocol !== "otpauth:") {
    throw new VaultCryptoError("otpauth: expected an otpauth:// URI");
  }
  // WHATWG URL parsing of `otpauth://totp/<label>` lands the type in `host` and the label
  // in `pathname`. Node's URL exposes the type either there or (rarely) as the first
  // path segment depending on version — handle both for safety.
  let otpType = url.host.toLowerCase();
  let labelRaw = url.pathname.replace(/^\/+/, "");
  if (!otpType) {
    const slashIdx = labelRaw.indexOf("/");
    otpType = (slashIdx >= 0 ? labelRaw.slice(0, slashIdx) : labelRaw).toLowerCase();
    labelRaw = slashIdx >= 0 ? labelRaw.slice(slashIdx + 1) : "";
  }
  if (otpType !== "totp" && otpType !== "hotp") {
    throw new VaultCryptoError(`otpauth: unsupported type ${otpType}`);
  }
  const params = url.searchParams;
  const secretRaw = params.get("secret");
  if (!secretRaw) throw new VaultCryptoError("otpauth: missing required `secret` parameter");
  // Validate by passing through the same normaliser the generator uses.
  decodeSecret(secretRaw);

  const label = decodeURIComponent(labelRaw);
  const colonIdx = label.indexOf(":");
  const labelIssuer = colonIdx > 0 ? label.slice(0, colonIdx).trim() : undefined;
  const labelAccount = colonIdx > 0 ? label.slice(colonIdx + 1).trim() : label.trim() || undefined;

  const algParam = params.get("algorithm")?.toUpperCase();
  const algorithm = algParam && ALG_FROM_URI[algParam] ? ALG_FROM_URI[algParam] : undefined;
  const digitsParam = params.get("digits");
  const digits = digitsParam ? Number(digitsParam) : undefined;
  const periodParam = params.get("period");
  const period = periodParam ? Number(periodParam) : undefined;

  return {
    type: otpType,
    secret: secretRaw.replace(/[\s=]+/g, "").toUpperCase(),
    issuer: params.get("issuer")?.trim() || labelIssuer,
    account: labelAccount,
    ...(algorithm ? { algorithm } : {}),
    ...(digits !== undefined && Number.isFinite(digits) ? { digits } : {}),
    ...(period !== undefined && Number.isFinite(period) ? { period } : {}),
  };
}
