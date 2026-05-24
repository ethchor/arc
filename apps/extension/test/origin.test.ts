import { describe, expect, it } from "vitest";
import { originMatches, registrableDomain } from "../src/origin";

describe("registrableDomain", () => {
  it("reduces to eTLD+1", () => {
    expect(registrableDomain("login.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
  });
  it("returns null for bare TLDs / junk", () => {
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });
});

describe("originMatches (autofill binding)", () => {
  it("matches same registrable domain over HTTPS", () => {
    expect(originMatches("https://login.example.com/in", "https://example.com")).toBe(true);
    expect(originMatches("https://app.example.co.uk", "https://example.co.uk")).toBe(true);
  });

  it("rejects look-alike / sibling domains (anti-phishing)", () => {
    expect(originMatches("https://example.com.evil.tld", "https://example.com")).toBe(false);
    expect(originMatches("https://evil.com", "https://example.com")).toBe(false);
    expect(originMatches("https://notexample.com", "https://example.com")).toBe(false);
  });

  it("never fills over http", () => {
    expect(originMatches("http://example.com", "https://example.com")).toBe(false);
  });

  it("fails closed on malformed input", () => {
    expect(originMatches("not a url", "https://example.com")).toBe(false);
  });
});
