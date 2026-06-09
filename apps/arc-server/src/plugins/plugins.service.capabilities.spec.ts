/**
 * Plugin runtime capability gate (ADR-005 Phase 5b runtime extension). Proves the gate
 * actually short-circuits dispatch when the verified manifest's `capabilities` field is
 * present, and stays out of the way otherwise (matching the pre-gate posture). The unit
 * under test is the seam between {@link PluginsService.mountSecretsPlugin} (which pins the
 * cap set onto the mount) and {@link EnginesService.requirePluginCapability} (which reads
 * it during dispatch).
 */
import { BadRequestException } from "@nestjs/common";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";
import { PluginManifestService } from "./plugin-manifest.service";

class FakeAwsPlugin implements SecretsPlugin {
  readonly meta = {
    name: "fake-aws-caps",
    version: "0.0.1",
    kind: "secrets" as const,
    description: "in-process fake for capability-gate tests",
  };
  private counter = 0;
  async configure(): Promise<void> {}
  async issue(req: IssueRequest): Promise<IssuedSecret> {
    this.counter++;
    return {
      data: { access_key: `AKIA-${req.role}-${this.counter}` },
      leaseId: `plugin/${this.meta.name}/${req.role}/${this.counter}`,
      ttlSeconds: 60,
      renewable: true,
    };
  }
  async renew(leaseId: string): Promise<LeaseInfo> {
    return { leaseId, ttlSeconds: 60, renewable: true };
  }
  async revoke(): Promise<void> {}
}

function buildHarness(): {
  engines: EnginesService;
  plugins: PluginsService;
  config: EnginesConfig;
} {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const manifestCapsByMount = new Map<string, ReadonlySet<string> | null>();
  const config: EnginesConfig = {
    client: null,
    registry,
    enginesByMount,
    leases,
    manifestCapsByMount,
  };
  return {
    engines: new EnginesService(config),
    plugins: new PluginsService(config, new PluginManifestService()),
    config,
  };
}

describe("EnginesService — plugin runtime capability gate", () => {
  it("bypasses the gate when no capabilities are pinned (mount without manifest caps)", async () => {
    const { engines, plugins } = buildHarness();
    // mountSecretsPlugin called without `capabilities` ⇒ manifestCapsByMount.get(mount) === null
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/");
    const issued = await engines.get("aws/creds/web", {});
    expect(issued.data).toEqual({ access_key: "AKIA-web-1" });
  });

  it("allows a request whose verb is in the declared set (read for creds/<role>)", async () => {
    const { engines, plugins } = buildHarness();
    // Declare exactly the verb the GET path needs.
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["read"]);
    const issued = await engines.get("aws/creds/web", {});
    expect(issued.data).toEqual({ access_key: "AKIA-web-1" });
  });

  it("refuses to issue when the manifest only declared `list` (not `read`)", async () => {
    const { engines, plugins } = buildHarness();
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["list"]);
    await expect(engines.get("aws/creds/web", {})).rejects.toMatchObject({
      status: 400,
      response: {
        reason: "plugin_capability_not_declared",
        capability: "read",
        mount: "aws/",
        declared: ["list"],
      },
    });
  });

  it("refuses to revoke a plugin-issued lease when the manifest didn't declare `delete`", async () => {
    const { engines, plugins } = buildHarness();
    // `read` lets us issue, but lease revoke needs `delete`.
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["read"]);
    const issued = await engines.get("aws/creds/web", {});

    await expect(engines.revokeLease(issued.lease_id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(engines.revokeLease(issued.lease_id as string)).rejects.toMatchObject({
      response: { reason: "plugin_capability_not_declared", capability: "delete" },
    });
  });

  it("refuses to renew a plugin-issued lease when the manifest didn't declare `update`", async () => {
    const { engines, plugins } = buildHarness();
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["read"]);
    const issued = await engines.get("aws/creds/web", {});

    await expect(engines.renewLease(issued.lease_id as string)).rejects.toMatchObject({
      response: { reason: "plugin_capability_not_declared", capability: "update" },
    });
  });

  it("`sudo` short-circuits the gate: a plugin declaring only sudo can do anything on its mount", async () => {
    const { engines, plugins } = buildHarness();
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["sudo"]);
    const issued = await engines.get("aws/creds/web", {});
    await expect(engines.renewLease(issued.lease_id as string)).resolves.toBeDefined();
    await expect(engines.revokeLease(issued.lease_id as string)).resolves.toBeUndefined();
  });

  it("unmount clears the cap pin so a re-mount with different caps takes effect cleanly", async () => {
    const { engines, plugins, config } = buildHarness();
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["sudo"]);
    expect(config.manifestCapsByMount.get("aws/")).toBeInstanceOf(Set);

    await plugins.unmount("fake-aws-caps");
    expect(config.manifestCapsByMount.has("aws/")).toBe(false);

    // Re-mount with `read` only — gate should now refuse renew.
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, ["read"]);
    const issued = await engines.get("aws/creds/web", {});
    await expect(engines.renewLease(issued.lease_id as string)).rejects.toMatchObject({
      response: { reason: "plugin_capability_not_declared", capability: "update" },
    });
  });

  it("an empty declared set refuses every gated request (explicit zero-trust posture)", async () => {
    const { engines, plugins } = buildHarness();
    // Explicit empty list: the plugin author declared they need nothing. Strictest stance.
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/", {}, []);
    await expect(engines.get("aws/creds/web", {})).rejects.toMatchObject({
      response: { reason: "plugin_capability_not_declared", capability: "read", declared: [] },
    });
  });
});
