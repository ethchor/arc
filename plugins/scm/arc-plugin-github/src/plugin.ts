import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type {
  GitHubAppClient,
  GitHubPluginConfig,
  GitHubRoleConfig,
} from "./types";

const PLUGIN_NAME = "arc-plugin-github";
const PLUGIN_VERSION = "0.0.0";

/**
 * Dynamic GitHub App installation tokens via the REST API. Implements `@arc/plugin-sdk`'s
 * `SecretsPlugin`, so the plugin host mounts it like any other secrets engine.
 *
 * Lifecycle semantics (matches AWS / GCP plugins):
 *  - `issue` → POST `/app/installations/{installationId}/access_tokens`. Returns the
 *    Bearer token + GitHub's reported expiration (always ~3600s) as the lease TTL.
 *  - `renew` → not renewable. Installation tokens carry a fixed 1h expiry; re-issue.
 *  - `revoke` → DELETE `/installation/token` would revoke this token early *if* called
 *    with the token itself as the Bearer. arc treats revoke as a no-op for two reasons:
 *    (1) the token is the secret; calling the DELETE endpoint with it would expose it back
 *    through the audit; (2) GitHub tokens auto-expire fast enough that early revocation
 *    is rarely worth the round-trip. The plugin drops local tracking; arc audit records
 *    the revoke.
 *
 * Security invariants:
 *  - Plugin holds the App's private key in process memory after `configure`. That key is
 *    not the Engine-B master key — arc-server is the trust boundary for plugin secrets, and
 *    operators are expected to store the App key in OpenBao (Engine-A) and inject it at
 *    plugin mount time.
 *  - Unknown role names throw at issue time. Caller-overridden repositories / permissions
 *    require a future config flag to permit; today the role config wins.
 */
export class GitHubAppPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "GitHub App installation tokens",
  };

  private config: GitHubPluginConfig | undefined;
  private readonly issued = new Map<string, { role: string }>();
  private counter = 0;

  constructor(private readonly gh: GitHubAppClient) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("github plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const out = await this.gh.createInstallationToken({
      installationId: role.installationId,
      ...(role.repositories ? { repositories: [...role.repositories] } : {}),
      ...(role.repositoryIds ? { repositoryIds: [...role.repositoryIds] } : {}),
      ...(role.permissions ? { permissions: { ...role.permissions } } : {}),
    });

    const leaseId = `${PLUGIN_NAME}/${req.role}/${++this.counter}`;
    this.issued.set(leaseId, { role: req.role });
    const data: Record<string, unknown> = {
      token: out.token,
      installation_id: role.installationId,
    };
    if (out.permissions) data.permissions = out.permissions;
    if (out.repositorySelection) data.repository_selection = out.repositorySelection;
    return {
      data,
      leaseId,
      ttlSeconds: out.expirationSeconds,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    throw new Error("github installation tokens are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    // No-op at GitHub. See class doc for rationale.
    this.issued.delete(leaseId);
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function validateConfig(raw: unknown): GitHubPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("github plugin config must be an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.appId !== "number" || !Number.isInteger(obj.appId) || obj.appId <= 0) {
    throw new Error("github plugin config requires a positive integer `appId`");
  }
  if (typeof obj.privateKeyPem !== "string" || obj.privateKeyPem.length === 0) {
    throw new Error("github plugin config requires `privateKeyPem`");
  }
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("github plugin config requires a `roles` map");
  }
  const apiBaseUrl = obj.apiBaseUrl === undefined ? undefined : String(obj.apiBaseUrl);
  const roles: Record<string, GitHubRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`github plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    if (typeof r.installationId !== "number" || r.installationId <= 0) {
      throw new Error(`github plugin role ${name}: positive integer installationId required`);
    }
    const role: GitHubRoleConfig = { installationId: r.installationId };
    if (r.repositories !== undefined) {
      if (!Array.isArray(r.repositories)) {
        throw new Error(`github plugin role ${name}: repositories must be an array`);
      }
      role.repositories = r.repositories.map((s, i) => {
        if (typeof s !== "string") throw new Error(`role ${name}: repositories[${i}] must be a string`);
        return s;
      });
    }
    if (r.repositoryIds !== undefined) {
      if (!Array.isArray(r.repositoryIds)) {
        throw new Error(`github plugin role ${name}: repositoryIds must be an array`);
      }
      role.repositoryIds = r.repositoryIds.map((n, i) => {
        if (typeof n !== "number") throw new Error(`role ${name}: repositoryIds[${i}] must be a number`);
        return n;
      });
    }
    if (r.permissions !== undefined) {
      if (!r.permissions || typeof r.permissions !== "object") {
        throw new Error(`github plugin role ${name}: permissions must be an object`);
      }
      const perms: Record<string, "read" | "write" | "admin"> = {};
      for (const [k, v] of Object.entries(r.permissions as Record<string, unknown>)) {
        if (v !== "read" && v !== "write" && v !== "admin") {
          throw new Error(`role ${name}: permissions.${k} must be read|write|admin`);
        }
        perms[k] = v;
      }
      role.permissions = perms;
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("github plugin config requires at least one role");
  }
  return { appId: obj.appId, privateKeyPem: obj.privateKeyPem, apiBaseUrl, roles };
}
