import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  PluginMeta,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import type {
  BitbucketClient,
  BitbucketPluginConfig,
  BitbucketRoleConfig,
} from "./types";

const PLUGIN_NAME = "arc-plugin-bitbucket";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_API = "https://api.bitbucket.org";
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600; // 1 week — Bitbucket tokens have no native expiry

/**
 * Dynamic Bitbucket Cloud repository access tokens via the REST API. Unlike GitHub
 * installation tokens (1h embedded expiry) or GitLab project tokens (configurable
 * expires_at), Bitbucket tokens have **no native expiry**. The plugin records a
 * configurable `ttlSeconds` (default 7 days) as the lease TTL and relies on `revoke`
 * — or the lease sweep — to delete the token at the vendor.
 *
 * Lifecycle:
 *  - `issue` → POST `/repositories/:workspace/:repo/access-tokens`, returns the bearer
 *    token + uuid.
 *  - `renew` → not renewable; rotate-by-recreate.
 *  - `revoke` → DELETE `/repositories/:workspace/:repo/access-tokens/:uuid` via the
 *    admin token. Best-effort: arc's lease lookup gives us the uuid.
 */
export class BitbucketSecretsPlugin implements SecretsPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "secrets",
    description: "Bitbucket Cloud repository access tokens",
  };

  private config: BitbucketPluginConfig | undefined;
  private readonly issued = new Map<
    string,
    { workspace: string; repoSlug: string; tokenUuid: string }
  >();
  private counter = 0;

  constructor(private readonly bb: BitbucketClient) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async issue(req: IssueRequest): Promise<IssuedSecret> {
    if (!this.config) throw new Error("bitbucket plugin not configured; call configure() first");
    const role = this.config.roles[req.role];
    if (!role) throw new Error(`unknown role: ${req.role}`);

    const apiBaseUrl = this.config.apiBaseUrl ?? DEFAULT_API;
    const name = `${role.namePrefix ?? `arc-${req.role}`}-${++this.counter}`;

    const out = await this.bb.createRepoToken({
      apiBaseUrl,
      adminToken: this.config.adminToken,
      workspace: role.workspace,
      repoSlug: role.repoSlug,
      name,
      scopes: [...role.scopes],
    });

    const leaseId = `${PLUGIN_NAME}/${req.role}/${out.tokenUuid}`;
    this.issued.set(leaseId, {
      workspace: role.workspace,
      repoSlug: role.repoSlug,
      tokenUuid: out.tokenUuid,
    });
    return {
      data: {
        token: out.token,
        workspace: role.workspace,
        repo_slug: role.repoSlug,
        token_uuid: out.tokenUuid,
        scopes: role.scopes,
      },
      leaseId,
      ttlSeconds: role.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      renewable: false,
    };
  }

  async renew(_leaseId: string): Promise<LeaseInfo> {
    throw new Error("bitbucket repo tokens are not renewable; re-issue instead");
  }

  async revoke(leaseId: string): Promise<void> {
    if (!this.config) return;
    const handle = this.issued.get(leaseId);
    if (!handle) return;
    try {
      await this.bb.revokeRepoToken({
        apiBaseUrl: this.config.apiBaseUrl ?? DEFAULT_API,
        adminToken: this.config.adminToken,
        workspace: handle.workspace,
        repoSlug: handle.repoSlug,
        tokenUuid: handle.tokenUuid,
      });
    } finally {
      this.issued.delete(leaseId);
    }
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

function validateConfig(raw: unknown): BitbucketPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("bitbucket plugin config must be an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.adminToken !== "string" || obj.adminToken.length === 0) {
    throw new Error("bitbucket plugin config requires `adminToken`");
  }
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("bitbucket plugin config requires a `roles` map");
  }
  const apiBaseUrl = obj.apiBaseUrl === undefined ? undefined : String(obj.apiBaseUrl);
  const roles: Record<string, BitbucketRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") {
      throw new Error(`bitbucket plugin role ${name}: must be an object`);
    }
    const r = rawRole as Record<string, unknown>;
    for (const k of ["workspace", "repoSlug"] as const) {
      if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
        throw new Error(`bitbucket plugin role ${name}: ${k} is required`);
      }
    }
    if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
      throw new Error(`bitbucket plugin role ${name}: scopes must be a non-empty array`);
    }
    const role: BitbucketRoleConfig = {
      workspace: r.workspace as string,
      repoSlug: r.repoSlug as string,
      scopes: r.scopes.map((s, i) => {
        if (typeof s !== "string" || s.length === 0) {
          throw new Error(`bitbucket plugin role ${name}: scopes[${i}] must be a non-empty string`);
        }
        return s;
      }),
    };
    if (r.namePrefix !== undefined) role.namePrefix = String(r.namePrefix);
    if (r.ttlSeconds !== undefined) {
      const n = Number(r.ttlSeconds);
      if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
        throw new Error(`bitbucket plugin role ${name}: ttlSeconds must be a positive integer`);
      }
      role.ttlSeconds = n;
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("bitbucket plugin config requires at least one role");
  }
  return { adminToken: obj.adminToken, apiBaseUrl, roles };
}
