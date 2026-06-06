import type { AuthPlugin, AuthResult, LoginRequest, PluginMeta } from "@arc/plugin-sdk";
import type { JwtClaims, JwtVerifier, OidcPluginConfig, OidcRoleConfig } from "./types";

const PLUGIN_NAME = "arc-plugin-oidc";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_TTL = 3600;
const DEFAULT_SKEW = 60;

/**
 * OIDC / JWT auth method. Implements `@arc/plugin-sdk`'s `AuthPlugin`, so the plugin host
 * mounts it under `auth/<mount>/` and routes `POST /v1/auth/<mount>/login` into `login()`.
 *
 * A login carries `{ role, jwt }`. The plugin verifies the JWT against the configured
 * issuer's JWKS (via the injected {@link JwtVerifier}), enforces the role's bound audiences
 * and bound claims, then resolves the identity + arc policies from the role.
 *
 * Security invariants:
 *  - The verifier is the only thing that touches signatures/JWKS; the plugin never trusts an
 *    unverified payload. `boundClaims` are checked only after the verifier returns.
 *  - Policies come from the *role* (operator-controlled), never from the token itself, so a
 *    token can't grant itself extra policies by adding a claim.
 */
export class OidcAuthPlugin implements AuthPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "auth",
    description: "OIDC / JWT authentication",
  };

  private config: OidcPluginConfig | undefined;

  constructor(private readonly verifier: JwtVerifier) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async login(req: LoginRequest): Promise<AuthResult> {
    if (!this.config) throw new Error("oidc plugin not configured; call configure() first");

    const roleName = stringCred(req.credentials, "role");
    const jwt = stringCred(req.credentials, "jwt");
    const role = this.config.roles[roleName];
    if (!role) throw new Error(`unknown role: ${roleName}`);

    const claims = await this.verifier.verify(jwt, {
      issuer: this.config.boundIssuer ?? this.config.issuer,
      audiences: role.boundAudiences,
      clockSkewSeconds: this.config.clockSkewSeconds ?? DEFAULT_SKEW,
    });

    assertBoundClaims(role.boundClaims, claims, roleName);

    const userClaim = role.userClaim ?? "sub";
    const identityId = claims[userClaim];
    if (typeof identityId !== "string" || identityId.length === 0) {
      throw new Error(`oidc role ${roleName}: user claim "${userClaim}" missing or not a string`);
    }

    const metadata: Record<string, string> = { role: roleName, issuer: this.config.issuer };
    if (role.groupsClaim) {
      const groups = claims[role.groupsClaim];
      if (Array.isArray(groups)) metadata.groups = groups.map(String).join(",");
      else if (typeof groups === "string") metadata.groups = groups;
    }

    return {
      identityId,
      alias: identityId,
      policies: [...role.policies],
      tokenTtlSeconds: role.tokenTtlSeconds ?? DEFAULT_TTL,
      metadata,
    };
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function stringCred(creds: Record<string, unknown>, key: string): string {
  const v = creds[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`oidc login requires a non-empty "${key}" credential`);
  }
  return v;
}

/** Enforce exact-match (or set-intersection) constraints on the verified claims. */
function assertBoundClaims(
  bound: Record<string, string | string[]> | undefined,
  claims: JwtClaims,
  roleName: string,
): void {
  if (!bound) return;
  for (const [claim, expected] of Object.entries(bound)) {
    const actual = claims[claim];
    const expectedList = Array.isArray(expected) ? expected : [expected];
    const actualList = Array.isArray(actual) ? actual.map(String) : [String(actual)];
    if (actual === undefined || !actualList.some((a) => expectedList.includes(a))) {
      throw new Error(`oidc role ${roleName}: bound claim "${claim}" did not match`);
    }
  }
}

function validateConfig(raw: unknown): OidcPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("oidc plugin config must be an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.issuer !== "string" || obj.issuer.length === 0) {
    throw new Error("oidc plugin config requires a non-empty `issuer`");
  }
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("oidc plugin config requires a `roles` map");
  }
  const clockSkewSeconds = obj.clockSkewSeconds === undefined ? undefined : Number(obj.clockSkewSeconds);
  if (clockSkewSeconds !== undefined && (!Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0)) {
    throw new Error("oidc plugin config `clockSkewSeconds` must be a non-negative number");
  }

  const roles: Record<string, OidcRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") throw new Error(`oidc role ${name}: must be an object`);
    const r = rawRole as Record<string, unknown>;
    if (!Array.isArray(r.boundAudiences) || r.boundAudiences.length === 0) {
      throw new Error(`oidc role ${name}: requires a non-empty boundAudiences array`);
    }
    const boundAudiences = r.boundAudiences.map((a, i) => {
      if (typeof a !== "string") throw new Error(`oidc role ${name}: boundAudiences[${i}] must be a string`);
      return a;
    });
    if (!Array.isArray(r.policies) || r.policies.length === 0) {
      throw new Error(`oidc role ${name}: requires a non-empty policies array`);
    }
    const policies = r.policies.map((p, i) => {
      if (typeof p !== "string") throw new Error(`oidc role ${name}: policies[${i}] must be a string`);
      return p;
    });
    const role: OidcRoleConfig = { boundAudiences, policies };
    if (r.userClaim !== undefined) {
      if (typeof r.userClaim !== "string") throw new Error(`oidc role ${name}: userClaim must be a string`);
      role.userClaim = r.userClaim;
    }
    if (r.groupsClaim !== undefined) {
      if (typeof r.groupsClaim !== "string") throw new Error(`oidc role ${name}: groupsClaim must be a string`);
      role.groupsClaim = r.groupsClaim;
    }
    if (r.tokenTtlSeconds !== undefined) {
      const ttl = Number(r.tokenTtlSeconds);
      if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`oidc role ${name}: tokenTtlSeconds must be a positive integer`);
      role.tokenTtlSeconds = ttl;
    }
    if (r.boundClaims !== undefined) {
      if (!r.boundClaims || typeof r.boundClaims !== "object") {
        throw new Error(`oidc role ${name}: boundClaims must be an object`);
      }
      const bc: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.boundClaims as Record<string, unknown>)) {
        if (typeof v === "string") bc[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === "string")) bc[k] = v as string[];
        else throw new Error(`oidc role ${name}: boundClaims.${k} must be a string or string[]`);
      }
      role.boundClaims = bc;
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) throw new Error("oidc plugin config requires at least one role");

  return {
    issuer: obj.issuer,
    boundIssuer: obj.boundIssuer === undefined ? undefined : String(obj.boundIssuer),
    clockSkewSeconds,
    roles,
  };
}
