/**
 * Integration spec that mounts the real `@arc/plugin-aws` through the plugin host and
 * exercises a `GET /v1/aws/creds/<role>` round-trip via {@link EnginesService}. STS is
 * stubbed (the plugin accepts any `StsClient` impl) so the test is hermetic — no AWS
 * network calls, no SDK import.
 *
 * What this proves end-to-end:
 *  1. `PluginsService.mountSecretsPlugin` registers + configures + mounts the AWS plugin
 *     at a chosen path, with the plugin's own config validation gating it.
 *  2. The mount appears in {@link EnginesService.listMounts} alongside built-in engines.
 *  3. `GET /v1/aws/creds/<role>` dispatch routes through the existing
 *     `DynamicSecretsEngine` branch into the plugin's `issue` and returns the Vault wire
 *     shape `{data, lease_id, lease_duration, renewable}`.
 *  4. `LeaseManager.renew` correctly refuses an AWS-issued lease (renewable=false propagates).
 *  5. `revokeLease` flows through to the plugin's no-op revoke and marks the arc lease
 *     revoked.
 *  6. Unmount tears the registry entry down and removes the plugin from the host.
 */
import { AwsSecretsPlugin } from "@arc/plugin-aws";
import type {
  StsAssumeRoleInput,
  StsAssumeRoleOutput,
  StsClient,
} from "@arc/plugin-aws";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { BadRequestException } from "@nestjs/common";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";
import { PluginManifestService } from "./plugin-manifest.service";

function fakeSts(): StsClient & { calls: StsAssumeRoleInput[] } {
  const calls: StsAssumeRoleInput[] = [];
  return {
    calls,
    async assumeRole(input: StsAssumeRoleInput): Promise<StsAssumeRoleOutput> {
      calls.push(input);
      return {
        accessKeyId: `AKIA-${input.sessionName}`,
        secretAccessKey: `secret-${input.sessionName}`,
        sessionToken: `token-${input.sessionName}`,
        expirationSeconds: input.durationSeconds,
        assumedRoleArn: `arn:aws:sts::123:assumed-role/x/${input.sessionName}`,
      };
    },
  };
}

function buildHarness() {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases, manifestCapsByMount: new Map() };
  return {
    enginesService: new EnginesService(config),
    plugins: new PluginsService(config, new PluginManifestService()),
    config,
  };
}

describe("@arc/plugin-aws end-to-end through PluginsService + EnginesService", () => {
  it("mounts, dispatches GET aws/creds/<role>, surfaces STS credentials in the wire shape", async () => {
    const { enginesService, plugins } = buildHarness();
    const sts = fakeSts();
    const aws = new AwsSecretsPlugin(sts);

    await plugins.mountSecretsPlugin(aws, "aws/", {
      roles: {
        app: { roleArn: "arn:aws:iam::123:role/app", defaultTtlSeconds: 1800 },
      },
    });

    const mounts = await enginesService.listMounts();
    expect(mounts.map((m) => m.path)).toContain("aws/");
    // PluginSecretsEngine names its type "plugin:<pluginName>".
    expect(mounts.find((m) => m.path === "aws/")?.type).toBe("plugin:arc-plugin-aws");

    const issued = await enginesService.get("aws/creds/app", {});
    // Plugin asked STS with the configured defaultTtl.
    expect(sts.calls).toHaveLength(1);
    expect(sts.calls[0]!.durationSeconds).toBe(1800);
    expect(sts.calls[0]!.roleArn).toBe("arn:aws:iam::123:role/app");

    expect(issued.data).toMatchObject({
      access_key: expect.stringMatching(/^AKIA-/),
      secret_key: expect.stringMatching(/^secret-/),
      session_token: expect.stringMatching(/^token-/),
      assumed_role_arn: expect.stringContaining("assumed-role/x/"),
    });
    expect(typeof issued.lease_id).toBe("string");
    // STS returned `expirationSeconds = durationSeconds`; the wire derives lease_duration
    // from (expiresAt - now), so a tiny floor() shave is normal.
    expect(issued.lease_duration).toBeGreaterThanOrEqual(1799);
    expect(issued.lease_duration).toBeLessThanOrEqual(1800);
    // Critical: STS-minted creds are NOT renewable. Surfaced from the plugin via
    // IssuedSecret.renewable, propagated by PluginSecretsEngine into Lease.renewable.
    expect(issued.renewable).toBe(false);
  });

  it("refuses to renew an AWS-issued lease (Lease.renewable=false → 400)", async () => {
    const { enginesService, plugins } = buildHarness();
    const aws = new AwsSecretsPlugin(fakeSts());
    await plugins.mountSecretsPlugin(aws, "aws/", {
      roles: { app: { roleArn: "arn:aws:iam::123:role/app" } },
    });

    const issued = await enginesService.get("aws/creds/app", {});
    await expect(enginesService.renewLease(issued.lease_id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("revokeLease delegates to the plugin's no-op revoke and marks the arc lease revoked", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const sts = fakeSts();
    const aws = new AwsSecretsPlugin(sts);
    await plugins.mountSecretsPlugin(aws, "aws/", {
      roles: { app: { roleArn: "arn:aws:iam::123:role/app" } },
    });

    const issued = await enginesService.get("aws/creds/app", {});
    await enginesService.revokeLease(issued.lease_id as string);
    expect(await config.leases.state(issued.lease_id as string)).toBe("revoked");
    // The plugin doesn't call AWS for revoke — only the one issue STS call.
    expect(sts.calls).toHaveLength(1);
  });

  it("rejects invalid plugin config at mount time (admin typo → BadRequest, plugin stays unregistered)", async () => {
    const { plugins } = buildHarness();
    const aws = new AwsSecretsPlugin(fakeSts());
    await expect(
      plugins.mountSecretsPlugin(aws, "aws/", { roles: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The plugin should NOT be in the host (configure() failed; mountSecretsPlugin rolls back).
    expect(plugins.has("arc-plugin-aws")).toBe(false);
  });

  it("unmount drops the mount + plugin and revokes outstanding leases for the prefix", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const aws = new AwsSecretsPlugin(fakeSts());
    await plugins.mountSecretsPlugin(aws, "aws/", {
      roles: { app: { roleArn: "arn:aws:iam::123:role/app" } },
    });
    const issued = await enginesService.get("aws/creds/app", {});

    expect(await plugins.unmount("arc-plugin-aws")).toBe(true);
    expect((await enginesService.listMounts()).map((m) => m.path)).not.toContain("aws/");
    expect(await config.leases.state(issued.lease_id as string)).toBe("revoked");
  });
});
