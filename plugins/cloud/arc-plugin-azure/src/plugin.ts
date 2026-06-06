import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type {
  AzurePluginConfig,
  AzureRoleConfig,
  AzureTokenClient,
} from "./types";

const PLUGIN_NAME = "arc-plugin-azure";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_LOGIN = "https://login.microsoftonline.com";

/**
 * Azure AD service-principal access tokens via the v2.0 `token` endpoint
 * (client_credentials grant). Implements `@arc/plugin-sdk`'s `SecretsPlugin`, mounted by
 * arc-server's `PluginsService` like the AWS / GCP / GitHub plugins.
 *
 * Lifecycle (mirrors the other cloud plugins):
 *  - `issue` → POST `/<tenant>/oauth2/v2.0/token` with client_credentials, returns the
 *    bearer token + AAD's expires_in as the lease TTL.
 *  - `renew` → not renewable. AAD JWTs carry their own expiration; re-issue.
 *  - `revoke` → no-op at AAD (no per-token revoke API). Drops local tracking; revoke
 *    the SP secret out-of-band for actual cred revocation.
 *
 * Security: SP client secrets are held in process memory after `configure`. Operators
 * should source them from OpenBao (Engine-A KV) at plugin mount time, not from env.
 */
export class AzureSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "Azure AD service-principal access tokens (client_credentials)",
  };

  private config: AzurePluginConfig | undefined;
  private readonly issued = new Map<string, { role: string }>();
  private counter = 0;

  constructor(private readonly aad: AzureTokenClient) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("azure plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const loginUrl = this.config.loginUrl ?? DEFAULT_LOGIN;
    const out = await this.aad.acquireToken({
      loginUrl,
      tenantId: role.tenantId,
      clientId: role.clientId,
      clientSecret: role.clientSecret,
      scope: role.scope,
    });

    const ttl =
      role.maxTtlSeconds !== undefined
        ? Math.min(out.expirationSeconds, role.maxTtlSeconds)
        : out.expirationSeconds;

    const leaseId = `${PLUGIN_NAME}/${req.role}/${++this.counter}`;
    this.issued.set(leaseId, { role: req.role });
    return {
      data: {
        access_token: out.accessToken,
        tenant_id: role.tenantId,
        client_id: role.clientId,
        scope: out.scope ?? role.scope,
      },
      leaseId,
      ttlSeconds: ttl,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    throw new Error("azure access tokens are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    // No-op at AAD; drop local tracking.
    this.issued.delete(leaseId);
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function validateConfig(raw: unknown): AzurePluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("azure plugin config must be an object");
  const obj = raw as { loginUrl?: unknown; roles?: unknown };
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("azure plugin config requires a `roles` map");
  }
  const loginUrl = obj.loginUrl === undefined ? undefined : String(obj.loginUrl);
  const roles: Record<string, AzureRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`azure plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    for (const k of ["tenantId", "clientId", "clientSecret", "scope"] as const) {
      if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
        throw new Error(`azure plugin role ${name}: ${k} is required`);
      }
    }
    const role: AzureRoleConfig = {
      tenantId: r.tenantId as string,
      clientId: r.clientId as string,
      clientSecret: r.clientSecret as string,
      scope: r.scope as string,
    };
    if (r.maxTtlSeconds !== undefined) {
      const n = Number(r.maxTtlSeconds);
      if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
        throw new Error(`azure plugin role ${name}: maxTtlSeconds must be a positive integer`);
      }
      role.maxTtlSeconds = n;
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("azure plugin config requires at least one role");
  }
  return { loginUrl, roles };
}
