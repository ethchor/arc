/**
 * Default {@link BitbucketClient} using global `fetch`. No external deps. Lives behind
 * `@arc/plugin-bitbucket/node` so callers injecting their own client skip this file.
 */
import type {
  BitbucketClient,
  CreateRepoTokenInput,
  CreateRepoTokenOutput,
} from "./types";

export interface CreateNodeBitbucketClientOptions {
  fetchFn?: typeof fetch;
}

export function createNodeBitbucketClient(opts: CreateNodeBitbucketClientOptions = {}): BitbucketClient {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
  return {
    async createRepoToken(input: CreateRepoTokenInput): Promise<CreateRepoTokenOutput> {
      const url = `${input.apiBaseUrl.replace(/\/+$/, "")}/2.0/repositories/${encodeURIComponent(input.workspace)}/${encodeURIComponent(input.repoSlug)}/access-tokens`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.adminToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ name: input.name, scopes: input.scopes }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Bitbucket create-access-token failed (${res.status}): ${text}`);
      }
      const parsed = (await res.json()) as { uuid?: string; token?: string };
      if (!parsed.uuid || !parsed.token) {
        throw new Error("Bitbucket access-token response missing uuid / token");
      }
      return { token: parsed.token, tokenUuid: parsed.uuid };
    },

    async revokeRepoToken(input): Promise<void> {
      const url = `${input.apiBaseUrl.replace(/\/+$/, "")}/2.0/repositories/${encodeURIComponent(input.workspace)}/${encodeURIComponent(input.repoSlug)}/access-tokens/${encodeURIComponent(input.tokenUuid)}`;
      const res = await fetchFn(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${input.adminToken}` },
      });
      // 204 on success; 404 means already gone.
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`Bitbucket revoke-access-token failed (${res.status}): ${text}`);
      }
    },
  };
}
