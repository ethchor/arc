// JsonValue is the canonical JSON shape used everywhere arc canonicalises a payload (AAD,
// signed objects, item bodies). Its source of truth is @arc/types so plugins and the SDK
// can take it without depending on the crypto package.
export type { JsonValue } from "@arc/types";

/** Raised for any cryptographic / envelope failure. Never leaks key material in its message. */
export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCryptoError";
  }
}
