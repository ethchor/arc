import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type {
  GitLabClient,
  GitLabPluginConfig,
  GitLabRoleConfig,
} from "./types";

const PLUGIN_NAME = "arc-plugin-gitlab";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_API = "https://gitlab.com";
const DEFAULT_TTL_SECONDS = 30 * 24 * 3600; // 30 days, matches our default expires_at

/**
 * Dynamic GitLab project access tokens via the REST API. Unlike GitHub installation
 * tokens (1h, App-JWT-authenticated), GitLab project tokens are minted via a long-lived
 * admin PAT and live as long as their explicit `expires_at`. The plugin always sets one
 * — defaulting to 30 days — so the audit trail records a clear lifetime.
 *
 * Lifecycle:
 *  - `issue` → POST `/projects/:id/access_tokens`, returns the bearer token + computed
 *    seconds-until-expiration as the lease TTL.
 *  - `renew` → not renewable; GitLab project tokens are rotate-by-recreate.
 *  - `revoke` → DELETE `/projects/:id/access_tokens/:tokenId` via the admin PAT (the
 *    arc lease lookup tells us the tokenId). Failure is logged but not retried — the
 *    token expires naturally at `expires_at` regardless.
 */
export class GitLabSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "GitLab project access tokens",
  };

  private config: GitLabPluginConfig | undefined;
  /**
   * Tracks lease → (projectId, tokenId) so `revoke` can hit the right URL without the
   * caller passing it back. Cleared on revoke.
   */
  private readonly issued = new Map<string, { projectId: string; tokenId: number }>();
  private counter = 0;

  constructor(private readonly gl: GitLabClient) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("gitlab plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const apiBaseUrl = this.config.apiBaseUrl ?? DEFAULT_API;
    const expiresAt = role.expiresAt ?? defaultExpiresAt();
    const name = `${role.namePrefix ?? `arc-${req.role}`}-${++this.counter}`;

    const out = await this.gl.createProjectToken({
      apiBaseUrl,
      adminToken: this.config.adminToken,
      projectId: role.projectId,
      name,
      scopes: [...role.scopes],
      accessLevel: role.accessLevel,
      expiresAt,
    });

    const leaseId = `${PLUGIN_NAME}/${req.role}/${out.tokenId}`;
    this.issued.set(leaseId, { projectId: role.projectId, tokenId: out.tokenId });
    return {
      data: {
        token: out.token,
        project_id: role.projectId,
        scopes: role.scopes,
        access_level: role.accessLevel,
        expires_at: expiresAt,
      },
      leaseId,
      ttlSeconds: out.expirationSeconds,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    throw new Error("gitlab project tokens are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    if (!this.config) return;
    const handle = this.issued.get(leaseId);
    if (!handle) return; // idempotent
    try {
      await this.gl.revokeProjectToken({
        apiBaseUrl: this.config.apiBaseUrl ?? DEFAULT_API,
        adminToken: this.config.adminToken,
        projectId: handle.projectId,
        tokenId: handle.tokenId,
      });
    } finally {
      this.issued.delete(leaseId);
    }
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function defaultExpiresAt(): string {
  return new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000).toISOString().slice(0, 10);
}

function validateConfig(raw: unknown): GitLabPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("gitlab plugin config must be an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.adminToken !== "string" || obj.adminToken.length === 0) {
    throw new Error("gitlab plugin config requires `adminToken`");
  }
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("gitlab plugin config requires a `roles` map");
  }
  const apiBaseUrl = obj.apiBaseUrl === undefined ? undefined : String(obj.apiBaseUrl);
  const roles: Record<string, GitLabRoleConfig> = {};
  const VALID_LEVELS = new Set([10, 20, 30, 40, 50]);
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`gitlab plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    if (typeof r.projectId !== "string" && typeof r.projectId !== "number") {
      throw new Error(`gitlab plugin role ${name}: projectId is required (string or number)`);
    }
    if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
      throw new Error(`gitlab plugin role ${name}: scopes must be a non-empty array`);
    }
    const scopes = r.scopes.map((s, i) => {
      if (typeof s !== "string" || s.length === 0) {
        throw new Error(`gitlab plugin role ${name}: scopes[${i}] must be a non-empty string`);
      }
      return s;
    });
    if (typeof r.accessLevel !== "number" || !VALID_LEVELS.has(r.accessLevel)) {
      throw new Error(`gitlab plugin role ${name}: accessLevel must be 10|20|30|40|50`);
    }
    const role: GitLabRoleConfig = {
      projectId: String(r.projectId),
      scopes,
      accessLevel: r.accessLevel as GitLabRoleConfig["accessLevel"],
    };
    if (r.expiresAt !== undefined) role.expiresAt = String(r.expiresAt);
    if (r.namePrefix !== undefined) role.namePrefix = String(r.namePrefix);
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("gitlab plugin config requires at least one role");
  }
  return { adminToken: obj.adminToken, apiBaseUrl, roles };
}
