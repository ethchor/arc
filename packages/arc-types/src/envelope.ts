/**
 * Wire-format types for the versioned envelope (docs/04). These are the JSON shapes the
 * server stores and clients pass around; the runtime helpers that produce + consume them
 * live in `@arc/crypto`, but every consumer (server entities, SDK, plugins) only needs the
 * shape, not the helpers.
 */

/**
 * One AEAD ciphertext, one anonymous sealed box, or one post-quantum hybrid sealed box.
 * The `alg` field discriminates which fields are populated (`ep` for classical seal,
 * `ep` + `kc` for pq-seal, neither for plain AEAD).
 */
export interface Envelope {
  /** envelope schema version */
  v: number;
  /** algorithm id (e.g. `XC20P`, `seal-x25519-hkdf-xc20p`, `pq-seal-x25519-mlkem768-hkdf-xc20p`) */
  alg: string;
  /** KDF id when password-derived, else null */
  kdf?: string | null;
  /** key version of the wrapping key that produced `ct`, else null */
  kv?: number | null;
  /** canonical AAD string actually bound at encrypt time, else null */
  aad?: string | null;
  /** base64url nonce (24 bytes for XChaCha20-Poly1305) */
  n: string;
  /** base64url ciphertext including the 16-byte tag */
  ct: string;
  /** base64url ephemeral X25519 public key (sealed-box envelopes only) */
  ep?: string | null;
  /** base64url ML-KEM-768 ciphertext (pq-seal envelopes only, ADR-002) */
  kc?: string | null;
  /** plaintext padding length stripped after decrypt (docs/02 §2.5) */
  pad?: number;
}

/** Detached Ed25519 signature envelope (docs/03 §3.5 (c)). */
export interface SignatureEnvelope {
  v: number;
  alg: "Ed25519";
  /** signing-key id for rotation tracking (docs/05) */
  kid?: string | null;
  /** base64url 64-byte signature */
  sig: string;
}
