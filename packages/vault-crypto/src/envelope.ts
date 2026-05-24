import { aeadDecrypt, aeadEncrypt, NONCE_BYTES, randomBytes } from "./primitives";
import { fromB64u, toB64u, utf8 } from "./bytes";
import { VaultCryptoError } from "./types";

export const ENVELOPE_VERSION = 1;

/** Algorithm registry (docs/04 §4.7). Ids are opaque strings; readers reject unknown ids. */
export const ALG = {
  AEAD: "XC20P",
  SIG: "Ed25519",
  /**
   * Anonymous sealed box. Greenfield construction (docs/03 §3.1 note): ephemeral X25519
   * ECDH -> HKDF-SHA256 -> XChaCha20-Poly1305, instead of libsodium's XSalsa20 variant, so
   * the seal shares primitives with the rest of the stack and is trivially reproduced in Rust.
   */
  SEAL: "seal-x25519-hkdf-xc20p",
} as const;

export const KDF = { ARGON2ID: "argon2id-1" } as const;

/** Versioned container for one AEAD ciphertext or one sealed box. */
export interface Envelope {
  /** envelope schema version */
  v: number;
  /** algorithm id from ALG */
  alg: string;
  /** KDF id when password-derived, else null */
  kdf?: string | null;
  /** key version of the wrapping key that produced `ct`, else null */
  kv?: number | null;
  /** canonical AAD string actually bound (docs/04 §4.3), else null */
  aad?: string | null;
  /** base64url nonce (24 bytes) */
  n: string;
  /** base64url ciphertext + 16-byte tag */
  ct: string;
  /** base64url ephemeral public key (seal envelopes only) */
  ep?: string | null;
  /** plaintext padding length stripped after decrypt (docs/02 §2.5) */
  pad?: number;
}

export interface SignatureEnvelope {
  v: number;
  alg: "Ed25519";
  /** signing key id, supports rotation (docs/05) */
  kid?: string | null;
  sig: string;
}

// Length-bucket padding to blunt ciphertext-size fingerprinting (docs/02 §2.5).
const BUCKETS = [64, 256, 1024, 4096, 16384, 65536, 262144];

export function padTarget(len: number): number {
  for (const b of BUCKETS) if (len <= b) return b;
  return Math.ceil(len / 262144) * 262144;
}

function applyPad(pt: Uint8Array): { padded: Uint8Array; pad: number } {
  const target = padTarget(pt.length);
  const padded = new Uint8Array(target); // zero-filled tail
  padded.set(pt);
  return { padded, pad: target - pt.length };
}

export interface AeadSealOpts {
  kv?: number | null;
  kdf?: string | null;
  /** apply length-bucket padding (use for item payloads) */
  pad?: boolean;
}

/** AEAD-encrypt `plaintext` under `key`, binding `aad`, producing an Envelope. */
export function aeadSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
  opts: AeadSealOpts = {},
): Envelope {
  const { padded, pad } = opts.pad ? applyPad(plaintext) : { padded: plaintext, pad: 0 };
  const nonce = randomBytes(NONCE_BYTES);
  const ct = aeadEncrypt(key, nonce, padded, utf8(aad));
  return {
    v: ENVELOPE_VERSION,
    alg: ALG.AEAD,
    kdf: opts.kdf ?? null,
    kv: opts.kv ?? null,
    aad,
    n: toB64u(nonce),
    ct: toB64u(ct),
    pad,
  };
}

/**
 * AEAD-decrypt an Envelope. `expectedAad` is recomputed by the caller from the semantic
 * context (never trusted from the envelope) and must match what was bound at seal time,
 * or the AEAD open fails. Fails closed on any version/alg/AAD mismatch or tamper.
 */
export function aeadOpen(key: Uint8Array, env: Envelope, expectedAad: string): Uint8Array {
  if (env.v !== ENVELOPE_VERSION) throw new VaultCryptoError("unsupported envelope version");
  if (env.alg !== ALG.AEAD) throw new VaultCryptoError(`unexpected alg ${env.alg}`);
  if (env.aad != null && env.aad !== expectedAad) throw new VaultCryptoError("AAD mismatch");
  let padded: Uint8Array;
  try {
    padded = aeadDecrypt(key, fromB64u(env.n), fromB64u(env.ct), utf8(expectedAad));
  } catch {
    throw new VaultCryptoError("AEAD open failed (wrong key, tampered, or wrong AAD)");
  }
  const pad = env.pad ?? 0;
  return pad > 0 ? padded.subarray(0, padded.length - pad) : padded;
}
