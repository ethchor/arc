/**
 * Config for the OIDC / JWT auth plugin. Mirrors the shape of OpenBao / Vault's `jwt` auth
 * method: a trusted issuer, and a set of named roles that bind incoming token claims to a
 * set of arc policies.
 *
 * The plugin verifies a caller-presented JWT (an OIDC ID token, a Kubernetes-projected SA
 * token from an OIDC-enabled cluster, a CI OIDC token, etc.) against the issuer's JWKS, then
 * maps it to an arc identity + policies. It never performs the interactive auth-code flow —
 * the caller brings a token it already obtained.
 */
export interface OidcRoleConfig {
  /** Audiences the token's `aud` must include at least one of. */
  boundAudiences: string[];
  /**
   * Exact-match claim constraints. Each key must be present on the token and match the
   * expected value (string) or one of the expected values (array). When the token's claim is
   * itself an array (e.g. `groups`), a non-empty intersection counts as a match.
   */
  boundClaims?: Record<string, string | string[]>;
  /** Claim to use as the stable identity id. Defaults to `sub`. */
  userClaim?: string;
  /** Optional claim carrying group memberships; surfaced in the result metadata. */
  groupsClaim?: string;
  /** arc policies granted to a token minted from this role. */
  policies: string[];
  /** TTL (seconds) of the arc token minted from a successful login. Defaults to 3600. */
  tokenTtlSeconds?: number;
}

export interface OidcPluginConfig {
  /** Trusted issuer URL (the JWT `iss` must equal this; also used for JWKS discovery). */
  issuer: string;
  /**
   * Override the value the `iss` claim is checked against, if it differs from `issuer`
   * (rare; some providers publish discovery under a different host). Defaults to `issuer`.
   */
  boundIssuer?: string;
  /** Allowed clock skew (seconds) for exp/nbf/iat checks. Defaults to 60. */
  clockSkewSeconds?: number;
  roles: Record<string, OidcRoleConfig>;
}

/** The verified claim set returned by a {@link JwtVerifier}. */
export type JwtClaims = Record<string, unknown>;

export interface VerifyExpectations {
  /** The `iss` value the token must carry. */
  issuer: string;
  /** The token's `aud` must include at least one of these. */
  audiences: string[];
  /** Allowed clock skew (seconds). */
  clockSkewSeconds: number;
}

/**
 * Transport + crypto boundary: verifies a JWT's signature against the issuer's JWKS and the
 * standard time/issuer/audience claims, returning the decoded payload. The shipped
 * `@arc/plugin-oidc/node` entry provides a default impl over `fetch` (JWKS discovery) +
 * `node:crypto` (RS256 / ES256), with no external dependencies. Tests inject a fake.
 *
 * The verifier MUST throw if the signature is invalid, the issuer doesn't match, the audience
 * doesn't intersect, or the token is expired / not-yet-valid. It does NOT evaluate
 * `boundClaims` — that's the plugin's job once it has a trusted payload.
 */
export interface JwtVerifier {
  verify(token: string, expected: VerifyExpectations): Promise<JwtClaims>;
}
