/**
 * IamCredentialsClient implementation backed by `google-auth-library`. Lives behind the
 * `@arc/plugin-gcp/google-auth-library` subpath so callers that inject their own client
 * (tests, GCE metadata server, GKE Workload Identity) don't pay for the import.
 *
 * The `GoogleAuth` client transparently picks credentials from ADC: env var
 * GOOGLE_APPLICATION_CREDENTIALS, gcloud user creds, GCE/GKE metadata. That's the
 * idiomatic GCP pattern and lets the plugin run unmodified in Workload Identity-backed
 * Kubernetes deploys.
 */
import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";
import type {
  GenerateAccessTokenInput,
  GenerateAccessTokenOutput,
  IamCredentialsClient,
} from "./types";

const IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";

export interface CreateGoogleAuthClientOptions extends GoogleAuthOptions {
  /** Override IAM Credentials endpoint (regional / custom audit setups). */
  endpoint?: string;
}

/**
 * Build an `IamCredentialsClient` using `google-auth-library` for token sourcing. Pass any
 * `GoogleAuthOptions` (credentials, keyFile, projectId, scopes for the *caller* SA, etc).
 * The returned object plugs directly into `new GcpSecretsPlugin(client)`.
 */
export function createGoogleAuthClient(
  opts: CreateGoogleAuthClientOptions = {},
): IamCredentialsClient {
  const { endpoint = IAM_CREDENTIALS_BASE, ...authOpts } = opts;
  // Caller SA needs `iam.serviceAccountTokenCreator` on the target SA at minimum; we ask
  // for the cloud-platform scope so the auth client can mint Bearer tokens for IAM Cred.
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    ...authOpts,
  });

  return {
    async generateAccessToken(input: GenerateAccessTokenInput): Promise<GenerateAccessTokenOutput> {
      const client = await auth.getClient();
      const url = `${endpoint}/projects/-/serviceAccounts/${encodeURIComponent(input.targetServiceAccount)}:generateAccessToken`;
      // IAM Credentials wants lifetime as a duration string ("3600s").
      const res = await client.request<{
        accessToken?: string;
        expireTime?: string;
      }>({
        url,
        method: "POST",
        data: {
          scope: input.scopes,
          lifetime: `${input.lifetimeSeconds}s`,
          ...(input.delegates.length > 0 ? { delegates: input.delegates } : {}),
        },
      });
      const body = res.data ?? {};
      if (!body.accessToken || !body.expireTime) {
        throw new Error("IAM Credentials generateAccessToken returned no token");
      }
      const expirationSeconds = Math.max(
        0,
        Math.floor((Date.parse(body.expireTime) - Date.now()) / 1000),
      );
      return { accessToken: body.accessToken, expirationSeconds };
    },
  };
}
