import { ALG, ENVELOPE_VERSION, type Envelope } from "./envelope";
import { concat, fromB64u, toB64u, utf8 } from "./bytes";
import {
  aeadDecrypt,
  aeadEncrypt,
  hkdfSha256,
  NONCE_BYTES,
  randomBytes,
  x25519KeyPair,
  x25519PubFromPriv,
  x25519Shared,
} from "./primitives";
import { VaultCryptoError } from "./types";

/**
 * Anonymous sealed box (docs/03 §3.5 (a)): confidentiality to the recipient, sender
 * anonymous. Authorship, when needed, is carried by a separate Ed25519 signature
 * (docs/03 §3.5 (c)) — confidentiality is a box, authenticity is a signature.
 *
 * Construction: ephemeral X25519 -> ECDH -> HKDF-SHA256(salt = ephPub||recipientPub) ->
 * XChaCha20-Poly1305. Binding recipientPub into the KDF salt ties the ciphertext to the
 * intended recipient.
 */
function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdfSha256(shared, concat(ephPub, recipientPub), "arc/seal/v1", 32);
}

export function seal(recipientPub: Uint8Array, plaintext: Uint8Array, aad = ""): Envelope {
  const eph = x25519KeyPair();
  const shared = x25519Shared(eph.priv, recipientPub);
  const key = sealKey(shared, eph.pub, recipientPub);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = aeadEncrypt(key, nonce, plaintext, utf8(aad));
  return {
    v: ENVELOPE_VERSION,
    alg: ALG.SEAL,
    kv: null,
    aad: aad === "" ? null : aad,
    n: toB64u(nonce),
    ct: toB64u(ct),
    ep: toB64u(eph.pub),
  };
}

export function sealOpen(recipientPriv: Uint8Array, env: Envelope): Uint8Array {
  if (env.alg !== ALG.SEAL || !env.ep) throw new VaultCryptoError("not a seal envelope");
  const ephPub = fromB64u(env.ep);
  const recipientPub = x25519PubFromPriv(recipientPriv);
  const shared = x25519Shared(recipientPriv, ephPub);
  const key = sealKey(shared, ephPub, recipientPub);
  try {
    return aeadDecrypt(key, fromB64u(env.n), fromB64u(env.ct), utf8(env.aad ?? ""));
  } catch {
    throw new VaultCryptoError("seal open failed (wrong recipient key or tampered)");
  }
}
