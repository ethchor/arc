import { describe, expect, it } from "vitest";
import {
  generateHybridIdentityKeyPair,
  pqSeal,
  pqSealOpen,
  PQ_HYBRID_LENGTHS,
} from "../src/pq-hybrid";
import { ALG } from "../src/envelope";
import { fromB64u, toB64u, utf8 } from "../src/bytes";
import { VaultCryptoError } from "../src/types";

describe("pq-hybrid sealed box (X25519 + ML-KEM-768)", () => {
  it("round-trips a payload through the hybrid primitive", () => {
    const recipient = generateHybridIdentityKeyPair();
    const vk = utf8("vault-key-secret-32-byte-payload");
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      vk,
      "vault/123#kv1",
    );
    expect(env.alg).toBe(ALG.PQ_SEAL);
    expect(env.ep).toBeTruthy();
    expect(env.kc).toBeTruthy();
    expect(fromB64u(env.kc!).length).toBe(PQ_HYBRID_LENGTHS.MLKEM_CT);

    const pt = pqSealOpen(env, {
      x25519Priv: recipient.x25519.priv,
      mlkemPriv: recipient.mlkem.secretKey,
    }, "vault/123#kv1");
    expect(pt).toEqual(vk);
  });

  it("produces different ciphertexts on every seal (ephemeral keys + random nonce)", () => {
    const recipient = generateHybridIdentityKeyPair();
    const pub = { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey };
    const env1 = pqSeal(pub, utf8("payload"));
    const env2 = pqSeal(pub, utf8("payload"));
    expect(env1.ct).not.toBe(env2.ct);
    expect(env1.ep).not.toBe(env2.ep);
    expect(env1.kc).not.toBe(env2.kc);
    expect(env1.n).not.toBe(env2.n);
  });

  it("rejects a tampered KEM ciphertext (wrong shared secret -> AEAD tag fails)", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
    );
    const corruptKc = fromB64u(env.kc!);
    corruptKc[0] = (corruptKc[0] ?? 0) ^ 0xff;
    const tampered = { ...env, kc: toB64u(corruptKc) };
    expect(() =>
      pqSealOpen(tampered, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects a tampered ephemeral X25519 public key", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
    );
    const corruptEp = fromB64u(env.ep!);
    corruptEp[0] = (corruptEp[0] ?? 0) ^ 0xff;
    const tampered = { ...env, ep: toB64u(corruptEp) };
    expect(() =>
      pqSealOpen(tampered, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects a tampered ciphertext (AEAD tag fails)", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
    );
    const corruptCt = fromB64u(env.ct);
    corruptCt[0] = (corruptCt[0] ?? 0) ^ 0xff;
    const tampered = { ...env, ct: toB64u(corruptCt) };
    expect(() =>
      pqSealOpen(tampered, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects the wrong recipient keypair (different X25519 priv, same ML-KEM priv)", () => {
    const intended = generateHybridIdentityKeyPair();
    const attacker = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: intended.x25519.pub, mlkemPub: intended.mlkem.publicKey },
      utf8("payload"),
    );
    expect(() =>
      pqSealOpen(env, {
        x25519Priv: attacker.x25519.priv,
        mlkemPriv: intended.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects the wrong recipient keypair (same X25519 priv, different ML-KEM priv)", () => {
    const intended = generateHybridIdentityKeyPair();
    const attacker = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: intended.x25519.pub, mlkemPub: intended.mlkem.publicKey },
      utf8("payload"),
    );
    expect(() =>
      pqSealOpen(env, {
        x25519Priv: intended.x25519.priv,
        mlkemPriv: attacker.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("binds AAD: open with mismatched AAD fails", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
      "vault/A#kv1",
    );
    const tampered = { ...env, aad: "vault/B#kv1" };
    expect(() =>
      pqSealOpen(tampered, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects an envelope missing the KEM ciphertext (downgrade attempt)", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
    );
    const stripped = { ...env, kc: undefined };
    expect(() =>
      pqSealOpen(stripped, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("rejects a classical seal envelope (wrong alg)", () => {
    const recipient = generateHybridIdentityKeyPair();
    const env = pqSeal(
      { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
      utf8("payload"),
    );
    const wrongAlg = { ...env, alg: ALG.SEAL };
    expect(() =>
      pqSealOpen(wrongAlg, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }),
    ).toThrow(VaultCryptoError);
  });

  it("produced key + ct lengths match FIPS 203 / RFC 7748", () => {
    const kp = generateHybridIdentityKeyPair();
    expect(kp.x25519.pub.length).toBe(PQ_HYBRID_LENGTHS.X25519_PUB);
    expect(kp.x25519.priv.length).toBe(PQ_HYBRID_LENGTHS.X25519_PRIV);
    expect(kp.mlkem.publicKey.length).toBe(PQ_HYBRID_LENGTHS.MLKEM_PUB);
    expect(kp.mlkem.secretKey.length).toBe(PQ_HYBRID_LENGTHS.MLKEM_PRIV);
  });

  /**
   * HIGH-E regression (crypto audit). The wrapper used to trust whatever AAD the envelope
   * carried, so a server who swapped a valid `pqSeal` envelope into a different slot for
   * the *same* recipient (one bound to coordinates A, the slot expecting coordinates B)
   * would unwrap cleanly — confidentiality was upheld at the AEAD layer, but the
   * coordinate-binding the threat model promises was silently absent. The wrapper now
   * accepts an `expectedAad` and refuses any envelope whose carried AAD disagrees.
   */
  describe("expectedAad enforcement at the wrapper", () => {
    it("refuses an envelope whose carried AAD differs from the caller's expectedAad", () => {
      const recipient = generateHybridIdentityKeyPair();
      const env = pqSeal(
        { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
        utf8("vault-key-for-slot-A"),
        "share/A#kv1",
      );
      // Caller asks for slot B. Even though the envelope opens (recipient priv is right),
      // the wrapper must refuse — the envelope is for the wrong coordinates.
      expect(() =>
        pqSealOpen(env, {
          x25519Priv: recipient.x25519.priv,
          mlkemPriv: recipient.mlkem.secretKey,
        }, "share/B#kv1"),
      ).toThrow(VaultCryptoError);
    });

    it("accepts an envelope whose carried AAD matches the caller's expectedAad", () => {
      const recipient = generateHybridIdentityKeyPair();
      const env = pqSeal(
        { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
        utf8("VK"),
        "share/A#kv1",
      );
      const pt = pqSealOpen(env, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      }, "share/A#kv1");
      expect(new TextDecoder().decode(pt)).toBe("VK");
    });

    it("defaults expectedAad to '' so legacy null-AAD envelopes open unchanged (back-compat)", () => {
      const recipient = generateHybridIdentityKeyPair();
      // pqSeal with empty AAD stores `aad: null` in the envelope — the legacy shape.
      const env = pqSeal(
        { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
        utf8("legacy-payload"),
      );
      expect(env.aad).toBeNull();
      const pt = pqSealOpen(env, {
        x25519Priv: recipient.x25519.priv,
        mlkemPriv: recipient.mlkem.secretKey,
      });
      expect(new TextDecoder().decode(pt)).toBe("legacy-payload");
    });

    it("refuses a coordinate-bound envelope when the caller passes the default (empty) expectedAad", () => {
      // A caller that hasn't been upgraded to pass the expected coordinate still gets
      // protection against substitution: an envelope whose seal-time AAD is a coordinate
      // string can NOT be substituted into a legacy callsite expecting empty AAD.
      const recipient = generateHybridIdentityKeyPair();
      const env = pqSeal(
        { x25519Pub: recipient.x25519.pub, mlkemPub: recipient.mlkem.publicKey },
        utf8("substitute"),
        "share/A#kv1",
      );
      expect(() =>
        pqSealOpen(env, {
          x25519Priv: recipient.x25519.priv,
          mlkemPriv: recipient.mlkem.secretKey,
        }),
      ).toThrow(VaultCryptoError);
    });
  });
});
