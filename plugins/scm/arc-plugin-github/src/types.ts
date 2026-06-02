/**
 * Per-role config: which GitHub App installation to mint a token for. A GitHub App has a
 * single private key + App ID; each tenant install has a unique `installationId`. A
 * realistic arc deployment has one app talking to many installs (one per repo owner), so
 * the `role` name is the operator's handle for "the install on org X".
 *
 * Optional `repositories` / `permissions` narrow the resulting token's scope — GitHub
 * supports both per-token and pre-configured at install time.
 */
export interface GitHubRoleConfig {
  installationId: number;
  /** Repositories the token is good for (full-name format "owner/repo"). Omit for all installed repos. */
  repositories?: string[];
  /** Repo IDs (alternative to names). GitHub accepts either; arc just passes through. */
  repositoryIds?: number[];
  /** Permission subset; omit to inherit the install's full permission grant. */
  permissions?: Record<string, "read" | "write" | "admin">;
}

export interface GitHubPluginConfig {
  /** The GitHub App's numeric App ID. */
  appId: number;
  /** PEM-encoded private key (PKCS#1 or PKCS#8). Used to sign the App-level JWT. */
  privateKeyPem: string;
  /** Optional API base for GHES installs. Defaults to https://api.github.com. */
  apiBaseUrl?: string;
  roles: Record<string, GitHubRoleConfig>;
}

export interface CreateInstallationTokenInput {
  installationId: number;
  repositories?: string[];
  repositoryIds?: number[];
  permissions?: Record<string, "read" | "write" | "admin">;
}

export interface CreateInstallationTokenOutput {
  /** The Bearer token to send as `Authorization: token <…>` against the GitHub REST/GraphQL API. */
  token: string;
  /**
   * Seconds-until-expiration at the time the response was received. GitHub installation
   * tokens are 1h (3600s) and not renewable.
   */
  expirationSeconds: number;
  /** Optional permissions echo from GitHub's response. Surfaced through to the lease data. */
  permissions?: Record<string, string>;
  /** Optional repository selection echo. */
  repositorySelection?: "all" | "selected";
}

/**
 * Transport boundary between the plugin and GitHub's REST API. The shipped
 * `@arc/plugin-github/node` entry provides a default impl built on Node's `crypto` + global
 * `fetch` (no external deps). Tests inject a fake.
 */
export interface GitHubAppClient {
  createInstallationToken(input: CreateInstallationTokenInput): Promise<CreateInstallationTokenOutput>;
}
