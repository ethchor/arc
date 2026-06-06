/**
 * Per-role config for the Azure plugin. The plugin mints OAuth2 access tokens via the
 * Microsoft identity platform v2.0 `token` endpoint using the **client_credentials**
 * grant — same flow `az login --service-principal` produces. Each role is an SP + scope
 * triple; the SP's client secret never leaves the plugin process.
 *
 * AAD doesn't ship a per-token revocation API: tokens are signed JWTs with embedded
 * lifetime (typically 60–90 min, capped at 24h via Conditional Access). Revocation is
 * application-level (revoke the SP, rotate the secret).
 */
export interface AzureRoleConfig {
  /** Tenant id (GUID or `<tenant>.onmicrosoft.com`). */
  tenantId: string;
  /** Application (client) id of the SP. */
  clientId: string;
  /** Client secret. Treat as a credential — store it in the infra engine. */
  clientSecret: string;
  /** OAuth2 scope, e.g. `"https://management.azure.com/.default"`. */
  scope: string;
  /** Hard arc-side cap (seconds). The token's actual lifetime is decided by AAD. */
  maxTtlSeconds?: number;
}

export interface AzurePluginConfig {
  /**
   * Optional override for the login endpoint. Defaults to the global
   * `https://login.microsoftonline.com`. Use a sovereign cloud URL for US Gov / China.
   */
  loginUrl?: string;
  roles: Record<string, AzureRoleConfig>;
}

export interface AcquireTokenInput {
  loginUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface AcquireTokenOutput {
  accessToken: string;
  /**
   * Seconds-until-expiration as reported by AAD. Surfaced as the lease TTL; the
   * LeaseManager tracks wall-clock from there.
   */
  expirationSeconds: number;
  /** Echoed scope from AAD's response; useful for auditing exact-grant. */
  scope?: string;
}

/**
 * Transport boundary between the plugin and AAD. The shipped `@arc/plugin-azure/node`
 * entry implements this on global `fetch` (no external deps). Tests inject a fake.
 */
export interface AzureTokenClient {
  acquireToken(input: AcquireTokenInput): Promise<AcquireTokenOutput>;
}
