/**
 * Default {@link JwtVerifier} for the OIDC plugin, built on Node built-ins only — `fetch`
 * for OIDC discovery + JWKS retrieval, and `node:crypto` for RS256/384/512 and ES256/384/512
 * signature verification. No external dependencies.
 *
 * Verification order (fail-closed): decode header → resolve the signing key from the issuer's
 * JWKS by `kid` → verify the signature → check `iss`, `aud`, `exp`, `nbf`. Any failure throws.
 */
import { createPublicKey, verify as cryptoVerify, constants as cryptoConstants, type JsonWebKey } from "node:crypto";
import type { JwtClaims, JwtVerifier, VerifyExpectations } from "./types";

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

export interface OidcVerifierOptions {
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: FetchLike;
  /** Clock source (ms epoch) for tests. Defaults to Date.now. */
  now?: () => number;
  /** How long to cache a fetched JWKS, ms. Defaults to 5 min. */
  jwksCacheMs?: number;
}

export function createOidcJwtVerifier(options: OidcVerifierOptions = {}): JwtVerifier {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.jwksCacheMs ?? 5 * 60_000;
  const cache = new Map<string, { keys: Jwk[]; expiresAt: number }>();

  async function jwksFor(issuer: string): Promise<Jwk[]> {
    const hit = cache.get(issuer);
    if (hit && hit.expiresAt > now()) return hit.keys;

    const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const disc = await getJson(fetchFn, discoveryUrl);
    const jwksUri = (disc as { jwks_uri?: unknown }).jwks_uri;
    if (typeof jwksUri !== "string") throw new Error(`oidc discovery at ${discoveryUrl} has no jwks_uri`);
    const jwks = await getJson(fetchFn, jwksUri);
    const keys = (jwks as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new Error(`oidc JWKS at ${jwksUri} has no keys array`);
    cache.set(issuer, { keys: keys as Jwk[], expiresAt: now() + cacheMs });
    return keys as Jwk[];
  }

  return {
    async verify(token: string, expected: VerifyExpectations): Promise<JwtClaims> {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("oidc: malformed JWT (expected 3 segments)");
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

      const header = decodeJson(headerB64) as { alg?: string; kid?: string };
      const alg = header.alg ?? "";
      const hash = ALG_HASH[alg];
      if (!hash) throw new Error(`oidc: unsupported JWT alg "${alg}"`);

      const keys = await jwksFor(expected.issuer);
      const jwk = selectKey(keys, header.kid);
      if (!jwk) throw new Error(`oidc: no JWKS key matches kid "${header.kid ?? "(none)"}"`);

      const keyObject = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
      const signature = Buffer.from(sigB64, "base64url");
      if (!verifySignature(alg, hash, keyObject, signingInput, signature)) {
        throw new Error("oidc: JWT signature verification failed");
      }

      const claims = decodeJson(payloadB64) as JwtClaims;
      assertStandardClaims(claims, expected, now());
      return claims;
    },
  };
}

function selectKey(keys: Jwk[], kid: string | undefined): Jwk | undefined {
  if (kid) return keys.find((k) => k.kid === kid);
  // No kid in the header: only safe if the set is unambiguous.
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
  throw new Error(`oidc: unsupported JWT alg "${alg}"`);
}

function assertStandardClaims(claims: JwtClaims, expected: VerifyExpectations, nowMs: number): void {
  if (claims.iss !== expected.issuer) {
    throw new Error(`oidc: issuer mismatch (got "${String(claims.iss)}")`);
  }
  const aud = claims.aud;
  const audList = Array.isArray(aud) ? aud.map(String) : [String(aud)];
  if (!audList.some((a) => expected.audiences.includes(a))) {
    throw new Error("oidc: audience not in boundAudiences");
  }
  const skew = expected.clockSkewSeconds;
  const nowSec = Math.floor(nowMs / 1000);
  if (typeof claims.exp === "number" && nowSec > claims.exp + skew) {
    throw new Error("oidc: token expired");
  }
  if (typeof claims.nbf === "number" && nowSec + skew < claims.nbf) {
    throw new Error("oidc: token not yet valid (nbf)");
  }
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`oidc: GET ${url} failed (${res.status})`);
  return res.json();
}

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
