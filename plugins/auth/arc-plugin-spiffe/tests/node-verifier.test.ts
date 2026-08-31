/**
 * Tests for the Node-builtin JWT-SVID verifier, exercised against *real* ES256/RS256
 * signatures generated in-test — so a regression in the signature path fails here rather
 * than silently accepting forged SVIDs.
 */
import { constants, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createSpiffeJwtSvidVerifier } from "../src/node-verifier";

const TRUST_DOMAIN = "prod.example.com";
const SUB = `spiffe://${TRUST_DOMAIN}/ns/prod/sa/api`;
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function makeSvid(
  alg: string,
  kid: string,
  privateKey: KeyObject,
  payload: Record<string, unknown>,
): string {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = Buffer.from(`${header}.${body}`);
  const sig = alg.startsWith("RS")
    ? sign("sha256", data, { key: privateKey, padding: constants.RSA_PKCS1_PADDING })
    : sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64url(sig)}`;
}

function jwkFor(publicKey: KeyObject, kid: string, alg: string): Record<string, unknown> {
  return { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, alg, use: "sig" };
}

let ec: { publicKey: KeyObject; privateKey: KeyObject };
let rsa: { publicKey: KeyObject; privateKey: KeyObject };
let bundle: { keys: Record<string, unknown>[] };

beforeAll(() => {
  ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  bundle = { keys: [jwkFor(ec.publicKey, "ec1", "ES256"), jwkFor(rsa.publicKey, "rsa1", "RS256")] };
});

const verifier = () => createSpiffeJwtSvidVerifier({ now: () => NOW_MS });

const expected = (over: Record<string, unknown> = {}) => ({
  trustDomain: TRUST_DOMAIN,
  audiences: ["arc"],
  clockSkewSeconds: 60,
  trustBundle: bundle,
  ...over,
});

const goodPayload = { sub: SUB, aud: ["arc"], exp: NOW_SEC + 300, iat: NOW_SEC };

describe("createSpiffeJwtSvidVerifier", () => {
  it("verifies a valid ES256 SVID against the trust bundle", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, goodPayload);
    await expect(verifier().verify(svid, expected())).resolves.toMatchObject({ sub: SUB });
  });

  it("verifies a valid RS256 SVID", async () => {
    const svid = makeSvid("RS256", "rsa1", rsa.privateKey, goodPayload);
    await expect(verifier().verify(svid, expected())).resolves.toMatchObject({ sub: SUB });
  });

  it("rejects a tampered payload", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, goodPayload);
    const [h, , s] = svid.split(".") as [string, string, string];
    const forged = b64url(JSON.stringify({ ...goodPayload, sub: `spiffe://${TRUST_DOMAIN}/ns/prod/sa/admin` }));
    await expect(verifier().verify(`${h}.${forged}.${s}`, expected())).rejects.toThrow(/signature/);
  });

  it("rejects a signature made with the wrong key", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const svid = makeSvid("ES256", "ec1", other.privateKey, goodPayload);
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/signature/);
  });

  it("rejects alg `none`", async () => {
    const header = b64url(JSON.stringify({ alg: "none", kid: "ec1", typ: "JWT" }));
    const body = b64url(JSON.stringify(goodPayload));
    await expect(verifier().verify(`${header}.${body}.`, expected())).rejects.toThrow(/none/);
  });

  it("rejects a kid that is not in the bundle", async () => {
    const svid = makeSvid("ES256", "unknown-kid", ec.privateKey, goodPayload);
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/no trust-bundle key/);
  });

  it("rejects an expired SVID", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, { ...goodPayload, exp: NOW_SEC - 300 });
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/expired/);
  });

  it("rejects an SVID with no exp — a JWT-SVID must expire", async () => {
    const { exp: _drop, ...noExp } = goodPayload;
    const svid = makeSvid("ES256", "ec1", ec.privateKey, noExp);
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/no `exp`/);
  });

  it("rejects an SVID with no audience", async () => {
    const { aud: _drop, ...noAud } = goodPayload;
    const svid = makeSvid("ES256", "ec1", ec.privateKey, noAud);
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/no audience/);
  });

  it("rejects an audience outside boundAudiences", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, { ...goodPayload, aud: ["someone-else"] });
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/audience/);
  });

  it("honours nbf with the configured skew", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, { ...goodPayload, nbf: NOW_SEC + 600 });
    await expect(verifier().verify(svid, expected())).rejects.toThrow(/not yet valid/);
  });

  it("rejects a malformed SVID", async () => {
    await expect(verifier().verify("not.a.jwt.at.all", expected())).rejects.toThrow(/malformed/);
  });

  it("fetches and caches a bundle from bundleEndpoint", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => bundle };
    }) as never;
    const v = createSpiffeJwtSvidVerifier({ now: () => NOW_MS, fetchFn });
    const svid = makeSvid("ES256", "ec1", ec.privateKey, goodPayload);
    const exp = expected({ trustBundle: undefined, bundleEndpoint: "https://spire/bundle" });
    await v.verify(svid, exp);
    await v.verify(svid, exp);
    expect(urls).toEqual(["https://spire/bundle"]);
  });

  it("fails closed when neither a bundle nor an endpoint is configured", async () => {
    const svid = makeSvid("ES256", "ec1", ec.privateKey, goodPayload);
    await expect(
      verifier().verify(svid, expected({ trustBundle: undefined })),
    ).rejects.toThrow(/neither a trustBundle nor a bundleEndpoint/);
  });
});
