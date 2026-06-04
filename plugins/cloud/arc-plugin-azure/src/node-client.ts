/**
 * Default {@link AzureTokenClient} using global `fetch` only — no external deps. Lives
 * behind the `@arc/plugin-azure/node` subpath so callers injecting their own client
 * (custom HTTP stack, MSAL-backed, IMDS-backed) skip this file entirely.
 *
 * Form-encodes the request body per RFC 6749 §4.4 (client_credentials). AAD rejects
 * application/json bodies for the token endpoint.
 */
import type {
  AcquireTokenInput,
  AcquireTokenOutput,
  AzureTokenClient,
} from "./types";

export interface CreateNodeAzureClientOptions {
  /** Injectable fetch for tests / custom request handlers. */
  fetchFn?: typeof fetch;
}

export function createNodeAzureClient(opts: CreateNodeAzureClientOptions = {}): AzureTokenClient {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
  return {
    async acquireToken(input: AcquireTokenInput): Promise<AcquireTokenOutput> {
      const url = `${input.loginUrl.replace(/\/+$/, "")}/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        scope: input.scope,
      });
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Azure AAD token request failed (${res.status}): ${text}`);
      }
      const parsed = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!parsed.access_token || typeof parsed.expires_in !== "number") {
        throw new Error("Azure AAD token response missing access_token / expires_in");
      }
      const out: AcquireTokenOutput = {
        accessToken: parsed.access_token,
        expirationSeconds: parsed.expires_in,
      };
      if (parsed.scope) out.scope = parsed.scope;
      return out;
    },
  };
}
