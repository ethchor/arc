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
    });
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
});
