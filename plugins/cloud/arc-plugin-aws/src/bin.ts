/**
 * Out-of-process entry point for `@arc/plugin-aws` (ADR-005 Phase 5b OOP plugin shape).
 *
 * Spawned by arc-server's `mountRemoteSecretsPlugin` (`RemoteSecretsPlugin.spawn`) and
 * driven via JSON-RPC 2.0 over stdio by `runSecretsPlugin`. The plugin's own
 * configure / issue / renew / revoke surface is unchanged — this file just bridges the
 * stdio transport into the in-process `AwsSecretsPlugin`.
 *
 * Credential resolution for the STS client: the `@aws-sdk/client-sts` default chain (env
 * vars → shared config → EC2 IMDSv2 → EKS web-identity), so the operator points the OOP
 * binary at AWS the same way they'd point any other AWS-SDK app. Per-role configuration
 * (which IAM roles to issue, role ARNs, TTL caps) arrives via the JSON-RPC `configure`
 * call from arc-server at mount time.
 *
 * Signed-release: this file is what `arc-plugin-sign sign --artifact <bin.cjs>
 * --kind process` pins. A tampered binary refuses to spawn (the server's manifest gate
 * re-hashes the executable bytes before forking the child).
 */
import { runSecretsPlugin } from "@arc/plugin-sdk/runtime";
import { createSdkStsClient } from "./aws-sdk-sts-client";
import { AwsSecretsPlugin } from "./plugin";

void runSecretsPlugin(new AwsSecretsPlugin(createSdkStsClient({})));
