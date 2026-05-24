import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { utf8 } from "./bytes";

export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;

export const randomBytes = (n: number): Uint8Array => nobleRandomBytes(n);
export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);

export interface ArgonParams {
  /** memory cost in KiB */
  m: number;
  /** iterations */
  t: number;
  /** parallelism */
  p: number;
  dkLen: number;
}

export function argon2id(password: Uint8Array, salt: Uint8Array, p: ArgonParams): Uint8Array {
  return nobleArgon2id(password, salt, { t: p.t, m: p.m, p: p.p, dkLen: p.dkLen });
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Uint8Array {
  return nobleHkdf(nobleSha256, ikm, salt, utf8(info), length);
}

export function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

// --- Ed25519 (signing) ---
export const edSign = (priv: Uint8Array, message: Uint8Array): Uint8Array =>
  ed25519.sign(message, priv);
export const edVerify = (pub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean =>
  ed25519.verify(sig, message, pub);
export const edPubFromPriv = (priv: Uint8Array): Uint8Array => ed25519.getPublicKey(priv);
export function ed25519KeyPair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = ed25519.utils.randomPrivateKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}

// --- X25519 (key agreement / sealing) ---
export const x25519Shared = (priv: Uint8Array, pub: Uint8Array): Uint8Array =>
  x25519.getSharedSecret(priv, pub);
export const x25519PubFromPriv = (priv: Uint8Array): Uint8Array => x25519.getPublicKey(priv);
export function x25519KeyPair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomPrivateKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}
