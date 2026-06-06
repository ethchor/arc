/**
 * Default {@link TokenReviewer} backed by Node's global `fetch` — POSTs a `TokenReview` to
 * the cluster's `authentication.k8s.io/v1` API. No external dependencies.
 *
 * Lives behind the `@arc/plugin-kubernetes/node` subpath so callers that already have a
 * Kubernetes client (or need mTLS / a custom dispatcher) can inject their own reviewer and
 * skip this file. For the common in-cluster case, trust the API server's CA by pointing
 * `NODE_EXTRA_CA_CERTS` at `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` (or
 * inject a `fetchFn` with a custom dispatcher) — the default global `fetch` uses the process
 * trust store.
 */
import type { TokenReviewResult, TokenReviewer } from "./types";

export interface CreateNodeReviewerOptions {
  /** Kubernetes API base, e.g. "https://kubernetes.default.svc". */
  host: string;
  /** Bearer token with `create` permission on `tokenreviews` (a reviewer ServiceAccount). */
  reviewerJwt: string;
  /** Injectable fetch for tests / a custom dispatcher (mTLS, cluster CA). */
  fetchFn?: typeof fetch;
}

export function createNodeTokenReviewer(opts: CreateNodeReviewerOptions): TokenReviewer {
  const base = opts.host.replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
  const url = `${base}/apis/authentication.k8s.io/v1/tokenreviews`;

  return {
    async review(token: string, audiences?: string[]): Promise<TokenReviewResult> {
      const spec: Record<string, unknown> = { token };
      if (audiences && audiences.length > 0) spec.audiences = audiences;

      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.reviewerJwt}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", spec }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`kubernetes TokenReview failed (${res.status}): ${text}`);
      }

      const parsed = (await res.json()) as {
        status?: {
          authenticated?: boolean;
          user?: { username?: string; uid?: string; groups?: string[] };
          error?: string;
        };
      };
      const status = parsed.status ?? {};
      const result: TokenReviewResult = { authenticated: status.authenticated === true };
      if (status.user?.username) result.username = status.user.username;
      if (status.user?.uid) result.uid = status.user.uid;
      if (status.user?.groups) result.groups = status.user.groups;
      if (status.error) result.error = status.error;
      return result;
    },
  };
}
