import { describe, expect, it, vi } from "vitest";
import { OidcAuthPlugin } from "../src/plugin";
import type { JwtClaims, JwtVerifier, VerifyExpectations } from "../src/types";

/** A verifier that returns canned claims (or throws), and records what it was asked to verify. */
function fakeVerifier(claims: JwtClaims, opts: { throwErr?: Error } = {}) {
  const calls: { token: string; expected: VerifyExpectations }[] = [];
  const verifier: JwtVerifier = {
    async verify(token, expected) {
      calls.push({ token, expected });
      if (opts.throwErr) throw opts.throwErr;
      return claims;
    },
  };
  return { verifier, calls };
}

const baseConfig = {
  issuer: "https://idp.example.com",
  roles: {
    ci: {
      boundAudiences: ["arc"],
      policies: ["ci-deploy", "read-secrets"],
      tokenTtlSeconds: 900,
    },
  },
};

describe("OidcAuthPlugin.configure", () => {
  it("rejects config without an issuer", async () => {
    const { verifier } = fakeVerifier({});
    await expect(new OidcAuthPlugin(verifier).configure({ roles: {} })).rejects.toThrow(/issuer/);
  });

  it("rejects a role without boundAudiences or policies", async () => {
    const { verifier } = fakeVerifier({});
    const p = new OidcAuthPlugin(verifier);
    await expect(p.configure({ issuer: "x", roles: { r: { policies: ["a"] } } })).rejects.toThrow(/boundAudiences/);
    await expect(p.configure({ issuer: "x", roles: { r: { boundAudiences: ["a"] } } })).rejects.toThrow(/policies/);
  });

  it("exposes the configured role names", async () => {
    const { verifier } = fakeVerifier({});
    const p = new OidcAuthPlugin(verifier);
    await p.configure(baseConfig);
    expect(p.configuredRoles()).toEqual(["ci"]);
  });
});

describe("OidcAuthPlugin.login", () => {
  it("verifies the token with the role's audiences + the configured issuer, then maps to policies", async () => {
    const { verifier, calls } = fakeVerifier({ sub: "repo:acme/app", aud: "arc", iss: "https://idp.example.com" });
    const p = new OidcAuthPlugin(verifier);
    await p.configure(baseConfig);

    const res = await p.login({ mount: "auth/oidc/", credentials: { role: "ci", jwt: "h.p.s" } });

    expect(calls[0]?.expected).toMatchObject({ issuer: "https://idp.example.com", audiences: ["arc"] });
    expect(res.identityId).toBe("repo:acme/app");
    expect(res.alias).toBe("repo:acme/app");
    expect(res.policies).toEqual(["ci-deploy", "read-secrets"]);
    expect(res.tokenTtlSeconds).toBe(900);
    expect(res.metadata).toMatchObject({ role: "ci", issuer: "https://idp.example.com" });
  });

  it("defaults the user claim to sub and the ttl to 3600", async () => {
    const { verifier } = fakeVerifier({ sub: "abc", aud: "arc" });
    const p = new OidcAuthPlugin(verifier);
    await p.configure({ issuer: "i", roles: { r: { boundAudiences: ["arc"], policies: ["x"] } } });
    const res = await p.login({ mount: "m", credentials: { role: "r", jwt: "t" } });
    expect(res.identityId).toBe("abc");
    expect(res.tokenTtlSeconds).toBe(3600);
  });

  it("honours a custom userClaim and surfaces groups into metadata", async () => {
    const { verifier } = fakeVerifier({ email: "a@b.com", aud: "arc", teams: ["platform", "sec"] });
    const p = new OidcAuthPlugin(verifier);
    await p.configure({
      issuer: "i",
      roles: { r: { boundAudiences: ["arc"], policies: ["x"], userClaim: "email", groupsClaim: "teams" } },
    });
    const res = await p.login({ mount: "m", credentials: { role: "r", jwt: "t" } });
    expect(res.identityId).toBe("a@b.com");
    expect(res.metadata?.groups).toBe("platform,sec");
  });

  it("enforces boundClaims (string equality and array intersection)", async () => {
    const { verifier } = fakeVerifier({ sub: "u", aud: "arc", repository: "acme/app", groups: ["dev", "deployer"] });
    const p = new OidcAuthPlugin(verifier);
    await p.configure({
      issuer: "i",
      roles: { r: { boundAudiences: ["arc"], policies: ["x"], boundClaims: { repository: "acme/app", groups: ["deployer"] } } },
    });
    await expect(p.login({ mount: "m", credentials: { role: "r", jwt: "t" } })).resolves.toBeDefined();
  });

  it("rejects when a bound claim does not match", async () => {
    const { verifier } = fakeVerifier({ sub: "u", aud: "arc", repository: "evil/repo" });
    const p = new OidcAuthPlugin(verifier);
    await p.configure({
      issuer: "i",
      roles: { r: { boundAudiences: ["arc"], policies: ["x"], boundClaims: { repository: "acme/app" } } },
    });
    await expect(p.login({ mount: "m", credentials: { role: "r", jwt: "t" } })).rejects.toThrow(/bound claim/);
  });

  it("does not let the token grant itself extra policies", async () => {
    // A malicious token carrying a `policies` claim must be ignored — policies come from the role.
    const { verifier } = fakeVerifier({ sub: "u", aud: "arc", policies: ["root", "sudo-everything"] });
    const p = new OidcAuthPlugin(verifier);
    await p.configure(baseConfig);
    const res = await p.login({ mount: "m", credentials: { role: "ci", jwt: "t" } });
    expect(res.policies).toEqual(["ci-deploy", "read-secrets"]);
  });

  it("rejects an unknown role and missing credentials", async () => {
    const { verifier } = fakeVerifier({ sub: "u", aud: "arc" });
    const p = new OidcAuthPlugin(verifier);
    await p.configure(baseConfig);
    await expect(p.login({ mount: "m", credentials: { role: "nope", jwt: "t" } })).rejects.toThrow(/unknown role/);
    await expect(p.login({ mount: "m", credentials: { role: "ci" } })).rejects.toThrow(/jwt/);
  });

  it("propagates a verifier failure (bad signature / expiry) instead of authenticating", async () => {
    const { verifier } = fakeVerifier({ sub: "u", aud: "arc" }, { throwErr: new Error("oidc: token expired") });
    const p = new OidcAuthPlugin(verifier);
    await p.configure(baseConfig);
    await expect(p.login({ mount: "m", credentials: { role: "ci", jwt: "t" } })).rejects.toThrow(/expired/);
  });

  it("rejects login before configure", async () => {
    const { verifier } = fakeVerifier({});
    await expect(new OidcAuthPlugin(verifier).login({ mount: "m", credentials: { role: "r", jwt: "t" } })).rejects.toThrow(/not configured/);
  });
});
