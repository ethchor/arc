/**
 * Plugin host unit-spec. Wires a fake {@link SecretsPlugin} through {@link PluginsService}
 * + {@link EnginesService} and exercises end-to-end:
 *
 *  1. register + mount → plugin appears in `listMounts` *and* `listPlugins`
 *  2. dispatch `GET <mount>/creds/<role>` through the existing engines pipeline → the
 *     fake plugin's `issue` runs and a wire-shape `{data, lease_id, lease_duration,
 *     renewable}` comes out
 *  3. `sys/leases/renew` looks up the arc lease, finds the plugin-backed mount, and
 *     delegates to the plugin's `renew`
 *  4. `sys/leases/revoke` similarly delegates and marks the arc lease revoked
 *  5. unmount → removes the registry entry, revokes outstanding leases for the prefix,
 *     and drops the plugin from the host
 *  6. configure() throws → BadRequest 400 + plugin not registered (no half-mounted state)
 *
 * Critically: this doesn't go through any OpenBao backend, proving plugin mounts work
 * with `BAO_ADDR` unset (engine.client = null).
 */
import { BadRequestException } from "@nestjs/common";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import type { IssueRequest, IssuedSecret, LeaseInfo, SecretsPlugin } from "@arc/plugin-sdk";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";

class FakeAwsPlugin implements SecretsPlugin {
  readonly meta = {
    name: "fake-aws",
    version: "0.0.1",
    kind: "secrets" as const,
    description: "in-process fake for tests",
  };
  configured = false;
  revoked: string[] = [];
  private counter = 0;

  async configure(input: unknown): Promise<void> {
    if ((input as { fail?: boolean })?.fail) throw new Error("config rejected");
    this.configured = true;
  }
  async issue(req: IssueRequest): Promise<IssuedSecret> {
    this.counter++;
    return {
      data: { access_key: `AKIA-${req.role}-${this.counter}`, secret: `secret-${this.counter}` },
      leaseId: `plugin/${this.meta.name}/${req.role}/${this.counter}`,
      ttlSeconds: req.ttlSeconds ?? 120,
      renewable: true,
    };
  }
  async renew(leaseId: string): Promise<LeaseInfo> {
    return { leaseId, ttlSeconds: 240, renewable: true };
  }
  async revoke(leaseId: string): Promise<void> {
    this.revoked.push(leaseId);
  }
}

function buildHarness(): {
  enginesService: EnginesService;
  plugins: PluginsService;
  config: EnginesConfig;
} {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  // No OpenBao client — proves plugin mounts work in plugin-only deployments.
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases };
  const enginesService = new EnginesService(config);
  const plugins = new PluginsService(config);
  return { enginesService, plugins, config };
}

describe("PluginsService — register + mount + dispatch", () => {
  it("registers + configures + mounts a SecretsPlugin and routes <mount>/creds/<role> to it", async () => {
    const { enginesService, plugins } = buildHarness();
    const plugin = new FakeAwsPlugin();

    const mounted = await plugins.mountSecretsPlugin(plugin, "aws/", { region: "us-east-1" });
    expect(plugin.configured).toBe(true);
    expect(mounted.mount).toBe("aws/");
    expect(plugins.list().map((p) => p.meta.name)).toEqual(["fake-aws"]);
    expect((await enginesService.listMounts()).map((m) => m.path)).toEqual(["aws/"]);

    const issued = await enginesService.get("aws/creds/web", {});
    expect(issued.data).toEqual({ access_key: "AKIA-web-1", secret: "secret-1" });
    expect(typeof issued.lease_id).toBe("string");
    // lease_duration is derived from (expiresAt - now) so floor() can shave 1s.
    expect(issued.lease_duration).toBeGreaterThanOrEqual(119);
    expect(issued.lease_duration).toBeLessThanOrEqual(120);
    expect(issued.renewable).toBe(true);
  });

  it("renewLease delegates to the plugin and surfaces the new ttl on the wire", async () => {
    const { enginesService, plugins } = buildHarness();
    const plugin = new FakeAwsPlugin();
    await plugins.mountSecretsPlugin(plugin, "aws/");

    const issued = await enginesService.get("aws/creds/web", {});
    // Plugin issues with ttlSeconds=120 (matches the lease's maxTtlSeconds), so a
    // renew to 240 would exceed the cap; bump the lease's cap up so the renew can land.
    // This isolates "wire-shape matches plugin renew result" from cap behavior, which is
    // tested separately in @arc/leasing.
    const lease = (enginesService as unknown as { config: { leases: { get(id: string): { maxTtlSeconds: number } | undefined } } })
      .config.leases.get(issued.lease_id as string);
    if (lease) (lease as { maxTtlSeconds: number }).maxTtlSeconds = 600;

    const renewed = await enginesService.renewLease(issued.lease_id as string);
    expect(renewed.lease_id).toBe(issued.lease_id);
    expect(renewed.lease_duration).toBeGreaterThanOrEqual(239);
    expect(renewed.lease_duration).toBeLessThanOrEqual(240);
  });

  it("revokeLease delegates to the plugin and marks the arc lease revoked", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const plugin = new FakeAwsPlugin();
    await plugins.mountSecretsPlugin(plugin, "aws/");

    const issued = await enginesService.get("aws/creds/web", {});
    await enginesService.revokeLease(issued.lease_id as string);

    expect(plugin.revoked).toHaveLength(1);
    expect(plugin.revoked[0]).toMatch(/^plugin\/fake-aws\/web\/\d+$/);
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
  });

  it("unmount drops the registry entry, revokes outstanding leases, and removes the plugin", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const plugin = new FakeAwsPlugin();
    await plugins.mountSecretsPlugin(plugin, "aws/");

    const a = await enginesService.get("aws/creds/web", {});
    const b = await enginesService.get("aws/creds/api", {});

    expect(await plugins.unmount("fake-aws")).toBe(true);
    expect(plugins.has("fake-aws")).toBe(false);
    expect((await enginesService.listMounts()).map((m) => m.path)).toEqual([]);

    // Every outstanding lease at that mount was revoked by `revokePrefix`.
    expect(config.leases.state(a.lease_id as string)).toBe("revoked");
    expect(config.leases.state(b.lease_id as string)).toBe("revoked");

    // Idempotent.
    expect(await plugins.unmount("fake-aws")).toBe(false);
  });

  it("translates a configure() failure into 400 without leaving the plugin half-registered", async () => {
    const { plugins } = buildHarness();
    const plugin = new FakeAwsPlugin();
    await expect(plugins.mountSecretsPlugin(plugin, "aws/", { fail: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(plugins.has("fake-aws")).toBe(false);
    expect(plugins.list()).toEqual([]);
  });

  it("refuses to mount a plugin whose name is already registered", async () => {
    const { plugins } = buildHarness();
    await plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws/");
    await expect(plugins.mountSecretsPlugin(new FakeAwsPlugin(), "aws-2/")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
