# arc-plugin-gcp — agent context

**Scope.** GCP cloud plugin. Mints dynamic OAuth2 access tokens via IAM Credentials
`generateAccessToken`. Mounted by arc-server's `PluginsService` like any other secrets
plugin; requests flow through the standard `/v1/<mount>/creds/<role>` dispatch.

**Deps rule.** Same as `arc-plugin-aws`: workspace deps are `@arc/plugin-sdk` + `@arc/types`
only. `google-auth-library` is an **optional peer dep** for the
`@arc/plugin-gcp/google-auth-library` subpath only. Tests inject a fake
`IamCredentialsClient` and never touch the SDK.

**IAM Credentials semantics.**
- `issue` → POST `…/serviceAccounts/<sa>:generateAccessToken`, returns
  `{access_token}` + the server-reported expiration as the lease TTL.
- `renew` → not renewable. Tokens carry their own expiration; re-issue to extend.
- `revoke` → no-op at GCP. IAM Credentials has no per-token revocation; revocation is
  policy-level via IAM. The plugin drops local tracking; arc audit logs the revoke.

The IAM Credentials API caps lifetime at 1h by default, 12h when the org policy
`constraints/iam.allowServiceAccountCredentialLifetimeExtension` is set. The plugin
surfaces what GCP returned, not what was requested.
