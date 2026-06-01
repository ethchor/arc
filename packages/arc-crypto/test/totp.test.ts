import { describe, expect, it } from "vitest";
import { base32Encode } from "../src/keys";
import { hotpCode, totpCode } from "../src/totp";
import { VaultCryptoError } from "../src/types";

// RFC 4226 §10.1 — ASCII "12345678901234567890" as the HOTP secret.
const RFC4226_SECRET_B32 = base32Encode(new TextEncoder().encode("12345678901234567890"));

// RFC 6238 §B specifies the test vectors below. SHA-256 uses a 32-byte secret
// (ASCII "12345678901234567890123456789012") and SHA-512 uses 64 bytes — extending the
// 20-byte SHA-1 secret with itself to the required length.
const TWENTY = "12345678901234567890";
const RFC6238_SECRET_SHA256_B32 = base32Encode(new TextEncoder().encode(TWENTY + TWENTY.slice(0, 12)));
const RFC6238_SECRET_SHA512_B32 = base32Encode(new TextEncoder().encode(TWENTY + TWENTY + TWENTY + TWENTY.slice(0, 4)));

describe("HOTP (RFC 4226 KATs)", () => {
  // Table 1 from RFC 4226 §10.1: counter 0..9 against the ASCII-"12345..." secret.
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  for (const [i, want] of expected.entries()) {
    it(`counter=${i} -> ${want}`, () => {
      expect(hotpCode(RFC4226_SECRET_B32, i)).toBe(want);
    });
  }
});

describe("TOTP (RFC 6238 KATs)", () => {
  // RFC 6238 §B table — 8-digit codes for known timestamps across the three algorithms.
  const cases = [
    { time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
    { time: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
    { time: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
    { time: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
    { time: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
  ];
  for (const c of cases) {
    it(`t=${c.time} SHA1=${c.sha1} SHA256=${c.sha256} SHA512=${c.sha512}`, () => {
      expect(
        totpCode(RFC4226_SECRET_B32, { time: c.time, digits: 8, algorithm: "SHA1" }).code,
      ).toBe(c.sha1);
      expect(
        totpCode(RFC6238_SECRET_SHA256_B32, { time: c.time, digits: 8, algorithm: "SHA256" }).code,
      ).toBe(c.sha256);
      expect(
        totpCode(RFC6238_SECRET_SHA512_B32, { time: c.time, digits: 8, algorithm: "SHA512" }).code,
      ).toBe(c.sha512);
    });
  }
});

describe("totpCode behavior", () => {
  it("defaults to 6 digits, 30s period, SHA1 — matching Bitwarden / Google Authenticator", () => {
    const { code, secondsRemaining } = totpCode(RFC4226_SECRET_B32, { time: 59 });
    expect(code).toHaveLength(6);
    // First step of the day for t=59 is counter=1 → RFC 4226 KAT "287082" → last 6 digits.
    expect(code).toBe("287082");
    // t=59 = 29s into the second 30s window, so 1s remains before it rolls.
    expect(secondsRemaining).toBe(1);
  });

  it("normalizes pasted secrets: lowercase, padded, whitespace are all accepted", () => {
    const upper = RFC4226_SECRET_B32;
    const messy = ` ${upper.toLowerCase().replace(/(.{4})/g, "$1 ")}====   `;
    expect(totpCode(upper, { time: 59 }).code).toBe(totpCode(messy, { time: 59 }).code);
  });

  it("rejects an empty secret", () => {
    expect(() => totpCode("", { time: 0 })).toThrow(VaultCryptoError);
    expect(() => totpCode("   ===", { time: 0 })).toThrow(VaultCryptoError);
  });

  it("rejects invalid digit lengths (RFC 4226 requires 6–8)", () => {
    expect(() => totpCode(RFC4226_SECRET_B32, { digits: 5, time: 0 })).toThrow();
    expect(() => totpCode(RFC4226_SECRET_B32, { digits: 9, time: 0 })).toThrow();
  });

  it("rejects non-positive periods", () => {
    expect(() => totpCode(RFC4226_SECRET_B32, { period: 0, time: 0 })).toThrow();
  });

  it("secondsRemaining counts down across a period", () => {
    const period = 30;
    // At t=0 the full period remains; at t=29 only 1s remains.
    expect(totpCode(RFC4226_SECRET_B32, { time: 0, period }).secondsRemaining).toBe(30);
    expect(totpCode(RFC4226_SECRET_B32, { time: 29, period }).secondsRemaining).toBe(1);
    expect(totpCode(RFC4226_SECRET_B32, { time: 30, period }).secondsRemaining).toBe(30);
  });
});
