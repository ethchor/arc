import { describe, expect, it } from "vitest";
import { normalizePrefix, scope, scopeAllows } from "../src/index";

describe("normalizePrefix", () => {
  it("strips leading + trailing slashes and re-adds one trailing slash", () => {
    expect(normalizePrefix("/secret/")).toBe("secret/");
    expect(normalizePrefix("secret")).toBe("secret/");
    expect(normalizePrefix("//database//")).toBe("database/");
  });

  it("returns empty string for empty input", () => {
    expect(normalizePrefix("")).toBe("");
    expect(normalizePrefix("///")).toBe("");
  });
});

describe("scope", () => {
  it("normalizes the prefix on construction", () => {
    const s = scope("/secret", ["read"]);
    expect(s.pathPrefix).toBe("secret/");
    expect(s.capabilities).toEqual(["read"]);
  });
});

describe("scopeAllows", () => {
  it("permits a covered capability on a covered path", () => {
    expect(scopeAllows([scope("database/", ["read", "create"])], "database/creds/app", "read")).toBe(true);
  });

  it("denies an uncovered capability", () => {
    expect(scopeAllows([scope("database/", ["read"])], "database/creds/app", "delete")).toBe(false);
  });

  it("denies an uncovered path", () => {
    expect(scopeAllows([scope("database/", ["read"])], "aws/creds/app", "read")).toBe(false);
  });

  it("treats `sudo` as every capability", () => {
    expect(scopeAllows([scope("sys/", ["sudo"])], "sys/seal", "update")).toBe(true);
    expect(scopeAllows([scope("sys/", ["sudo"])], "sys/seal", "delete")).toBe(true);
  });

  it("returns false on an empty scope array", () => {
    expect(scopeAllows([], "secret/x", "read")).toBe(false);
  });

  it("does not match across segment boundaries", () => {
    // The classic Vault footgun: `secret/` must not match `secret-other/foo`. The
    // trailing-slash on the prefix + probing `<path>/` guarantees segment safety.
    expect(scopeAllows([scope("secret/", ["read"])], "secret-other/foo", "read")).toBe(false);
  });

  it("permits via the longest-prefix scope (any matching scope is enough)", () => {
    const scopes = [
      scope("database/", ["read"]),
      scope("database/creds/", ["create"]),
    ];
    expect(scopeAllows(scopes, "database/creds/app", "create")).toBe(true);
    expect(scopeAllows(scopes, "database/creds/app", "read")).toBe(true);
  });

  it("handles a leading-slash path argument the same as an unprefixed one", () => {
    expect(scopeAllows([scope("secret/", ["read"])], "/secret/foo", "read")).toBe(true);
  });
});
