/**
 * StsClient implementation backed by `@aws-sdk/client-sts`. Lives behind the
 * `@arc/plugin-aws/aws-sdk` subpath so callers that inject their own StsClient (tests,
 * custom signers, IMDSv2 / web-identity flows) don't pay for the SDK import.
 *
 * Why an optional peer dep instead of a regular dep: the SDK has a large transitive
 * footprint, and plugin authors with a different transport (e.g. SigV4-over-fetch on the
 * edge, sigv4a for cross-region, an existing in-process SDK instance) shouldn't be forced
 * to install it. Pure-test consumers in this workspace skip it entirely.
 */
import {
  AssumeRoleCommand,
  STSClient,
  type STSClientConfig,
} from "@aws-sdk/client-sts";
import type { StsAssumeRoleInput, StsAssumeRoleOutput, StsClient } from "./types";

export interface CreateSdkStsClientOptions extends STSClientConfig {
  // Re-exported as-is so callers can pass through region / credentials / endpoint without
  // pulling the SDK types into their own code.
}

/**
 * Build a StsClient backed by `@aws-sdk/client-sts`. Pass any `STSClientConfig` (region,
 * credentials, endpoint, custom request handler). The returned object satisfies the
 * `StsClient` interface, so plug it directly into `new AwsSecretsPlugin(client)`.
 *
 * Credential resolution: if `credentials` is omitted the SDK's default chain kicks in
 * (env vars, shared config file, EC2 instance profile, EKS web identity, …) — that's the
 * idiomatic AWS pattern, and it lets the plugin work in an ECS / Lambda / EKS deploy
 * without arc-server holding long-lived keys.
 */
export function createSdkStsClient(opts: CreateSdkStsClientOptions = {}): StsClient {
  const client = new STSClient(opts);
  return {
    async assumeRole(input: StsAssumeRoleInput): Promise<StsAssumeRoleOutput> {
      const res = await client.send(
        new AssumeRoleCommand({
          RoleArn: input.roleArn,
          RoleSessionName: input.sessionName,
          DurationSeconds: input.durationSeconds,
          ExternalId: input.externalId,
        }),
      );
      const creds = res.Credentials;
      if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration) {
        throw new Error("STS AssumeRole returned no credentials");
      }
      const expirationSeconds = Math.max(
        0,
        Math.floor((creds.Expiration.getTime() - Date.now()) / 1000),
      );
      return {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
        expirationSeconds,
        assumedRoleArn: res.AssumedRoleUser?.Arn,
      };
    },
  };
}
