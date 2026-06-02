/**
 * Per-role config the admin attaches to the plugin. The plugin only mints credentials
 * for roles that appear here; unknown roles throw at `issue` time so a typo doesn't
 * silently fall through.
 *
 * `defaultTtlSeconds` is what we ask STS for if the caller doesn't specify one. Per AWS,
 * STS clamps to the role's `MaxSessionDuration` (1h–12h) — we don't second-guess that,
 * just request and let STS enforce. `maxTtlSeconds`, if set, is an arc-side ceiling
 * applied *before* the STS request (so a runaway caller can't request 12h on a role
 * that the operator intends to cap at 1h).
 */
export interface AwsRoleConfig {
  roleArn: string;
  sessionName?: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  externalId?: string;
}

/**
 * Plugin configuration. Validated in `AwsSecretsPlugin.configure` and stored locally;
 * the plugin never writes config back, so re-configuring is destructive (full replace).
 *
 * `roles` is a name→config map; the admin chooses friendly names ("read-only", "deploy")
 * that callers use in `GET /v1/<mount>/creds/<name>`. The full IAM ARN stays admin-side.
 */
export interface AwsPluginConfig {
  /**
   * Optional region — STS endpoints are global, but the AWS SDK still wants a region for
   * resolving signing scope. Defaults to `us-east-1` (the STS global endpoint's region) if
   * the StsClient doesn't carry its own.
   */
  region?: string;
  roles: Record<string, AwsRoleConfig>;
}

export interface StsAssumeRoleInput {
  /** Full IAM role ARN — `arn:aws:iam::<account>:role/<name>`. */
  roleArn: string;
  /** Free-form session name; surfaces in CloudTrail as `aws:userid`. Max 64 chars. */
  sessionName: string;
  /** Requested TTL — STS clamps to the role's MaxSessionDuration (900s–43200s). */
  durationSeconds: number;
  /** Optional ExternalId for cross-account trust policies that require it. */
  externalId?: string;
}

export interface StsAssumeRoleOutput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /**
   * Seconds-until-expiration as reported by AWS at the time the response was received.
   * The plugin surfaces this as the lease's `ttlSeconds`; LeaseManager tracks the wall
   * clock from there.
   */
  expirationSeconds: number;
  /**
   * STS's opaque assumed-role-user ARN (`arn:aws:sts::<account>:assumed-role/<role>/<sess>`).
   * Carried through to the lease metadata so audit can show *who* got minted creds.
   */
  assumedRoleArn?: string;
}

/**
 * The transport boundary between the plugin and AWS. The shipped `@arc/plugin-aws/aws-sdk`
 * entry implements this on top of `@aws-sdk/client-sts`; tests inject a hand-rolled fake.
 * Anyone with a different signer (a custom SigV4, instance-profile credentials, IMDSv2,
 * web-identity federation) implements this and passes it to `new AwsSecretsPlugin(client)`.
 */
export interface StsClient {
  assumeRole(input: StsAssumeRoleInput): Promise<StsAssumeRoleOutput>;
}
