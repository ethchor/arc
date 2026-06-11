/**
 * Unit spec for the engine-path canonicalizer.
 *
 * SECURITY: this validator is the single source of truth used by `CapabilityGuard` (to
 * decide which ACL prefix applies) AND by the engine controller (to assemble the OpenBao
 * URL). If the two layers disagreed about whether `..` segments belonged in the path,
 * a caller authorized for `secret/` could reach `sys/` by sending
 * `/v1/secret/data/../../sys/seal-status` — the ACL match runs on the raw text, fetch
 * collapses the `..`, and the OpenBao token is `root` under the helm dev-mode default.
 * That is HIGH-A from the untrusted-code audit; this spec pins the rejection.
 */
import { canonicalizeEnginePath, EnginePathError } from "./path-canon";

describe("canonicalizeEnginePath", () => {
  it("returns the path stripped of the /v1/ prefix and any leading slashes", () => {
    expect(canonicalizeEnginePath("/v1/secret/data/foo")).toBe("secret/data/foo");
    expect(canonicalizeEnginePath("///v1/secret/data/foo")).toBe("secret/data/foo");
  });

  it("refuses input that is not on the /v1 surface (the canonicalizer is only for engine paths)", () => {
    expect(() => canonicalizeEnginePath("/vaults")).toThrow(EnginePathError);
    expect(() => canonicalizeEnginePath("secret/data/foo")).toThrow(EnginePathError);
  });

  it("drops the query string before validation (a `?` is never a path segment)", () => {
    expect(canonicalizeEnginePath("/v1/pki/certs?list=true")).toBe("pki/certs");
  });

  // --- the traversal regression: every shape must be refused identically ---

  it.each([
    ["literal .. segment", "/v1/secret/data/../../sys/seal-status"],
    ["literal . segment", "/v1/secret/./data/x"],
    ["leading .. before a valid mount", "/v1/../sys/seal-status"],
    ["trailing .. ", "/v1/secret/data/.."],
    ["only ..", "/v1/.."],
    ["percent-encoded .. (lowercase)", "/v1/secret/data/%2e%2e/sys/seal-status"],
    ["percent-encoded .. (uppercase)", "/v1/secret/data/%2E%2E/sys/seal-status"],
    ["percent-encoded . segment", "/v1/secret/%2e/data/x"],
    ["mixed encoded .. (.%2e)", "/v1/secret/.%2e/sys/seal-status"],
  ] as const)("rejects %s", (_label, input) => {
    expect(() => canonicalizeEnginePath(input)).toThrow(EnginePathError);
    try {
      canonicalizeEnginePath(input);
    } catch (err) {
      expect(err).toBeInstanceOf(EnginePathError);
      expect((err as EnginePathError).getResponse()).toMatchObject({ error: "invalid_engine_path" });
    }
  });

  it("rejects empty segments (//)", () => {
    expect(() => canonicalizeEnginePath("/v1/secret//data/foo")).toThrow(EnginePathError);
  });

  it("rejects an empty path", () => {
    expect(() => canonicalizeEnginePath("/v1/")).toThrow(EnginePathError);
    expect(() => canonicalizeEnginePath("/v1")).toThrow(EnginePathError);
    expect(() => canonicalizeEnginePath("")).toThrow(EnginePathError);
  });

  it("rejects malformed percent-encoding (defense-in-depth — bad input is not a valid path)", () => {
    expect(() => canonicalizeEnginePath("/v1/secret/%ZZ/foo")).toThrow(EnginePathError);
  });

  it("preserves a single trailing slash for KV v2 metadata paths", () => {
    expect(canonicalizeEnginePath("/v1/secret/metadata/foo/")).toBe("secret/metadata/foo/");
  });

  it("allows path segments that look like a partial dot (.x / x. / .. inside a longer string)", () => {
    // Only an EXACT `.` / `..` segment is a traversal marker. Real paths legitimately
    // contain dots (e.g. `pki/cert/3f.crt`).
    expect(canonicalizeEnginePath("/v1/pki/cert/3f.crt")).toBe("pki/cert/3f.crt");
    expect(canonicalizeEnginePath("/v1/secret/data/.hidden")).toBe("secret/data/.hidden");
    expect(canonicalizeEnginePath("/v1/secret/data/..hidden")).toBe("secret/data/..hidden");
  });
});
