import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type { AwsPluginConfig, AwsRoleConfig, StsClient } from "./types";

const PLUGIN_NAME = "arc-plugin-aws";
const PLUGIN_VERSION = "0.0.0";

/** STS hard minimum is 900s (15m); maximum is 43200s (12h) gated by role config. */
const STS_MIN_TTL = 900;
const STS_MAX_TTL = 43200;

/**
 * Dynamic IAM credentials via STS AssumeRole. Implements `@arc/plugin-sdk`'s `SecretsPlugin`,
 * so the plugin host (`apps/arc-server/src/plugins/`) can mount it at any path and the
 * existing `/v1/<mount>/creds/<role>` dispatch routes through it like any other
 * DynamicSecretsEngine.
 *
 * Lifecycle semantics, matching Vault's `aws` engine for `assumed_role`:
 *  - `issue` → STS AssumeRole, returns `{accessKeyId, secretAccessKey, sessionToken}` plus
 *    the seconds-until-expiration as the lease TTL.
 *  - `renew` → not renewable. STS-issued credentials carry their own expiration; the only
 *    way to "renew" is to mint a fresh set. Surfaces as `LeaseError("not_renewable")` upstream.
 *  - `revoke` → no-op at the AWS side. STS credentials cannot be force-expired short of
 *    attaching a Deny policy to the assumed role (heavyweight, irreversible at the role
 *    level). The plugin still surfaces revocation locally so the LeaseManager removes its
 *    arc-side tracking; arc-server's audit log records that the lease was revoked even
 *    though the underlying credentials remain valid until natural expiry.
 *
 * Security invariants:
 *  - The plugin never sees Engine-B (E2E vault) key material — only the AWS credentials it
 *    receives via `configure`.
 *  - Unknown role names throw at issue time (no silent fall-through to a default role).
 *  - TTL is clamped to the role's `maxTtlSeconds` *before* the STS request, so callers
 *    can't request more than the operator allows even if the IAM role would permit it.
 */
export class AwsSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "AWS dynamic IAM credentials via STS AssumeRole",
  };

  private config: AwsPluginConfig | undefined;
  /** Subset of issued credentials we still know about — used by `revoke` for symmetry. */
  private readonly issued = new Map<string, { role: string; assumedRoleArn?: string }>();
  private counter = 0;

  constructor(private readonly sts: StsClient) {}

  /** Replaces the entire config. Throws if `roles` is empty or malformed. */
  async configure(input: unknown): Promise<void> {
    const cfg = validateConfig(input);
    this.config = cfg;
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("aws plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const durationSeconds = clampTtl(req.ttlSeconds, role);
    const sessionName = role.sessionName ?? `arc-${req.role}-${++this.counter}`;
    const out = await this.sts.assumeRole({
      roleArn: role.roleArn,
      sessionName,
      durationSeconds,
      externalId: role.externalId,
    });

    const leaseId = `${PLUGIN_NAME}/${req.role}/${sessionName}`;
    this.issued.set(leaseId, { role: req.role, assumedRoleArn: out.assumedRoleArn });
    return {
      data: {
        access_key: out.accessKeyId,
        secret_key: out.secretAccessKey,
        session_token: out.sessionToken,
        ...(out.assumedRoleArn ? { assumed_role_arn: out.assumedRoleArn } : {}),
      },
      leaseId,
      ttlSeconds: out.expirationSeconds,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    // STS credentials are not renewable. Surfacing as an exception so the LeaseManager
    // returns a clean 400 with `not_renewable` rather than silently extending an arc-side
    // lease while the underlying creds quietly expire.
    throw new Error("aws/sts credentials are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    // No-op at AWS. Drop the local tracking so issued.size stays bounded; the LeaseManager
    // is the source of truth for the lease's revoked state.
    this.issued.delete(leaseId);
  }

  // -- introspection helpers used by tests + future admin UIs --------------

  /** Roles currently configured. Empty before `configure()` runs. */
  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function validateConfig(raw: unknown): AwsPluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("aws plugin config must be an object");
  }
  const obj = raw as { region?: unknown; roles?: unknown };
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("aws plugin config requires a `roles` map");
  }
  const region = obj.region === undefined ? undefined : String(obj.region);
  const roles: Record<string, AwsRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`aws plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    if (typeof r.roleArn !== "string" || r.roleArn.length === 0) {
      throw new Error(`aws plugin role ${name}: roleArn is required`);
    }
    const role: AwsRoleConfig = { roleArn: r.roleArn };
    if (r.sessionName !== undefined) role.sessionName = String(r.sessionName);
    if (r.externalId !== undefined) role.externalId = String(r.externalId);
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
      throw new Error(`aws plugin role ${name}: defaultTtlSeconds > maxTtlSeconds`);
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("aws plugin config requires at least one role");
  }
  return { region, roles };
}

function positiveInt(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    throw new Error(`aws plugin: ${label} must be a positive integer`);
  }
  return n;
}

/**
 * Pick the TTL we'll ask STS for. Order of precedence:
 *  1. Caller-supplied `ttlSeconds`, capped at `maxTtlSeconds` if the role sets one.
 *  2. `defaultTtlSeconds` from the role config.
 *  3. STS's lower bound (900s) as a final fallback so the request is at least valid.
 *
 * The final value is clamped into STS's [900, 43200] range; STS will further clamp to the
 * role's `MaxSessionDuration` at its end (we don't know that without an IAM read), so a
 * 12h request against a 1h role will come back as a 1h lease — the plugin surfaces what
 * STS returned, not what was asked for.
 */
export function clampTtl(requested: number | undefined, role: AwsRoleConfig): number {
  let v = requested ?? role.defaultTtlSeconds ?? STS_MIN_TTL;
  if (role.maxTtlSeconds !== undefined) v = Math.min(v, role.maxTtlSeconds);
  if (v < STS_MIN_TTL) v = STS_MIN_TTL;
  if (v > STS_MAX_TTL) v = STS_MAX_TTL;
  return v;
}
