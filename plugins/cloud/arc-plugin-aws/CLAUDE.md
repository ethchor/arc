# arc-plugin-aws — agent context

**Scope.** First-party AWS cloud plugin. Mints dynamic IAM credentials via STS AssumeRole
through the `@arc/plugin-sdk` `SecretsPlugin` contract. Mounted by arc-server's
`PluginsService` like any other secrets plugin; requests flow through the standard
`/v1/<mount>/creds/<role>` dispatch.

**Deps rule.** `plugins/*` may only depend on `@arc/plugin-sdk` and `@arc/types` per
`docs/CLAUDE.md`. `@aws-sdk/client-sts` is an **optional peer dep** under the
`@arc/plugin-aws/aws-sdk` subpath — the core plugin has no AWS-SDK import, only the
sub-entry does. Tests inject a fake `StsClient` and never touch the SDK.

**STS semantics.**
- `issue` → AssumeRole, returns `{access_key, secret_key, session_token}` plus the
  seconds-until-expiration as the lease TTL.
- `renew` → not renewable (matches Vault). STS creds carry their own expiration;
  re-issue to extend.
- `revoke` → no-op at AWS (cannot force-expire STS creds short of attaching a Deny
  policy). The plugin drops local tracking; the arc LeaseManager records the revocation
  for audit.

**Adding a new plugin in this directory.** Mirror this layout: `package.json` with the
`@arc/plugin-{name}` scope, `tsup.config.ts` for ESM+CJS dual-publish, `src/types.ts` +
`src/plugin.ts`, optional `src/<vendor>-client.ts` for an SDK-backed default. Stay inside
the deps rule; non-trivial transports go behind an optional peer.
