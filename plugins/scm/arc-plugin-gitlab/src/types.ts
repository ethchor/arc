/**
 * Per-role config: which GitLab project to mint a project access token for, with which
 * scopes / role. Tokens are short-lived (admin sets an expires_at on creation; default
 * server policy caps at 365 days). The plugin requests fresh tokens per issue — no
 * renewal at GitLab (rotate-by-recreate).
 *
 * Mirrors the GitHub plugin's shape but the auth is simpler: GitLab project access
 * tokens are minted via a long-lived **admin PAT** rather than a per-request signed JWT.
 */
export interface GitLabRoleConfig {
  /** Project id (numeric) or URL-encoded path ("group%2Fproject"). */
  projectId: string;
  /**
   * Scopes for the issued token. The full list (read_repository, api, write_repository,
   * read_registry, write_registry, …) lives in the GitLab docs. We pass through as-is.
   */
  scopes: string[];
  /** GitLab role for the token: 10 guest / 20 reporter / 30 developer / 40 maintainer / 50 owner. */
  accessLevel: 10 | 20 | 30 | 40 | 50;
  /**
   * Optional expires_at (ISO date string). Defaults to 30 days from now when omitted,
   * matching `expires_in` on the issued lease. GitLab requires a date; this plugin always
   * sets one explicitly so the audit trail records a clear lifetime.
   */
  expiresAt?: string;
  /** Token name shown in the GitLab project UI; defaults to `arc-<role>-<counter>`. */
  namePrefix?: string;
}

export interface GitLabPluginConfig {
  /** Admin PAT with `api` scope on the target project. Stored in process memory only. */
  adminToken: string;
  /** Override for self-hosted / dedicated. Defaults to https://gitlab.com. */
  apiBaseUrl?: string;
  roles: Record<string, GitLabRoleConfig>;
}

export interface CreateProjectTokenInput {
  apiBaseUrl: string;
  adminToken: string;
  projectId: string;
  name: string;
  scopes: string[];
  accessLevel: number;
  expiresAt: string;
}

export interface CreateProjectTokenOutput {
  /** The bearer token (sent as `PRIVATE-TOKEN: <token>` to subsequent GitLab calls). */
  token: string;
  /** Seconds-until-expiration computed from the response's expires_at. */
  expirationSeconds: number;
  /** Numeric id of the created token resource — useful for revocation. */
  tokenId: number;
}

/**
 * Transport boundary between the plugin and GitLab. The shipped `@arc/plugin-gitlab/node`
 * entry implements this on global `fetch`; tests inject a fake.
 */
export interface GitLabClient {
  createProjectToken(input: CreateProjectTokenInput): Promise<CreateProjectTokenOutput>;
  /**
   * DELETE the issued token resource via the admin PAT. Best-effort — the plugin's revoke
   * surfaces errors as exceptions but doesn't retry (the next issue mints a fresh token
   * anyway; the old one expires naturally).
   */
  revokeProjectToken(input: {
    apiBaseUrl: string;
    adminToken: string;
    projectId: string;
    tokenId: number;
  }): Promise<void>;
}
