import { ed25519KeyPair, randomBytes, sha256, x25519KeyPair } from "./primitives";
import { generateHybridIdentityKeyPair, type HybridKeyPair } from "./pq-hybrid";
import { VaultCryptoError } from "./types";

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

/** Per-user X25519 identity keypair — receives wrapped Vault Keys (docs/05 §5.1). */
export const generateIdentityKeyPair = (): KeyPair => x25519KeyPair();

/** Per-user Ed25519 signing keypair — signs mutations and grants (docs/05 §5.1). */
export const generateSigningKeyPair = (): KeyPair => ed25519KeyPair();

/**
 * Per-device X25519-only keypair (legacy device flow). Preserved so older clients keep
 * working — new code should call {@link generateHybridDeviceKeyPair} instead so device
 * grants ride the X25519 + ML-KEM-768 envelope (ADR-002 → ADR-003) and close the
 * harvest-now-decrypt-later window for the device-grant material.
 */
export const generateDeviceKeyPair = (): KeyPair => x25519KeyPair();

/**
 * Per-device **hybrid** keypair: classical X25519 (back-compat) + ML-KEM-768 (PQ). Closes
 * the ADR-002 footnote on device-grant HNDL exposure. Same shape as the identity hybrid
 * keypair, just used by a different surface (device enrollment vs user enrollment).
 */
export const generateHybridDeviceKeyPair = (): HybridKeyPair => generateHybridIdentityKeyPair();

// --- Base32 (RFC 4648, no padding) for recovery keys & fingerprints ---
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new VaultCryptoError(`base32: invalid character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 256-bit recovery key, shown once, grouped Base32 (docs/05 §5.7). */
export function generateRecoveryKey(): { raw: Uint8Array; encoded: string } {
  const raw = randomBytes(32);
  const groups = base32Encode(raw).match(/.{1,4}/g) ?? [];
  return { raw, encoded: groups.join("-") };
}

export function decodeRecoveryKey(encoded: string): Uint8Array {
  return base32Decode(encoded.replace(/-/g, "").toUpperCase());
}

/** Stable short fingerprint of a public key for out-of-band verification (docs/06 §6.5). */
export function fingerprint(pub: Uint8Array, groups = 8): string {
  const b32 = base32Encode(sha256(pub)).slice(0, groups * 4);
  return (b32.match(/.{1,4}/g) ?? []).join("-");
}
