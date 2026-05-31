import { describe, expect, it } from "vitest";
import {
  aeadOpen,
  aeadSeal,
  base32Decode,
  base32Encode,
  buildAad,
  chainNext,
  ctEqual,
  decodeRecoveryKey,
  fromUtf8,
  generateIdentityKeyPair,
  generateRecoveryKey,
  generateSigningKeyPair,
  randomBytes,
  seal,
  sealOpen,
  signHead,
  signObject,
  toB64u,
  utf8,
  verifyHead,
  verifyObject,
  ZERO_CHAIN,
} from "../src";

describe("aad", () => {
  it("length-prefixes each field", () => {
    expect(buildAad([["a", "xy"]])).toBe("arc-aad/1\na:2:xy");
    expect(buildAad([["x", "1"], ["y", "22"]])).toBe("arc-aad/1\nx:1:1\ny:2:22");
  });
});

describe("aead envelope", () => {
  const key = randomBytes(32);
  const aad = buildAad([["x", "1"]]);

  it("round-trips with padding", () => {
    const env = aeadSeal(key, utf8("a secret value"), aad, { pad: true });
    expect(env.pad).toBeGreaterThan(0);
    expect(fromUtf8(aeadOpen(key, env, aad))).toBe("a secret value");
  });

  it("fails on tampered nonce", () => {
    const env = aeadSeal(key, utf8("secret"), aad);
    expect(() => aeadOpen(key, { ...env, n: toB64u(randomBytes(24)) }, aad)).toThrow();
  });

  it("fails on AAD mismatch", () => {
    const env = aeadSeal(key, utf8("secret"), aad);
    expect(() => aeadOpen(key, env, buildAad([["x", "2"]]))).toThrow();
  });

  it("fails on wrong key", () => {
    const env = aeadSeal(key, utf8("secret"), aad);
    expect(() => aeadOpen(randomBytes(32), env, aad)).toThrow();
  });
});

describe("seal (anonymous box)", () => {
  it("round-trips to the recipient", () => {
    const r = generateIdentityKeyPair();
    const env = seal(r.pub, utf8("vault-key"));
    expect(fromUtf8(sealOpen(r.priv, env))).toBe("vault-key");
  });

  it("a different recipient cannot open", () => {
    const r = generateIdentityKeyPair();
    const other = generateIdentityKeyPair();
    const env = seal(r.pub, utf8("vault-key"));
    expect(() => sealOpen(other.priv, env)).toThrow();
  });
});

describe("signatures", () => {
  it("verifies a valid signature", () => {
    const k = generateSigningKeyPair();
    const obj = { a: 1, b: "x" };
    expect(verifyObject(k.pub, obj, signObject(k.priv, obj))).toBe(true);
  });

  it("rejects a wrong key", () => {
    const k = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    expect(verifyObject(other.pub, { a: 1 }, signObject(k.priv, { a: 1 }))).toBe(false);
  });

  it("rejects a modified object", () => {
    const k = generateSigningKeyPair();
    expect(verifyObject(k.pub, { a: 2 }, signObject(k.priv, { a: 1 }))).toBe(false);
  });
});

describe("signed vault-head + chain", () => {
  it("chains deterministically", () => {
    const d = "ab".repeat(32);
    expect(chainNext(ZERO_CHAIN, d)).toBe(chainNext(ZERO_CHAIN, d));
    expect(chainNext(ZERO_CHAIN, d)).not.toBe(ZERO_CHAIN);
  });

  it("detects a regressed seq via the signed head", () => {
    const k = generateSigningKeyPair();
    const head = { vaultId: "v", seq: 5, chainHash: ZERO_CHAIN, ts: "t" };
    const sig = signHead(k.priv, head);
    expect(verifyHead(k.pub, head, sig)).toBe(true);
    expect(verifyHead(k.pub, { ...head, seq: 4 }, sig)).toBe(false);
  });
});

describe("base32 + recovery key", () => {
  it("round-trips arbitrary bytes", () => {
    const b = randomBytes(32);
    expect([...base32Decode(base32Encode(b))]).toEqual([...b]);
  });

  it("recovery key decodes back to its 32 raw bytes", () => {
    const r = generateRecoveryKey();
    expect([...decodeRecoveryKey(r.encoded)]).toEqual([...r.raw]);
  });
});

describe("ctEqual", () => {
  it("is true for equal buffers", () => expect(ctEqual(utf8("abc"), utf8("abc"))).toBe(true));
  it("is false for different content", () => expect(ctEqual(utf8("abc"), utf8("abd"))).toBe(false));
  it("is false for different length", () => expect(ctEqual(utf8("ab"), utf8("abc"))).toBe(false));
});
