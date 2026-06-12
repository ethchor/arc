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
  deviceSas,
  fingerprint,
  generateHybridDeviceKeyPair,
  padTarget,
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

  /**
   * HIGH-E regression (crypto audit). The wrapper used to trust whatever AAD the envelope
   * carried; the wrapper now accepts `expectedAad` and refuses any envelope whose carried
   * AAD disagrees. Backward-compatible default: `""` lets legacy null-AAD envelopes open
   * unchanged. A coordinate-bound envelope cannot be substituted into a legacy callsite.
   */
  describe("sealOpen expectedAad enforcement", () => {
    it("refuses an envelope whose carried AAD differs from the caller's expectedAad", () => {
      const r = generateIdentityKeyPair();
      const env = seal(r.pub, utf8("VK-A"), "share/A#kv1");
      expect(() => sealOpen(r.priv, env, "share/B#kv1")).toThrow();
    });

    it("accepts an envelope whose carried AAD matches the caller's expectedAad", () => {
      const r = generateIdentityKeyPair();
      const env = seal(r.pub, utf8("VK"), "share/A#kv1");
      expect(fromUtf8(sealOpen(r.priv, env, "share/A#kv1"))).toBe("VK");
    });

    it("defaults expectedAad to '' so legacy null-AAD envelopes open unchanged", () => {
      const r = generateIdentityKeyPair();
      const env = seal(r.pub, utf8("legacy"));
      expect(env.aad).toBeNull();
      expect(fromUtf8(sealOpen(r.priv, env))).toBe("legacy");
    });

    it("refuses a coordinate-bound envelope when caller passes the default (empty) expectedAad", () => {
      const r = generateIdentityKeyPair();
      const env = seal(r.pub, utf8("substitute"), "share/A#kv1");
      expect(() => sealOpen(r.priv, env)).toThrow();
    });
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

/**
 * LOW-F regression (audit, docs/02 §2.5). The `padTarget` step function previously had
 * its >256 KiB tail undocumented — auditors couldn't tell from the spec what bucket a 1
 * MiB attachment landed in, and a future SDK could silently change the step size. This
 * test pins both: every fixed bucket below 256 KiB AND the linear 256 KiB step above it.
 */
describe("padTarget — LOW-F bucket boundary pinned", () => {
  it("snaps to the canonical fixed buckets below 256 KiB", () => {
    expect(padTarget(1)).toBe(64);
    expect(padTarget(64)).toBe(64);
    expect(padTarget(65)).toBe(256);
    expect(padTarget(256)).toBe(256);
    expect(padTarget(257)).toBe(1024);
    expect(padTarget(1024)).toBe(1024);
    expect(padTarget(1025)).toBe(4096);
    expect(padTarget(4096)).toBe(4096);
    expect(padTarget(4097)).toBe(16_384);
    expect(padTarget(16_384)).toBe(16_384);
    expect(padTarget(16_385)).toBe(65_536);
    expect(padTarget(65_536)).toBe(65_536);
    expect(padTarget(65_537)).toBe(262_144);
    expect(padTarget(262_144)).toBe(262_144);
  });

  it("rounds up to the next 256 KiB above the largest fixed bucket", () => {
    // 1 byte past 256 KiB → 512 KiB
    expect(padTarget(262_145)).toBe(524_288);
    // 1.5 MiB input → 1.75 MiB envelope (next 256 KiB step)
    expect(padTarget(1_572_864)).toBe(1_572_864);
    // 1.5 MiB + 1 → 1.75 MiB
    expect(padTarget(1_572_865)).toBe(1_835_008);
    // Exactly 4 MiB → 4 MiB
    expect(padTarget(4_194_304)).toBe(4_194_304);
  });

  it("never returns a value smaller than the input (envelope must hold the plaintext)", () => {
    for (const n of [0, 1, 63, 64, 65, 1023, 1024, 1025, 262_144, 262_145, 1_000_000]) {
      expect(padTarget(n)).toBeGreaterThanOrEqual(n);
    }
  });
});

/**
 * LOW-D regression (audit, docs/06 §6.3.1). The old device SAS hashed only the X25519
 * pub, so a server (or network attacker) that swapped the ML-KEM half on the wire could
 * land a substituted hybrid key without changing the 12-character code the human compared.
 *
 *  - With both halves, the SAS MUST change if either half changes.
 *  - With legacy X25519-only devices, the SAS MUST stay byte-identical to the previous
 *    `fingerprint(x25519, 3)` so existing approval flows don't break.
 */
describe("deviceSas — LOW-D hybrid SAS", () => {
  it("changes when the ML-KEM pub changes (the audit attack)", () => {
    const dev1 = generateHybridDeviceKeyPair();
    const dev2 = generateHybridDeviceKeyPair();
    const sasOriginal = deviceSas(dev1.x25519.pub, dev1.mlkem.publicKey);
    const sasMlkemSwapped = deviceSas(dev1.x25519.pub, dev2.mlkem.publicKey);
    expect(sasOriginal).not.toBe(sasMlkemSwapped);
  });

  it("changes when the X25519 pub changes", () => {
    const dev1 = generateHybridDeviceKeyPair();
    const dev2 = generateHybridDeviceKeyPair();
    expect(deviceSas(dev1.x25519.pub, dev1.mlkem.publicKey)).not.toBe(
      deviceSas(dev2.x25519.pub, dev1.mlkem.publicKey),
    );
  });

  it("is deterministic and matches the 12-char-with-dashes display shape", () => {
    const dev = generateHybridDeviceKeyPair();
    const sas = deviceSas(dev.x25519.pub, dev.mlkem.publicKey);
    expect(sas).toBe(deviceSas(dev.x25519.pub, dev.mlkem.publicKey));
    expect(sas).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("falls back to fingerprint(x25519, 3) for legacy X25519-only devices", () => {
    const dev = generateHybridDeviceKeyPair();
    expect(deviceSas(dev.x25519.pub)).toBe(fingerprint(dev.x25519.pub, 3));
    expect(deviceSas(dev.x25519.pub, null)).toBe(fingerprint(dev.x25519.pub, 3));
  });

  it("hybrid SAS differs from the legacy single-key fingerprint over the same X25519 (domain separation)", () => {
    const dev = generateHybridDeviceKeyPair();
    expect(deviceSas(dev.x25519.pub, dev.mlkem.publicKey)).not.toBe(
      fingerprint(dev.x25519.pub, 3),
    );
  });
});
