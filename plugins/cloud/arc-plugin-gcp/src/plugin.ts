import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type {
  GcpPluginConfig,
  GcpRoleConfig,
  IamCredentialsClient,
} from "./types";

const PLUGIN_NAME = "arc-plugin-gcp";
const PLUGIN_VERSION = "0.0.0";

/** IAM Credentials accepts 1–43200s for lifetime; we don't second-guess GCP's clamp. */
const MIN_TTL = 1;
const MAX_TTL = 43200;

/**
 * Dynamic GCP OAuth2 access tokens via IAM Credentials `generateAccessToken`. Implements
 * `@arc/plugin-sdk`'s `SecretsPlugin`, so the plugin host mounts it at any path and the
 * existing `/v1/<mount>/creds/<role>` dispatch routes through it.
 *
 * Lifecycle semantics (matches the AWS plugin, and Vault's GCP engine for
 * `static_account`/`impersonated_account`):
 *  - `issue` → IAM Credentials generateAccessToken, returns `{access_token}` plus the
 *    server-reported seconds-until-expiration as the lease TTL.
 *  - `renew` → not renewable. Tokens carry their own expiration; re-issue to extend.
 *  - `revoke` → no-op at GCP. The IAM Credentials API doesn't support revoking
 *    individual issued tokens (revocation is a *role*-level operation via IAM policy).
 *    The plugin drops local tracking and arc-server logs the revocation for audit.
 *
 * Security invariants:
 *  - Plugin never sees Engine-B (E2E vault) key material — only the OAuth2 source it
 *    holds in its own client.
 *  - Unknown role names throw at issue time (no silent fall-through).
 *  - Caller TTL is clamped to `role.maxTtlSeconds` before the GCP request.
 */
export class GcpSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "GCP dynamic OAuth2 access tokens via IAM Credentials generateAccessToken",
  };

  private config: GcpPluginConfig | undefined;
  private readonly issued = new Map<string, { role: string }>();
  private counter = 0;

  constructor(private readonly iam: IamCredentialsClient) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("gcp plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const lifetimeSeconds = clampTtl(req.ttlSeconds, role);
    const out = await this.iam.generateAccessToken({
      targetServiceAccount: role.targetServiceAccount,
      scopes: [...role.scopes],
      lifetimeSeconds,
      delegates: role.delegates ? [...role.delegates] : [],
    });

    const leaseId = `${PLUGIN_NAME}/${req.role}/${++this.counter}`;
    this.issued.set(leaseId, { role: req.role });
    return {
      data: {
        access_token: out.accessToken,
        target_service_account: role.targetServiceAccount,
        scopes: role.scopes,
      },
      leaseId,
      ttlSeconds: out.expirationSeconds,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    throw new Error("gcp access tokens are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    // No-op at GCP. IAM Credentials has no per-token revocation; revocation is policy-level.
    this.issued.delete(leaseId);
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function validateConfig(raw: unknown): GcpPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("gcp plugin config must be an object");
  const obj = raw as { project?: unknown; roles?: unknown };
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("gcp plugin config requires a `roles` map");
  }
  const project = obj.project === undefined ? undefined : String(obj.project);
  const roles: Record<string, GcpRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`gcp plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    if (typeof r.targetServiceAccount !== "string" || r.targetServiceAccount.length === 0) {
      throw new Error(`gcp plugin role ${name}: targetServiceAccount is required`);
    }
    if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
      throw new Error(`gcp plugin role ${name}: scopes must be a non-empty array`);
    }
    const scopes = r.scopes.map((s, i) => {
      if (typeof s !== "string" || s.length === 0) {
        throw new Error(`gcp plugin role ${name}: scopes[${i}] must be a non-empty string`);
      }
      return s;
    });
    const role: GcpRoleConfig = { targetServiceAccount: r.targetServiceAccount, scopes };
    if (r.defaultTtlSeconds !== undefined) {
      role.defaultTtlSeconds = positiveInt(r.defaultTtlSeconds, `${name}.defaultTtlSeconds`);
    }
    if (r.maxTtlSeconds !== undefined) {
      role.maxTtlSeconds = positiveInt(r.maxTtlSeconds, `${name}.maxTtlSeconds`);
    }
    if (
      role.defaultTtlSeconds !== undefined &&
      role.maxTtlSeconds !== undefined &&
      role.defaultTtlSeconds > role.maxTtlSeconds
    ) {
      throw new Error(`gcp plugin role ${name}: defaultTtlSeconds > maxTtlSeconds`);
    }
    if (r.delegates !== undefined) {
      if (!Array.isArray(r.delegates)) {
        throw new Error(`gcp plugin role ${name}: delegates must be an array`);
      }
      role.delegates = r.delegates.map((d, i) => {
        if (typeof d !== "string" || d.length === 0) {
          throw new Error(`gcp plugin role ${name}: delegates[${i}] must be a non-empty string`);
        }
        return d;
      });
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("gcp plugin config requires at least one role");
  }
  return { project, roles };
}

function positiveInt(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new Error(`gcp plugin: ${label} must be a positive integer`);
  }
  return n;
}

/**
 * Pick the lifetime to request from IAM Credentials. Order of precedence:
 *  1. Caller `ttlSeconds`, capped at `role.maxTtlSeconds` if set.
 *  2. `role.defaultTtlSeconds`.
 *  3. IAM Credentials's default (~3600s) — we request 3600 explicitly so the plugin's
 *     behavior is independent of GCP's evolving defaults.
 *
 * Final value clamped to [1, 43200]; GCP may further clamp depending on org policy.
 */
export function clampTtl(requested: number | undefined, role: GcpRoleConfig): number {
  let v = requested ?? role.defaultTtlSeconds ?? 3600;
  if (role.maxTtlSeconds !== undefined) v = Math.min(v, role.maxTtlSeconds);
  if (v < MIN_TTL) v = MIN_TTL;
  if (v > MAX_TTL) v = MAX_TTL;
  return v;
}
