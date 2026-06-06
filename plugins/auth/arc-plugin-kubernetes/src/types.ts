/**
 * Config for the Kubernetes auth plugin. Mirrors OpenBao / Vault's `kubernetes` auth method:
 * a caller (typically a pod) presents its projected ServiceAccount token, the plugin verifies
 * it via the cluster's TokenReview API, and a matching role maps the (namespace, service
 * account) pair to a set of arc policies.
 *
 * Connection details (API host, reviewer token, cluster CA) live with the injected
 * {@link TokenReviewer}, not here — this config is purely the role → policy binding.
 */
export interface KubernetesRoleConfig {
  /** ServiceAccount names allowed by this role. Use `["*"]` to allow any. */
  boundServiceAccountNames: string[];
  /** Namespaces allowed by this role. Use `["*"]` to allow any. */
  boundNamespaces: string[];
  /** arc policies granted to a token minted from this role. */
  policies: string[];
  /** Optional TokenReview audiences to assert the presented token was minted for. */
  audiences?: string[];
  /** TTL (seconds) of the arc token minted from a successful login. Defaults to 3600. */
  tokenTtlSeconds?: number;
}

export interface KubernetesPluginConfig {
  roles: Record<string, KubernetesRoleConfig>;
}

/** Result of a Kubernetes TokenReview. */
export interface TokenReviewResult {
  authenticated: boolean;
  /** `system:serviceaccount:<namespace>:<name>` for a ServiceAccount token. */
  username?: string;
  uid?: string;
  groups?: string[];
  /** Reviewer-reported error when `authenticated` is false. */
  error?: string;
}

/**
 * Transport boundary: submits a token to the cluster's TokenReview API and reports whether
 * it authenticated + who it belongs to. The shipped `@arc/plugin-kubernetes/node` entry
 * provides a default impl over `fetch` (no external deps). Tests inject a fake.
 */
export interface TokenReviewer {
  review(token: string, audiences?: string[]): Promise<TokenReviewResult>;
}
