/**
 * Default GitHubAppClient backed by Node built-ins: `node:crypto` for RS256 JWT signing
 * (the App-level JWT the installation-token call uses for auth) + global `fetch` for the
 * REST request. No external dependencies — the GitHub App auth dance is small enough that
 * pulling in `@octokit/auth-app` (or octokit itself) would be more weight than it's worth
 * just for this one endpoint.
 *
 * Lives behind the `@arc/plugin-github/node` subpath so callers that inject their own
 * client (tests; or an octokit-backed impl if they're already using it) skip this file
 * entirely. Browsers / Deno consumers should not import this — write a WebCrypto-based
 * client and inject it.
 */
import { createPrivateKey, createSign } from "node:crypto";
import type {
  CreateInstallationTokenInput,
  CreateInstallationTokenOutput,
  GitHubAppClient,
} from "./types";

const DEFAULT_BASE = "https://api.github.com";

export interface CreateNodeClientOptions {
  appId: number;
  privateKeyPem: string;
  /** Override for GHES. Defaults to https://api.github.com. */
  apiBaseUrl?: string;
  /** Injectable fetch for tests / custom request handlers (proxies, etc). */
  fetchFn?: typeof fetch;
}

/**
 * Build a GitHubAppClient using node:crypto for the App JWT + fetch for the REST call.
 * The App JWT is minted per request (10-minute validity is GitHub's recommendation; we
 * use 9 to stay within clock skew) and used as the `Authorization: Bearer <jwt>` against
 * `/app/installations/<id>/access_tokens`.
 */
export function createNodeGitHubClient(opts: CreateNodeClientOptions): GitHubAppClient {
  const base = opts.apiBaseUrl ?? DEFAULT_BASE;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
  const keyObject = createPrivateKey({ key: opts.privateKeyPem, format: "pem" });

  return {
    async createInstallationToken(
      input: CreateInstallationTokenInput,
    ): Promise<CreateInstallationTokenOutput> {
      const jwt = signAppJwt(opts.appId, keyObject);
      const url = `${base.replace(/\/+$/, "")}/app/installations/${input.installationId}/access_tokens`;
      const body: Record<string, unknown> = {};
      if (input.repositories) body.repositories = input.repositories;
      if (input.repositoryIds) body.repository_ids = input.repositoryIds;
      if (input.permissions) body.permissions = input.permissions;

      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "arc-plugin-github",
        },
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitHub installation-token request failed (${res.status}): ${text}`);
      }
      const parsed = (await res.json()) as {
        token?: string;
        expires_at?: string;
        permissions?: Record<string, string>;
        repository_selection?: "all" | "selected";
      };
      if (!parsed.token || !parsed.expires_at) {
        throw new Error("GitHub installation-token response missing token / expires_at");
      }
      const expirationSeconds = Math.max(
        0,
        Math.floor((Date.parse(parsed.expires_at) - Date.now()) / 1000),
      );
      const out: CreateInstallationTokenOutput = { token: parsed.token, expirationSeconds };
      if (parsed.permissions) out.permissions = parsed.permissions;
      if (parsed.repository_selection) out.repositorySelection = parsed.repository_selection;
      return out;
    },
  };
}

/**
 * Build + sign the App-level JWT GitHub requires for the installation-token request.
 * Header `{alg: "RS256", typ: "JWT"}`, payload `{iat, exp, iss: <appId>}`. Signed with
 * RSASSA-PKCS1-v1_5 over SHA-256 using the App's private key. Returns the base64url-encoded
 * JWT compact serialization.
 */
function signAppJwt(appId: number, key: ReturnType<typeof createPrivateKey>): string {
  const now = Math.floor(Date.now() / 1000);
  // GitHub recommends 10 min; clock skew makes 9 min safer (and they also reject `iat` in
  // the future by even a second, so backdate by 30s).
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now + 540, iss: appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);
  return `${signingInput}.${b64urlBytes(signature)}`;
}

function b64url(s: string): string {
  return b64urlBytes(Buffer.from(s, "utf8"));
}

function b64urlBytes(b: Buffer): string {
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
