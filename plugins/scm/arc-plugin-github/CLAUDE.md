# arc-plugin-github — agent context

**Scope.** GitHub SCM plugin. Mints dynamic installation tokens for a GitHub App,
implementing `@arc/plugin-sdk`'s `SecretsPlugin`. Mounted by arc-server's
`PluginsService`; `/v1/<mount>/creds/<role>` returns a fresh installation token (1h,
non-renewable) per request.

**Deps rule.** Workspace deps are `@arc/plugin-sdk` + `@arc/types` only. The default
client uses **Node built-ins only** (`node:crypto` for RS256 JWT signing + global `fetch`),
no external runtime deps — pulling in octokit just for one endpoint isn't worth the
weight. The default impl lives at `@arc/plugin-github/node`; tests inject a fake
`GitHubAppClient`.

**Installation-token semantics.**
- `issue` → POST `/app/installations/{id}/access_tokens`. Auth is a per-request App JWT
  (RS256, 9-min validity, signed with the App's private key). Returns the bearer token,
  GitHub's `expires_at`, and the (optionally narrowed) permissions/repositories.
- `renew` → not renewable. Tokens expire in 1h; re-issue to extend.
- `revoke` → no-op at GitHub. The `DELETE /installation/token` API does revoke early, but
  authenticating it requires using the token itself, which round-trips the secret through
  the audit. Tokens auto-expire fast enough that this isn't a practical concern; the
  plugin drops local tracking and arc records the revocation.

**JWT details (per GitHub docs).** Backdate `iat` by 30s (their clock-skew tolerance is
narrow); `exp` ≤ 10m from `iat`. We use 9m to stay safely inside. Algorithm is
RS256 (RSASSA-PKCS1-v1_5 over SHA-256).
