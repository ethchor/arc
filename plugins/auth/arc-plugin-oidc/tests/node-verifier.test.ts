import { constants, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createOidcJwtVerifier } from "../src/node-verifier";

const ISSUER = "https://idp.example.com";
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function makeJwt(alg: string, kid: string, privateKey: KeyObject, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const data = Buffer.from(signingInput);
  const sig = alg.startsWith("RS")
    ? sign("sha256", data, { key: privateKey, padding: constants.RSA_PKCS1_PADDING })
    : sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

function jwkFor(publicKey: KeyObject, kid: string, alg: string): Record<string, unknown> {
  return { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, alg, use: "sig" };
}

/** Fake discovery + JWKS endpoints; records the URLs fetched so we can assert caching. */
function fakeFetch(keys: Record<string, unknown>[]) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return { ok: true, status: 200, json: async () => ({ jwks_uri: `${ISSUER}/jwks` }) };
    }
    if (url === `${ISSUER}/jwks`) {
      return { ok: true, status: 200, json: async () => ({ keys }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

function validPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: "arc", sub: "user-1", iat: NOW_SEC - 5, nbf: NOW_SEC - 5, exp: NOW_SEC + 3600, ...extra };
}

const expected = { issuer: ISSUER, audiences: ["arc"], clockSkewSeconds: 60 };

describe("createOidcJwtVerifier — RS256", () => {
  const jwk = jwkFor(rsa.publicKey, "rsa-1", "RS256");

  it("verifies a well-formed RS256 token and returns its claims", async () => {
    const { fetchFn } = fakeFetch([jwk]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload({ groups: ["a"] }));
    const claims = await verifier.verify(token, expected);
    expect(claims.sub).toBe("user-1");
    expect(claims.groups).toEqual(["a"]);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const { fetchFn } = fakeFetch([jwk]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload());
    const [h, _p, s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify(validPayload({ sub: "admin" })))}.${s}`;
    await expect(verifier.verify(forged, expected)).rejects.toThrow(/signature/);
  });

  it("rejects a token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { fetchFn } = fakeFetch([jwk]); // JWKS still advertises the original key
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("RS256", "rsa-1", other.privateKey, validPayload());
    await expect(verifier.verify(token, expected)).rejects.toThrow(/signature/);
  });

  it("rejects issuer mismatch, audience mismatch, and expiry", async () => {
    const { fetchFn } = fakeFetch([jwk]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    await expect(
      verifier.verify(makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload({ iss: "https://evil" })), expected),
    ).rejects.toThrow(/issuer/);
    await expect(
      verifier.verify(makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload({ aud: "someone-else" })), expected),
    ).rejects.toThrow(/audience/);
    await expect(
      verifier.verify(makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload({ exp: NOW_SEC - 3600 })), expected),
    ).rejects.toThrow(/expired/);
  });

  it("rejects when no JWKS key matches the kid", async () => {
    const { fetchFn } = fakeFetch([jwkFor(rsa.publicKey, "different-kid", "RS256")]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload());
    await expect(verifier.verify(token, expected)).rejects.toThrow(/kid/);
  });

  it("caches the JWKS (discovery + jwks fetched once across two verifies)", async () => {
    const { fetchFn, calls } = fakeFetch([jwk]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("RS256", "rsa-1", rsa.privateKey, validPayload());
    await verifier.verify(token, expected);
    await verifier.verify(token, expected);
    expect(calls.filter((u) => u.endsWith("/jwks")).length).toBe(1);
  });
});

describe("createOidcJwtVerifier — ES256", () => {
  it("verifies a well-formed ES256 (P-256) token", async () => {
    const jwk = jwkFor(ec.publicKey, "ec-1", "ES256");
    const { fetchFn } = fakeFetch([jwk]);
    const verifier = createOidcJwtVerifier({ fetchFn, now: () => NOW_MS });
    const token = makeJwt("ES256", "ec-1", ec.privateKey, validPayload());
    const claims = await verifier.verify(token, expected);
    expect(claims.sub).toBe("user-1");
  });
});
