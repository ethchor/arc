# arc-plugin-kubernetes — agent context

**Scope.** Kubernetes auth method. A caller (typically a pod) presents its projected
ServiceAccount token; the plugin verifies it via the cluster's TokenReview API and maps the
`(namespace, service account)` pair to arc policies. Implements `@arc/plugin-sdk`'s `AuthPlugin`
(`configure` + `login`). Mounted by arc-server's `AuthMethodsService`;
`POST /v1/auth/<mount>/login` runs `login()`.

**Deps rule.** Workspace deps are `@arc/plugin-sdk` + `@arc/types` only. The default reviewer
(`@arc/plugin-kubernetes/node`) uses **Node's global `fetch` only** — no external runtime deps.
Tests inject a fake `TokenReviewer`; for mTLS / a custom dispatcher, or to trust the cluster CA,
inject a custom reviewer or point `NODE_EXTRA_CA_CERTS` at the API server CA.

**Security invariants.**
- Authentication is delegated to the cluster (TokenReview) — the plugin never inspects the
  token signature itself, so a forged token is rejected by the API server.
- Policies come from the operator-configured **role**, never from the token. The role's
  `boundNamespaces` + `boundServiceAccountNames` (with `*` wildcards) gate which identities a
  role accepts; a non-ServiceAccount identity (user/node) is rejected outright.
