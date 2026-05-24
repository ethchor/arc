import { describe, expect, it } from "vitest";
import { jcs, VaultCryptoError } from "../src";

describe("jcs (RFC 8785 / I-JSON)", () => {
  it("sorts object keys by code-unit order", () => {
    expect(jcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("canonicalizes nested structures deterministically", () => {
    expect(jcs({ z: [3, 2, 1], a: { d: "x", c: null } })).toBe(
      '{"a":{"c":null,"d":"x"},"z":[3,2,1]}',
    );
  });

  it("is independent of insertion order", () => {
    expect(jcs({ a: 1, b: 2, c: 3 })).toBe(jcs({ c: 3, a: 1, b: 2 }));
  });

  it("escapes strings like JSON", () => {
    expect(jcs('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("serializes booleans and null", () => {
    expect(jcs({ t: true, f: false, n: null })).toBe('{"f":false,"n":null,"t":true}');
  });

  it("rejects non-integer numbers (I-JSON constraint)", () => {
    expect(() => jcs(1.5)).toThrow(VaultCryptoError);
  });

  it("rejects non-finite numbers", () => {
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow(VaultCryptoError);
  });
});
