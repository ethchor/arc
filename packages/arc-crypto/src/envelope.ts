import { aeadDecrypt, aeadEncrypt, NONCE_BYTES, randomBytes } from "./primitives";
import { fromB64u, toB64u, utf8 } from "./bytes";
import { VaultCryptoError } from "./types";

// Envelope + SignatureEnvelope wire shapes live in @arc/types so plugins and the server
// can reference them without depending on the crypto runtime. Imported for local use in
// this file's runtime helpers, and re-exported so existing crypto consumers (sdk, server
// entities, tests) keep their @arc/crypto imports working.
import type { Envelope, SignatureEnvelope } from "@arc/types";
export type { Envelope, SignatureEnvelope };

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
  /**
   * Post-quantum hybrid sealed box (ADR-001 §"Open questions" #1, ADR-002). Ephemeral
   * X25519 ECDH + ML-KEM-768 KEM, both shared secrets fed into HKDF-SHA256 with the full
   * KEM transcript and both recipient public keys bound into the salt. Symmetric layer is
   * the same XChaCha20-Poly1305 as the classical `SEAL`, so the only new primitive
   * compared to the rest of the stack is ML-KEM-768. Defeats harvest-now-decrypt-later
   * against the wrapped VK grants the server stores.
   */
  PQ_SEAL: "pq-seal-x25519-mlkem768-hkdf-xc20p",
} as const;

export const KDF = { ARGON2ID: "argon2id-1" } as const;

// Envelope and SignatureEnvelope are re-exported from @arc/types above. The runtime
// constructors (aeadSeal / aeadOpen, etc.) below remain here in @arc/crypto.

// Length-bucket padding to blunt ciphertext-size fingerprinting (docs/02 §2.5).
//
// LOW-F (audit): explicitly document the >256 KiB tail behavior. Below 256 KiB inputs
// snap up to the nearest fixed bucket in `PAD_BUCKETS` (64 → 256 → 1k → 4k → 16k → 64k →
// 256k). Above 256 KiB the bucket grows linearly in 256 KiB steps (i.e.
// `ceil(len / 262144) * 262144`) so a 1.5 MiB attachment lands on a 1.75 MiB envelope,
// a 4 MiB attachment lands on a 4 MiB envelope, etc. The boundary is intentional: with
// sub-linear buckets above 256 KiB either the catalog explodes or the chosen bucket
// telegraphs the actual length, so we accept the constant-size leak of "rounded up to
// the next 256 KiB" in exchange for a fixed cost model attachments can budget against.
// Down-stream implementations (Rust core, future SDKs) MUST replicate this same step
// function so the on-wire `pad` value remains a deterministic function of input length.
export const PAD_BUCKETS = [64, 256, 1024, 4096, 16384, 65536, 262144] as const;
export const PAD_LARGE_STEP = 262144;

export function padTarget(len: number): number {
  for (const b of PAD_BUCKETS) if (len <= b) return b;
  return Math.ceil(len / PAD_LARGE_STEP) * PAD_LARGE_STEP;
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
