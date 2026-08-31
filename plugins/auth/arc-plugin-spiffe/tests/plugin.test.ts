/**
 * Unit tests for the SPIFFE auth plugin: SPIFFE-ID parsing, role binding, config validation
 * and the login exchange. The crypto/transport boundary is faked here — real signature
 * verification is covered in `node-verifier.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { matchesPathPrefix, parseSpiffeId, SpiffeAuthPlugin } from "../src/plugin";
import type { JwtSvidClaims, JwtSvidVerifier, SvidVerifyExpectations } from "../src/types";

const TRUST_DOMAIN = "prod.example.com";
const BUNDLE = { keys: [{ kid: "k1", kty: "EC" }] };

/** A verifier that returns canned claims (or throws), recording what it was asked to verify. */
function fakeVerifier(claims: JwtSvidClaims, opts: { throwErr?: Error } = {}) {
  const calls: { svid: string; expected: SvidVerifyExpectations }[] = [];
  const verifier: JwtSvidVerifier = {
    async verify(svid, expected) {
      calls.push({ svid, expected });
      if (opts.throwErr) throw opts.throwErr;
      return claims;
    },
  };
  return { verifier, calls };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    trustDomain: TRUST_DOMAIN,
    trustBundle: BUNDLE,
    roles: {
      api: {
        boundSpiffeIdPrefixes: ["/ns/prod/sa/"],
        boundAudiences: ["arc"],
        policies: ["read-prod-db"],
      },
    },
    ...overrides,
  };
}

async function configured(claims: JwtSvidClaims, cfg: Record<string, unknown> = baseConfig()) {
  const { verifier, calls } = fakeVerifier(claims);
  const plugin = new SpiffeAuthPlugin(verifier);
  await plugin.configure(cfg);
  return { plugin, calls };
}

describe("parseSpiffeId", () => {
  it("parses a well-formed SPIFFE ID", () => {
    expect(parseSpiffeId("spiffe://prod.example.com/ns/web/sa/api")).toEqual({
      id: "spiffe://prod.example.com/ns/web/sa/api",
      trustDomain: "prod.example.com",
      path: "/ns/web/sa/api",
    });
  });

  it.each([
    ["a non-spiffe scheme", "https://prod.example.com/ns/web"],
    ["userinfo", "spiffe://user:pw@prod.example.com/ns/web"],
    ["a port", "spiffe://prod.example.com:8443/ns/web"],
    ["a query", "spiffe://prod.example.com/ns/web?x=1"],
    ["a fragment", "spiffe://prod.example.com/ns/web#frag"],
    ["no workload path", "spiffe://prod.example.com"],
    ["a bare-root path", "spiffe://prod.example.com/"],
    ["an empty path segment", "spiffe://prod.example.com/ns//web"],
    ["a relative path segment", "spiffe://prod.example.com/ns/../admin"],
    ["an uppercase trust domain", "spiffe://PROD.example.com/ns/web"],
    ["a percent-encoded path", "spiffe://prod.example.com/ns%2Fadmin"],
    ["not a URI at all", "certainly-not-a-uri"],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSpiffeId(value)).toThrow();
  });
});

describe("matchesPathPrefix", () => {
  it("matches on a path-segment boundary, not a raw string prefix", () => {
    expect(matchesPathPrefix("/ns/prod/sa/api", "/ns/prod")).toBe(true);
    expect(matchesPathPrefix("/ns/prod", "/ns/prod")).toBe(true);
    expect(matchesPathPrefix("/ns/prod/sa/api", "/ns/prod/")).toBe(true);
    // The bug this guards: a raw startsWith would accept a different namespace.
    expect(matchesPathPrefix("/ns/production/sa/api", "/ns/prod")).toBe(false);
  });

  it("never matches an empty prefix", () => {
    expect(matchesPathPrefix("/ns/prod", "/")).toBe(false);
  });
});

describe("configure", () => {
  const plugin = () => new SpiffeAuthPlugin(fakeVerifier({}).verifier);

  it("accepts a valid config", async () => {
    const p = plugin();
    await expect(p.configure(baseConfig())).resolves.toBeUndefined();
    expect(p.configuredRoles()).toEqual(["api"]);
  });

  it("rejects a role bound to neither ids nor prefixes", async () => {
    await expect(
      plugin().configure(
        baseConfig({ roles: { api: { boundAudiences: ["arc"], policies: ["p"] } } }),
      ),
    ).rejects.toThrow(/boundSpiffeIds/);
  });

  it("rejects a role with no bound audiences", async () => {
    await expect(
      plugin().configure(
        baseConfig({ roles: { api: { boundSpiffeIdPrefixes: ["/ns/"], policies: ["p"] } } }),
      ),
    ).rejects.toThrow(/boundAudiences/);
  });

  it("rejects a plaintext bundle endpoint", async () => {
    await expect(
      plugin().configure(
        baseConfig({ trustBundle: undefined, bundleEndpoint: "http://spire/bundle" }),
      ),
    ).rejects.toThrow(/https/);
  });

  it("requires exactly one of trustBundle / bundleEndpoint", async () => {
    await expect(
      plugin().configure(baseConfig({ bundleEndpoint: "https://spire/bundle" })),
    ).rejects.toThrow(/exactly one/);
    await expect(plugin().configure(baseConfig({ trustBundle: undefined }))).rejects.toThrow(
      /exactly one/,
    );
  });

  it("rejects an uppercase or scheme-bearing trust domain", async () => {
    await expect(plugin().configure(baseConfig({ trustDomain: "PROD.example.com" }))).rejects.toThrow(
      /lowercase/,
    );
    await expect(
      plugin().configure(baseConfig({ trustDomain: "spiffe://prod.example.com" })),
    ).rejects.toThrow(/scheme/);
  });

  it("rejects a malformed bound SPIFFE ID at configure time, not first login", async () => {
    await expect(
      plugin().configure(
        baseConfig({
          roles: { api: { boundSpiffeIds: ["not-a-spiffe-id"], boundAudiences: ["arc"], policies: ["p"] } },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("login", () => {
  const goodClaims = { sub: `spiffe://${TRUST_DOMAIN}/ns/prod/sa/api`, aud: ["arc"], exp: 1_700_000_900 };

  it("exchanges a valid SVID for the role's policies", async () => {
    const { plugin } = await configured(goodClaims);
    const res = await plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } });
    expect(res.identityId).toBe(`spiffe://${TRUST_DOMAIN}/ns/prod/sa/api`);
    expect(res.policies).toEqual(["read-prod-db"]);
    expect(res.tokenTtlSeconds).toBe(3600);
    expect(res.metadata).toMatchObject({ role: "api", trustDomain: TRUST_DOMAIN, spiffePath: "/ns/prod/sa/api" });
  });

  it("accepts the SVID under either `svid` or `jwt`", async () => {
    const { plugin, calls } = await configured(goodClaims);
    await plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", jwt: "from-jwt-field" } });
    expect(calls[0]?.svid).toBe("from-jwt-field");
  });

  it("passes the role's audiences and the configured bundle to the verifier", async () => {
    const { plugin, calls } = await configured(goodClaims);
    await plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } });
    expect(calls[0]?.expected).toMatchObject({
      trustDomain: TRUST_DOMAIN,
      audiences: ["arc"],
      trustBundle: BUNDLE,
    });
  });

  it("rejects an SVID from a different trust domain even though it verified", async () => {
    const { plugin } = await configured({ ...goodClaims, sub: "spiffe://evil.example.com/ns/prod/sa/api" });
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } }),
    ).rejects.toThrow(/trust domain/);
  });

  it("rejects a SPIFFE ID that is not bound to the role", async () => {
    const { plugin } = await configured({ ...goodClaims, sub: `spiffe://${TRUST_DOMAIN}/ns/staging/sa/api` });
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } }),
    ).rejects.toThrow(/not bound to this role/);
  });

  it("does not let a near-miss namespace satisfy a prefix binding", async () => {
    const { plugin } = await configured({ ...goodClaims, sub: `spiffe://${TRUST_DOMAIN}/ns/prod-admin/sa/api` });
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } }),
    ).rejects.toThrow(/not bound to this role/);
  });

  it("rejects an unknown role", async () => {
    const { plugin } = await configured(goodClaims);
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "nope", svid: "tok" } }),
    ).rejects.toThrow(/unknown role/);
  });

  it("never takes policies from the SVID itself", async () => {
    const { plugin } = await configured({ ...goodClaims, policies: ["root"], arc_policies: ["root"] });
    const res = await plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } });
    expect(res.policies).toEqual(["read-prod-db"]);
  });

  it("surfaces a verifier failure as a login failure", async () => {
    const { verifier } = fakeVerifier({}, { throwErr: new Error("signature verification failed") });
    const plugin = new SpiffeAuthPlugin(verifier);
    await plugin.configure(baseConfig());
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("refuses to log in before configure()", async () => {
    const plugin = new SpiffeAuthPlugin(fakeVerifier({}).verifier);
    await expect(
      plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } }),
    ).rejects.toThrow(/not configured/);
  });

  it("honours an exact boundSpiffeIds binding", async () => {
    const { plugin } = await configured(goodClaims, {
      trustDomain: TRUST_DOMAIN,
      trustBundle: BUNDLE,
      roles: {
        api: {
          boundSpiffeIds: [`spiffe://${TRUST_DOMAIN}/ns/prod/sa/api`],
          boundAudiences: ["arc"],
          policies: ["exact"],
          tokenTtlSeconds: 300,
        },
      },
    });
    const res = await plugin.login({ mount: "auth/spiffe/", credentials: { role: "api", svid: "tok" } });
    expect(res.policies).toEqual(["exact"]);
    expect(res.tokenTtlSeconds).toBe(300);
  });
});
