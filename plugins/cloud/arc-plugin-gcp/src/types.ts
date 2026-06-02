/**
 * Per-role config: which service account to impersonate, the OAuth2 scopes the issued
 * token is good for, the requested lifetime, and any short-lived delegate chain (rarely
 * needed in practice — only when crossing project trust boundaries).
 *
 * The IAM Credentials API caps lifetime at 12h *if* the org policy
 * `constraints/iam.allowServiceAccountCredentialLifetimeExtension` is set; otherwise the
 * hard cap is 1h. We don't enforce that here — let GCP push back, and surface the actual
 * expiration in the lease.
 */
export interface GcpRoleConfig {
  /** Target SA email — `arn-equivalent`: "<sa-name>@<project>.iam.gserviceaccount.com". */
  targetServiceAccount: string;
  /** OAuth2 scopes to bind to the issued token, e.g. ["https://www.googleapis.com/auth/cloud-platform"]. */
  scopes: string[];
  /** Default requested lifetime in seconds (1–43200). Falls back to the IAM API's default (1h) if unset. */
  defaultTtlSeconds?: number;
  /** Hard arc-side cap applied *before* the IAM Credentials request. */
  maxTtlSeconds?: number;
  /** Optional delegate chain (SAs the caller can impersonate to reach the target). */
  delegates?: string[];
}

export interface GcpPluginConfig {
  /** Optional project hint; logged in the plugin but not used in the request URL (the API uses `-`). */
  project?: string;
  roles: Record<string, GcpRoleConfig>;
}

export interface GenerateAccessTokenInput {
  /** Target SA email. */
  targetServiceAccount: string;
  /** OAuth2 scopes (full URLs). */
  scopes: string[];
  /** Requested lifetime in seconds. May be capped server-side. */
  lifetimeSeconds: number;
  /** Delegate chain (SAs to traverse). Empty when impersonating directly. */
  delegates: string[];
}

export interface GenerateAccessTokenOutput {
  /** Bearer access token, opaque to the plugin. */
  accessToken: string;
  /**
   * Seconds-until-expiration at the time the response was received. The plugin surfaces
   * this as the lease TTL; LeaseManager tracks the wall clock from there.
   */
  expirationSeconds: number;
}

/**
 * Transport boundary between the plugin and GCP's IAM Credentials API. The shipped
 * `@arc/plugin-gcp/google-auth-library` entry implements this via `google-auth-library`'s
 * `GoogleAuth` client; tests inject a fake. Anyone with a metadata-server credential
 * source (GCE / GKE Workload Identity / Cloud Run) implements this and passes it to
 * `new GcpSecretsPlugin(client)`.
 */
export interface IamCredentialsClient {
  generateAccessToken(input: GenerateAccessTokenInput): Promise<GenerateAccessTokenOutput>;
}
