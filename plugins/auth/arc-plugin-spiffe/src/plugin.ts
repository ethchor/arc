import type { AuthPlugin, AuthResult, LoginRequest, PluginMeta } from "@arc/plugin-sdk";
import type {
  JwtSvidClaims,
  JwtSvidVerifier,
  SpiffeId,
  SpiffePluginConfig,
  SpiffeRoleConfig,
} from "./types";

const PLUGIN_NAME = "arc-plugin-spiffe";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_TTL = 3600;
const DEFAULT_SKEW = 60;

/**
 * SPIFFE auth method. Implements `@arc/plugin-sdk`'s `AuthPlugin`, so the plugin host mounts
 * it under `auth/<mount>/` and routes `POST /v1/auth/<mount>/login` into `login()`.
 *
 * A login carries `{ role, svid }` where `svid` is a **JWT-SVID** from the workload API. The
 * plugin verifies it against the trust domain bundle (via the injected {@link JwtSvidVerifier}),
 * confirms the SPIFFE ID belongs to the configured trust domain, enforces the role's SPIFFE-ID
 * binding, and resolves the arc policies from the role. This is the SVID→token exchange that
 * lets a workload already holding a SPIFFE identity reach arc without a second, separately
 * managed credential.
 *
 * Security invariants:
 *  - The verifier is the only thing that touches signatures/bundles; the plugin never trusts
 *    an unverified payload. Trust-domain and role binding are checked only after it returns.
 *  - **Trust domain is checked before role matching.** A bundle that (mis)verifies a foreign
 *    SVID still cannot authenticate: the `sub` must live in the configured trust domain.
 *  - Policies come from the *role* (operator-controlled), never from the SVID, so a workload
 *    can't grant itself extra policies by adding a claim.
 *  - A role must bind at least one SPIFFE ID or prefix; an unbound role would accept every
 *    workload in the trust domain, so `configure()` rejects it.
 */
export class SpiffeAuthPlugin implements AuthPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "auth",
    description: "SPIFFE JWT-SVID authentication",
  };

  private config: SpiffePluginConfig | undefined;

  constructor(private readonly verifier: JwtSvidVerifier) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async login(req: LoginRequest): Promise<AuthResult> {
    if (!this.config) throw new Error("spiffe plugin not configured; call configure() first");

    const roleName = stringCred(req.credentials, "role");
    // Accept `svid` (SPIFFE-native) or `jwt` (matches the OIDC/Kubernetes plugins' field name).
    const svid = optionalCred(req.credentials, "svid") ?? stringCred(req.credentials, "jwt");
    const role = this.config.roles[roleName];
    if (!role) throw new Error(`unknown role: ${roleName}`);

    const claims = await this.verifier.verify(svid, {
      trustDomain: this.config.trustDomain,
      audiences: role.boundAudiences,
      clockSkewSeconds: this.config.clockSkewSeconds ?? DEFAULT_SKEW,
      ...(this.config.trustBundle !== undefined ? { trustBundle: this.config.trustBundle } : {}),
      ...(this.config.bundleEndpoint !== undefined ? { bundleEndpoint: this.config.bundleEndpoint } : {}),
    });

    const sub = claims.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("spiffe: SVID has no `sub` claim");
    }
    const spiffeId = parseSpiffeId(sub);

    // Trust-domain membership first: a foreign SPIFFE ID never reaches role matching.
    if (spiffeId.trustDomain !== this.config.trustDomain) {
      throw new Error(
        `spiffe: SVID trust domain "${spiffeId.trustDomain}" is not the configured "${this.config.trustDomain}"`,
      );
    }

    assertRoleBinding(role, spiffeId, roleName);

    return {
      identityId: spiffeId.id,
      alias: spiffeId.id,
      policies: [...role.policies],
      tokenTtlSeconds: role.tokenTtlSeconds ?? DEFAULT_TTL,
      metadata: {
        role: roleName,
        trustDomain: spiffeId.trustDomain,
        spiffePath: spiffeId.path,
        ...svidMetadata(claims),
      },
    };
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

/**
 * Parse + validate a SPIFFE ID per the SPIFFE ID spec. Rejects anything that isn't a bare
 * `spiffe://<trust-domain>/<path>`: a wrong scheme, embedded credentials, a port, a query or
 * fragment, empty or dot path segments. These are rejected rather than normalized — a
 * SPIFFE ID that needs normalizing to be understood is one an attacker may have shaped to
 * read differently to two parsers.
 */
export function parseSpiffeId(value: string): SpiffeId {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`spiffe: "${value}" is not a valid URI`);
  }
  if (url.protocol !== "spiffe:") {
    throw new Error(`spiffe: "${value}" does not use the spiffe:// scheme`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`spiffe: "${value}" must not contain userinfo`);
  }
  if (url.port !== "") {
    throw new Error(`spiffe: "${value}" must not contain a port`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`spiffe: "${value}" must not contain a query or fragment`);
  }

  const trustDomain = url.hostname;
  if (trustDomain.length === 0) {
    throw new Error(`spiffe: "${value}" has an empty trust domain`);
  }
  // The spec requires a lowercase trust domain. `spiffe:` is a non-special scheme, so WHATWG
  // `URL` treats the host as opaque and does NOT lowercase it — check explicitly rather than
  // relying on the parser to have normalized.
  if (trustDomain !== trustDomain.toLowerCase()) {
    throw new Error(`spiffe: "${value}" trust domain must be lowercase`);
  }

  // Validate the path as *written*, not as the URL parser left it. WHATWG `URL` silently
  // resolves dot segments (`/ns/../admin` becomes `/admin`) and percent-decodes, so reading
  // `url.pathname` would inspect a string the issuer never signed. Requiring the raw text and
  // the parsed text to agree means anything the parser would have rewritten is rejected
  // instead of normalized.
  const rawPath = value.slice(`spiffe://${trustDomain}`.length);
  if (rawPath !== url.pathname) {
    throw new Error(`spiffe: "${value}" is not in canonical form`);
  }
  if (rawPath.includes("%")) {
    throw new Error(`spiffe: "${value}" must not percent-encode its path`);
  }
  if (rawPath.length === 0 || rawPath === "/") {
    // `spiffe://td` is the trust domain's own id, not a workload id.
    throw new Error(`spiffe: "${value}" has no workload path`);
  }
  for (const segment of rawPath.slice(1).split("/")) {
    if (segment.length === 0) throw new Error(`spiffe: "${value}" has an empty path segment`);
    if (segment === "." || segment === "..") {
      throw new Error(`spiffe: "${value}" has a relative path segment`);
    }
  }

  return { id: `spiffe://${trustDomain}${rawPath}`, trustDomain, path: rawPath };
}

/** Enforce the role's SPIFFE-ID binding against a verified, trust-domain-checked id. */
function assertRoleBinding(role: SpiffeRoleConfig, id: SpiffeId, roleName: string): void {
  if (role.boundSpiffeIds?.includes(id.id)) return;
  for (const prefix of role.boundSpiffeIdPrefixes ?? []) {
    if (matchesPathPrefix(id.path, prefix)) return;
  }
  throw new Error(`spiffe role ${roleName}: SPIFFE ID "${id.id}" is not bound to this role`);
}

/**
 * Prefix match on a path-segment boundary, so `/ns/prod` matches `/ns/prod` and
 * `/ns/prod/sa/api` but never `/ns/production/sa/api`.
 */
export function matchesPathPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (normalized.length === 0) return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

/** Surface the non-sensitive SVID claims operators expect in the audit trail. */
function svidMetadata(claims: JwtSvidClaims): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof claims.jti === "string") out.jti = claims.jti;
  if (typeof claims.exp === "number") out.svidExpiresAt = new Date(claims.exp * 1000).toISOString();
  return out;
}

function stringCred(creds: Record<string, unknown>, key: string): string {
  const v = creds[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`spiffe login requires a non-empty "${key}" credential`);
  }
  return v;
}

function optionalCred(creds: Record<string, unknown>, key: string): string | undefined {
  const v = creds[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function validateConfig(input: unknown): SpiffePluginConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("spiffe config must be an object");
  }
  const cfg = input as Record<string, unknown>;

  const trustDomain = cfg.trustDomain;
  if (typeof trustDomain !== "string" || trustDomain.length === 0) {
    throw new Error("spiffe config requires a non-empty `trustDomain`");
  }
  if (trustDomain !== trustDomain.toLowerCase()) {
    throw new Error("spiffe config `trustDomain` must be lowercase");
  }
  if (trustDomain.includes("://")) {
    throw new Error("spiffe config `trustDomain` must not include a scheme");
  }

  const hasBundle = cfg.trustBundle !== undefined;
  const hasEndpoint = cfg.bundleEndpoint !== undefined;
  if (hasBundle === hasEndpoint) {
    throw new Error("spiffe config requires exactly one of `trustBundle` or `bundleEndpoint`");
  }
  if (hasBundle) {
    const bundle = cfg.trustBundle as { keys?: unknown };
    if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.keys) || bundle.keys.length === 0) {
      throw new Error("spiffe config `trustBundle` must be a JWKS with a non-empty `keys` array");
    }
  }
  if (hasEndpoint) {
    const endpoint = cfg.bundleEndpoint;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      // A bundle fetched over plaintext is attacker-replaceable, which would let anyone mint
      // an accepted SVID.
      throw new Error("spiffe config `bundleEndpoint` must be an https:// URL");
    }
  }

  const roles = cfg.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new Error("spiffe config requires a `roles` object");
  }
  const validated: Record<string, SpiffeRoleConfig> = {};
  for (const [name, raw] of Object.entries(roles as Record<string, unknown>)) {
    validated[name] = validateRole(name, raw);
  }
  if (Object.keys(validated).length === 0) {
    throw new Error("spiffe config `roles` must declare at least one role");
  }

  return {
    trustDomain,
    roles: validated,
    ...(hasBundle ? { trustBundle: cfg.trustBundle as SpiffePluginConfig["trustBundle"] } : {}),
    ...(hasEndpoint ? { bundleEndpoint: cfg.bundleEndpoint as string } : {}),
    ...(typeof cfg.clockSkewSeconds === "number" ? { clockSkewSeconds: cfg.clockSkewSeconds } : {}),
  };
}

function validateRole(name: string, raw: unknown): SpiffeRoleConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`spiffe role ${name} must be an object`);
  }
  const r = raw as Record<string, unknown>;

  const boundAudiences = r.boundAudiences;
  if (!Array.isArray(boundAudiences) || boundAudiences.length === 0) {
    throw new Error(`spiffe role ${name} requires a non-empty \`boundAudiences\``);
  }
  const policies = r.policies;
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new Error(`spiffe role ${name} requires a non-empty \`policies\``);
  }

  const ids = r.boundSpiffeIds;
  const prefixes = r.boundSpiffeIdPrefixes;
  const hasIds = Array.isArray(ids) && ids.length > 0;
  const hasPrefixes = Array.isArray(prefixes) && prefixes.length > 0;
  if (!hasIds && !hasPrefixes) {
    throw new Error(
      `spiffe role ${name} requires \`boundSpiffeIds\` or \`boundSpiffeIdPrefixes\` — ` +
        "an unbound role would accept every workload in the trust domain",
    );
  }
  // Fail at configure time, not at first login, if an operator typo'd an id.
  if (hasIds) for (const id of ids as unknown[]) parseSpiffeId(String(id));
  if (hasPrefixes) {
    for (const p of prefixes as unknown[]) {
      if (typeof p !== "string" || !p.startsWith("/")) {
        throw new Error(`spiffe role ${name}: boundSpiffeIdPrefixes entries must be paths starting with "/"`);
      }
    }
  }

  return {
    boundAudiences: (boundAudiences as unknown[]).map(String),
    policies: (policies as unknown[]).map(String),
    ...(hasIds ? { boundSpiffeIds: (ids as unknown[]).map(String) } : {}),
    ...(hasPrefixes ? { boundSpiffeIdPrefixes: (prefixes as unknown[]).map(String) } : {}),
    ...(typeof r.tokenTtlSeconds === "number" ? { tokenTtlSeconds: r.tokenTtlSeconds } : {}),
  };
}
