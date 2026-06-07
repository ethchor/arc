/**
 * Vault item payload shapes. Server-side these are opaque ciphertext envelopes — the
 * structure only matters once a client has decrypted an item. Defining the union here
 * lets the SDK, web UI, CLI, and extension all type-check against the same shapes.
 *
 * Items are JSON-serialisable so they fit `JsonValue` (the AAD-canonicalisable type).
 * Anything that doesn't have its own member here can ride as a generic `record` item.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

/**
 * Secret key/value pair. The simplest item type, used by the CLI and any
 * `arc-vault set <key> <value>` flow. `key` is human-meaningful (e.g.
 * `DATABASE_URL`); `value` is the secret.
 */
export interface SecretItem {
  type: "secret";
  key: string;
  value: string;
}

/**
 * Login credential — Bitwarden-style. `password` is the secret half; everything else is
 * convenience metadata for autofill.
 */
export interface LoginItem {
  type: "login";
  title: string;
  username?: string;
  password: string;
  url?: string;
  notes?: string;
}

/**
 * Encrypted note. Free-form text body; no structured secret payload.
 *
 * `format` is a v1 product call: notes default to plaintext (matches Bitwarden's secure
 * note shape and what every existing client already produces). `markdown` opts into
 * client-side rendering — the server still treats the body as opaque ciphertext and
 * never parses it.
 */
export type NoteFormat = "plaintext" | "markdown";

export interface NoteItem {
  type: "note";
  title: string;
  body: string;
  /**
   * Optional render hint. Missing / `undefined` is equivalent to `"plaintext"` so notes
   * written by older clients keep displaying unchanged.
   */
  format?: NoteFormat;
}

/**
 * TOTP shared-secret item (RFC 6238). Code generation is client-side via
 * `@arc/crypto`'s `totpCode`; the server only stores this opaque envelope. Defaults
 * (when `period` / `digits` / `algorithm` are omitted) match Bitwarden / Google
 * Authenticator: 30s, 6 digits, HMAC-SHA1.
 */
export interface TotpItem {
  type: "totp";
  /** Human-meaningful name, e.g. `github-mfa`. */
  key: string;
  /** Base32-encoded shared secret (any common formatting accepted). */
  secret: string;
  /** Free-form `Issuer:Account` metadata for display. */
  issuer?: string;
  account?: string;
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

/** The discriminated union of all built-in item types. */
export type Item = SecretItem | LoginItem | NoteItem | TotpItem;
