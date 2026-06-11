import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
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
 * Post-quantum hybrid sealed box. ADR-001 §"Open questions" #1, ADR-002.
 *
 * Defeats harvest-now-decrypt-later: an adversary who records the wrapped VK envelopes
 * the server stores today and breaks ECC in 203X must *also* break ML-KEM-768 to recover
 * the symmetric key. Both shared secrets are fed into HKDF together, so breaking either
 * one in isolation reveals nothing.
 *
 * Construction (X-Wing-style binding):
 *
 *   eph_x25519        := X25519 keygen
 *   ss_ec             := X25519(eph_x25519.priv, recipient.x25519Pub)
 *   (kem_ct, ss_pq)   := ML-KEM-768.encapsulate(recipient.mlkemPub)
 *   K                 := HKDF-SHA256(
 *                          ikm  = ss_ec || ss_pq,
 *                          salt = eph_x25519.pub || kem_ct
 *                              || recipient.x25519Pub || recipient.mlkemPub,
 *                          info = "arc/pq-seal/v1",
 *                          L    = 32)
 *   ct                := XChaCha20-Poly1305(K, random nonce, plaintext, aad)
 *
 * Why this binding: putting `eph_x25519.pub` and `kem_ct` (the full KEM transcript) plus
 * both recipient public keys into the HKDF salt makes K commit to every value an attacker
 * could try to swap — substituting a different ephemeral, a different KEM ciphertext, or
 * targeting a different recipient produces a different K and the AEAD tag fails to
 * verify. This is the IND-CCA2-secure hybrid combiner the FIPS 203 ecosystem converged
 * on (cf. X-Wing, draft-connolly-cfrg-xwing-kem).
 */

export interface HybridKeyPair {
  /** Classical: X25519 ECDH keypair. Compatible with the existing `seal` envelope. */
  x25519: { priv: Uint8Array; pub: Uint8Array };
  /** Post-quantum: ML-KEM-768 (FIPS 203) KEM keypair. */
  mlkem: { secretKey: Uint8Array; publicKey: Uint8Array };
}

export interface HybridPub {
  x25519Pub: Uint8Array;
  mlkemPub: Uint8Array;
}

export interface HybridPriv {
  x25519Priv: Uint8Array;
  mlkemPriv: Uint8Array;
}

export const PQ_HYBRID_LENGTHS = {
  X25519_PUB: 32,
  X25519_PRIV: 32,
  MLKEM_PUB: 1184,
  MLKEM_PRIV: 2400,
  MLKEM_CT: 1088,
  SHARED: 32,
} as const;

export function generateHybridIdentityKeyPair(): HybridKeyPair {
  const ec = x25519KeyPair();
  const pq = ml_kem768.keygen();
  return {
    x25519: ec,
    mlkem: { secretKey: pq.secretKey, publicKey: pq.publicKey },
  };
}

/** Derive the ML-KEM-768 public key from its private. Cheap; useful for service-account flows. */
export function mlkemPubFromPriv(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== PQ_HYBRID_LENGTHS.MLKEM_PRIV) {
    throw new VaultCryptoError("ML-KEM-768 private key is the wrong length");
  }
  return ml_kem768.getPublicKey(secretKey);
}

function deriveKey(
  ssEc: Uint8Array,
  ssPq: Uint8Array,
  ephPub: Uint8Array,
  kemCt: Uint8Array,
  recipientX25519Pub: Uint8Array,
  recipientMlkemPub: Uint8Array,
): Uint8Array {
  return hkdfSha256(
    concat(ssEc, ssPq),
    concat(ephPub, kemCt, recipientX25519Pub, recipientMlkemPub),
    "arc/pq-seal/v1",
    32,
  );
}

export function pqSeal(recipient: HybridPub, plaintext: Uint8Array, aad = ""): Envelope {
  if (recipient.x25519Pub.length !== PQ_HYBRID_LENGTHS.X25519_PUB) {
    throw new VaultCryptoError("recipient x25519 public key is the wrong length");
  }
  if (recipient.mlkemPub.length !== PQ_HYBRID_LENGTHS.MLKEM_PUB) {
    throw new VaultCryptoError("recipient ML-KEM-768 public key is the wrong length");
  }
  const eph = x25519KeyPair();
  const ssEc = x25519Shared(eph.priv, recipient.x25519Pub);
  const { cipherText: kemCt, sharedSecret: ssPq } = ml_kem768.encapsulate(recipient.mlkemPub);
  const key = deriveKey(ssEc, ssPq, eph.pub, kemCt, recipient.x25519Pub, recipient.mlkemPub);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = aeadEncrypt(key, nonce, plaintext, utf8(aad));
  return {
    v: ENVELOPE_VERSION,
    alg: ALG.PQ_SEAL,
    kv: null,
    aad: aad === "" ? null : aad,
    n: toB64u(nonce),
    ct: toB64u(ct),
    ep: toB64u(eph.pub),
    kc: toB64u(kemCt),
  };
}

/**
 * Open a `pq-seal` envelope, refusing it unless the envelope's bound AAD matches the
 * caller's `expectedAad`. Same wrapper-layer AAD discipline as {@link sealOpen} —
 * HIGH-E from the crypto audit: a server cannot silently substitute a coordinate-A
 * envelope into a coordinate-B slot for the same hybrid recipient.
 *
 * Backward-compatible: `expectedAad` defaults to `""`, matching legacy envelopes that
 * were sealed without a binding (`pqSeal(...)` with no AAD stores `aad: null`).
 */
export function pqSealOpen(env: Envelope, recipient: HybridPriv, expectedAad = ""): Uint8Array {
  if (env.alg !== ALG.PQ_SEAL) throw new VaultCryptoError("not a pq-seal envelope");
  if (!env.ep || !env.kc) throw new VaultCryptoError("pq-seal envelope missing ep or kc");
  if (env.aad != null && env.aad !== expectedAad) {
    throw new VaultCryptoError("pq-seal AAD mismatch");
  }
  if (recipient.x25519Priv.length !== PQ_HYBRID_LENGTHS.X25519_PRIV) {
    throw new VaultCryptoError("recipient x25519 private key is the wrong length");
  }
  if (recipient.mlkemPriv.length !== PQ_HYBRID_LENGTHS.MLKEM_PRIV) {
    throw new VaultCryptoError("recipient ML-KEM-768 private key is the wrong length");
  }
  const ephPub = fromB64u(env.ep);
  const kemCt = fromB64u(env.kc);
  if (kemCt.length !== PQ_HYBRID_LENGTHS.MLKEM_CT) {
    throw new VaultCryptoError("pq-seal envelope KEM ciphertext is the wrong length");
  }
  const ssEc = x25519Shared(recipient.x25519Priv, ephPub);
  // ML-KEM decapsulate is implicit-rejection: a tampered kem_ct yields a pseudo-random ss_pq
  // rather than an error, so the AEAD tag check below is what catches the failure.
  const ssPq = ml_kem768.decapsulate(kemCt, recipient.mlkemPriv);
  const recipientX25519Pub = x25519PubFromPriv(recipient.x25519Priv);
  const recipientMlkemPub = ml_kem768.getPublicKey(recipient.mlkemPriv);
  const key = deriveKey(ssEc, ssPq, ephPub, kemCt, recipientX25519Pub, recipientMlkemPub);
  try {
    return aeadDecrypt(key, fromB64u(env.n), fromB64u(env.ct), utf8(expectedAad));
  } catch {
    throw new VaultCryptoError("pq-seal open failed (wrong recipient key or tampered)");
  }
}
