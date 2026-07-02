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

  it("separates tenants on shared public suffixes (PSL private section) — the fail-open fix", () => {
    // Before the PSL fix these all collapsed to the shared suffix (e.g. `github.io`), which
    // made every tenant look same-origin. Each must now be its own registrable unit.
    expect(registrableDomain("victim.github.io")).toBe("victim.github.io");
    expect(registrableDomain("attacker.github.io")).toBe("attacker.github.io");
    expect(registrableDomain("my-app.vercel.app")).toBe("my-app.vercel.app");
    expect(registrableDomain("site.pages.dev")).toBe("site.pages.dev");
    // A bare shared suffix has no registrable owner → fail closed.
    expect(registrableDomain("github.io")).toBeNull();
  });
});

describe("originMatches — shared public suffix isolation (SEC-C3)", () => {
  it("does NOT match two different tenants of the same public suffix", () => {
    expect(originMatches("https://attacker.github.io/login", "https://victim.github.io")).toBe(false);
    expect(originMatches("https://evil.vercel.app", "https://good.vercel.app")).toBe(false);
    expect(originMatches("https://a.pages.dev", "https://b.pages.dev")).toBe(false);
  });
  it("still matches the same tenant + its subdomains", () => {
    expect(originMatches("https://victim.github.io/x", "https://victim.github.io")).toBe(true);
    expect(originMatches("https://app.my-app.vercel.app", "https://my-app.vercel.app")).toBe(true);
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
