/**
 * Default {@link GitLabClient} using global `fetch` only. No external deps. Lives behind
 * `@arc/plugin-gitlab/node` so callers injecting their own client (custom HTTP, retry
 * wrappers, an existing `@gitbeaker/rest` instance) skip this file.
 */
import type {
  CreateProjectTokenInput,
  CreateProjectTokenOutput,
  GitLabClient,
} from "./types";

export interface CreateNodeGitLabClientOptions {
  fetchFn?: typeof fetch;
}

export function createNodeGitLabClient(opts: CreateNodeGitLabClientOptions = {}): GitLabClient {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
  return {
    async createProjectToken(input: CreateProjectTokenInput): Promise<CreateProjectTokenOutput> {
      const url = `${input.apiBaseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(input.projectId)}/access_tokens`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": input.adminToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: input.name,
          scopes: input.scopes,
          access_level: input.accessLevel,
          expires_at: input.expiresAt,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitLab create-access-token failed (${res.status}): ${text}`);
      }
      const parsed = (await res.json()) as {
        id?: number;
        token?: string;
        expires_at?: string;
      };
      if (!parsed.token || typeof parsed.id !== "number" || !parsed.expires_at) {
        throw new Error("GitLab access-token response missing token / id / expires_at");
      }
      const expirationSeconds = Math.max(
        0,
        Math.floor((Date.parse(parsed.expires_at) - Date.now()) / 1000),
      );
      return { token: parsed.token, expirationSeconds, tokenId: parsed.id };
    },

    async revokeProjectToken(input): Promise<void> {
      const url = `${input.apiBaseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(input.projectId)}/access_tokens/${input.tokenId}`;
      const res = await fetchFn(url, {
        method: "DELETE",
        headers: { "PRIVATE-TOKEN": input.adminToken },
      });
      // 204 No Content on success; 404 means the token's already gone (which is fine).
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitLab revoke-access-token failed (${res.status}): ${text}`);
      }
    },
  };
}
