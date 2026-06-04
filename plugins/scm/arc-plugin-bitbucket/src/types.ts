/**
 * Per-role config. Bitbucket Cloud's repository access tokens are minted via the
 * `/repositories/{workspace}/{repo_slug}/access-tokens` endpoint, authenticated with an
 * admin access token (workspace-level) that has `read:repository` + `admin:repository`
 * scopes. Tokens are long-lived (no built-in expiry) — admins MUST rotate by deleting
 * + recreating; arc's `revoke` does that automatically.
 */
export interface BitbucketRoleConfig {
  /** Workspace slug, e.g. "acme". */
  workspace: string;
  /** Repository slug, e.g. "platform". */
  repoSlug: string;
  /** Bitbucket scope list, e.g. ["repository:read", "pullrequest:write"]. */
  scopes: string[];
  /** Token name shown in the Bitbucket UI; defaults to `arc-<role>-<counter>`. */
  namePrefix?: string;
  /**
   * arc-side TTL ceiling. Bitbucket tokens have no native expiry, so we record this as
   * the lease ttl and rely on `revoke` (or natural lease sweep) to clean them up.
   */
  ttlSeconds?: number;
}

export interface BitbucketPluginConfig {
  /** Admin access token with workspace-level admin:repository. */
  adminToken: string;
  /** Override for Bitbucket Data Center / Server. Defaults to https://api.bitbucket.org. */
  apiBaseUrl?: string;
  roles: Record<string, BitbucketRoleConfig>;
}

export interface CreateRepoTokenInput {
  apiBaseUrl: string;
  adminToken: string;
  workspace: string;
  repoSlug: string;
  name: string;
  scopes: string[];
}

export interface CreateRepoTokenOutput {
  /** Bearer token; sent as `Authorization: Bearer <token>` to subsequent calls. */
  token: string;
  /** Token uuid — needed to revoke later. */
  tokenUuid: string;
}

export interface BitbucketClient {
  createRepoToken(input: CreateRepoTokenInput): Promise<CreateRepoTokenOutput>;
  revokeRepoToken(input: {
    apiBaseUrl: string;
    adminToken: string;
    workspace: string;
    repoSlug: string;
    tokenUuid: string;
  }): Promise<void>;
}
