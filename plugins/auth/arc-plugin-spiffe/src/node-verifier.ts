/**
 * Default {@link JwtSvidVerifier} for the SPIFFE plugin, built on Node built-ins only —
 * `fetch` for trust-bundle retrieval and `node:crypto` for RS256/384/512 and ES256/384/512
 * signature verification. No external dependencies.
 *
 * Verification order (fail-closed): decode header → resolve the signing key from the trust
 * bundle by `kid` → verify the signature → check `aud`, `exp`, `nbf`. Any failure throws.
 *
 * Differences from the OIDC verifier, both from the JWT-SVID spec:
 *  - There is no issuer discovery and no `iss` check — `iss` is optional in a JWT-SVID; trust
 *    is anchored in the bundle, not in a claim.
 *  - `exp` is **required**. An SVID without one would be a bearer token that never expires.
 */
import { createPublicKey, verify as cryptoVerify, constants as cryptoConstants, type JsonWebKey } from "node:crypto";
import type { JsonWebKeySet, JwtSvidClaims, JwtSvidVerifier, SvidVerifyExpectations } from "./types";

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

const ALG_HASH: Record<string, string> = {
  RS256: "sha256",
  RS384: "sha384",
  RS512: "sha512",
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
};

export interface SpiffeVerifierOptions {
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: FetchLike;
  /** Clock source (ms epoch) for tests. Defaults to Date.now. */
  now?: () => number;
  /** How long to cache a fetched trust bundle, ms. Defaults to 5 min. */
  bundleCacheMs?: number;
}

export function createSpiffeJwtSvidVerifier(options: SpiffeVerifierOptions = {}): JwtSvidVerifier {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.bundleCacheMs ?? 5 * 60_000;
  const cache = new Map<string, { keys: Jwk[]; expiresAt: number }>();

  async function keysFor(expected: SvidVerifyExpectations): Promise<Jwk[]> {
    if (expected.trustBundle) return expected.trustBundle.keys as Jwk[];

    const endpoint = expected.bundleEndpoint;
    if (endpoint === undefined) {
      throw new Error("spiffe: neither a trustBundle nor a bundleEndpoint is configured");
    }
    const hit = cache.get(endpoint);
    if (hit && hit.expiresAt > now()) return hit.keys;

    const bundle = (await getJson(fetchFn, endpoint)) as Partial<JsonWebKeySet>;
    const keys = bundle.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`spiffe: trust bundle at ${endpoint} has no keys`);
    }
    cache.set(endpoint, { keys: keys as Jwk[], expiresAt: now() + cacheMs });
    return keys as Jwk[];
  }

  return {
    async verify(svid: string, expected: SvidVerifyExpectations): Promise<JwtSvidClaims> {
      const parts = svid.split(".");
      if (parts.length !== 3) throw new Error("spiffe: malformed JWT-SVID (expected 3 segments)");
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

      const header = decodeJson(headerB64) as { alg?: string; kid?: string };
      const alg = header.alg ?? "";
      if (alg === "none") throw new Error("spiffe: JWT-SVID alg `none` is not acceptable");
      const hash = ALG_HASH[alg];
      if (!hash) throw new Error(`spiffe: unsupported JWT-SVID alg "${alg}"`);

      const keys = await keysFor(expected);
      const jwk = selectKey(keys, header.kid);
      if (!jwk) throw new Error(`spiffe: no trust-bundle key matches kid "${header.kid ?? "(none)"}"`);

      const keyObject = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
      const signature = Buffer.from(sigB64, "base64url");
      if (!verifySignature(alg, hash, keyObject, signingInput, signature)) {
        throw new Error("spiffe: JWT-SVID signature verification failed");
      }

      const claims = decodeJson(payloadB64) as JwtSvidClaims;
      assertSvidClaims(claims, expected, now());
      return claims;
    },
  };
}

function selectKey(keys: Jwk[], kid: string | undefined): Jwk | undefined {
  if (kid) return keys.find((k) => k.kid === kid);
  // No kid in the header: only safe if the bundle is unambiguous.
  return keys.length === 1 ? keys[0] : undefined;
}

function verifySignature(
  alg: string,
  hash: string,
  keyObject: ReturnType<typeof createPublicKey>,
  data: Buffer,
  signature: Buffer,
): boolean {
  if (alg.startsWith("RS")) {
    return cryptoVerify(hash, data, { key: keyObject, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
  }
  if (alg.startsWith("ES")) {
    // JWT ECDSA signatures are raw r||s (IEEE P1363); Node defaults to DER.
    return cryptoVerify(hash, data, { key: keyObject, dsaEncoding: "ieee-p1363" }, signature);
  }
  throw new Error(`spiffe: unsupported JWT-SVID alg "${alg}"`);
}

function assertSvidClaims(claims: JwtSvidClaims, expected: SvidVerifyExpectations, nowMs: number): void {
  const aud = claims.aud;
  const audList = Array.isArray(aud) ? aud.map(String) : aud === undefined ? [] : [String(aud)];
  if (audList.length === 0) {
    throw new Error("spiffe: JWT-SVID has no audience");
  }
  if (!audList.some((a) => expected.audiences.includes(a))) {
    throw new Error("spiffe: audience not in boundAudiences");
  }

  const skew = expected.clockSkewSeconds;
  const nowSec = Math.floor(nowMs / 1000);
  // The JWT-SVID spec requires `exp`; treat its absence as a hard failure rather than as
  // "never expires".
  if (typeof claims.exp !== "number") {
    throw new Error("spiffe: JWT-SVID has no `exp` claim");
  }
  if (nowSec > claims.exp + skew) {
    throw new Error("spiffe: JWT-SVID expired");
  }
  if (typeof claims.nbf === "number" && nowSec + skew < claims.nbf) {
    throw new Error("spiffe: JWT-SVID not yet valid (nbf)");
  }
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`spiffe: GET ${url} failed (${res.status})`);
  return res.json();
}

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
