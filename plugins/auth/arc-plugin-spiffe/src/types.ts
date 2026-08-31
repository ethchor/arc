/**
 * Config for the SPIFFE auth plugin. Mirrors the shape of OpenBao / Vault's SPIFFE (and
 * `jwt`) auth methods: a trust domain, a trust bundle to verify against, and named roles
 * binding SPIFFE IDs to a set of arc policies.
 *
 * The plugin accepts a **JWT-SVID** — the JWT form of a SPIFFE Verifiable Identity Document,
 * as issued by SPIRE or any SPIFFE-conformant workload API — and exchanges it for an arc
 * token. X.509-SVIDs are deliberately out of scope here: they are presented via mTLS and
 * verified at the TLS terminator, not in an HTTP login body.
 *
 * See SPIFFE spec: `spiffe://<trust-domain>/<workload-path>`.
 */

/** A JWKS, as published in a SPIFFE trust bundle. */
export interface JsonWebKeySet {
  keys: Record<string, unknown>[];
}

export interface SpiffeRoleConfig {
  /**
   * Exact SPIFFE IDs this role accepts, e.g. `spiffe://prod.example.com/ns/web/sa/api`.
   * At least one of `boundSpiffeIds` / `boundSpiffeIdPrefixes` must be set — a role that
   * bound neither would accept every workload in the trust domain.
   */
  boundSpiffeIds?: string[];
  /**
   * SPIFFE ID **path** prefixes this role accepts, e.g. `/ns/prod/sa/`. Matched against the
   * path component only; the trust domain is checked separately. A prefix that does not end
   * in `/` is treated as a path-segment boundary match, so `/ns/prod` accepts
   * `/ns/prod/sa/api` but never `/ns/production/sa/api`.
   */
  boundSpiffeIdPrefixes?: string[];
  /**
   * Audiences the SVID's `aud` must include at least one of. Required: an audience-less
   * JWT-SVID can be replayed against any relying party that trusts the same bundle.
   */
  boundAudiences: string[];
  /** arc policies granted to a token minted from this role. */
  policies: string[];
  /** TTL (seconds) of the arc token minted from a successful login. Defaults to 3600. */
  tokenTtlSeconds?: number;
}

export interface SpiffePluginConfig {
  /**
   * The trust domain this method accepts, without scheme — e.g. `prod.example.com`. An SVID
   * whose SPIFFE ID belongs to any other trust domain is rejected before role matching, so a
   * bundle misconfiguration can't silently authenticate a foreign workload.
   */
  trustDomain: string;
  /**
   * Static JWKS trust bundle. Preferred for air-gapped / pinned deployments. Exactly one of
   * `trustBundle` / `bundleEndpoint` must be configured.
   */
  trustBundle?: JsonWebKeySet;
  /**
   * HTTPS endpoint publishing the trust domain's JWKS bundle (SPIFFE bundle endpoint).
   * Fetched and cached by the verifier.
   */
  bundleEndpoint?: string;
  /** Allowed clock skew (seconds) for exp/nbf/iat checks. Defaults to 60. */
  clockSkewSeconds?: number;
  roles: Record<string, SpiffeRoleConfig>;
}

/** The verified claim set of a JWT-SVID. */
export type JwtSvidClaims = Record<string, unknown>;

export interface SvidVerifyExpectations {
  /** Trust domain the SVID must belong to (no scheme). */
  trustDomain: string;
  /** The SVID's `aud` must include at least one of these. */
  audiences: string[];
  /** Allowed clock skew (seconds). */
  clockSkewSeconds: number;
  /** Static bundle, when configured. */
  trustBundle?: JsonWebKeySet;
  /** Bundle endpoint, when configured. */
  bundleEndpoint?: string;
}

/**
 * Transport + crypto boundary: verifies a JWT-SVID's signature against the trust domain
 * bundle and the standard time/audience claims, returning the decoded payload. The shipped
 * `@arc/plugin-spiffe/node` entry provides a default impl over `fetch` (bundle retrieval) +
 * `node:crypto` (RS256 / ES256), with no external dependencies. Tests inject a fake.
 *
 * The verifier MUST throw if the signature is invalid, the audience doesn't intersect, or
 * the SVID is expired / not-yet-valid. It does NOT evaluate trust-domain membership or role
 * binding — that's the plugin's job once it has a trusted payload.
 */
export interface JwtSvidVerifier {
  verify(svid: string, expected: SvidVerifyExpectations): Promise<JwtSvidClaims>;
}

/** A parsed SPIFFE ID. */
export interface SpiffeId {
  /** Full canonical id, e.g. `spiffe://prod.example.com/ns/web/sa/api`. */
  id: string;
  /** Trust domain, e.g. `prod.example.com`. */
  trustDomain: string;
  /** Path including the leading slash, e.g. `/ns/web/sa/api`. */
  path: string;
}
