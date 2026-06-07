/**
 * Out-of-process plugin host integration. Spawns a real Node child running
 * `@arc/plugin-sdk/runtime` with a hand-rolled fake SecretsPlugin, mounts it through
 * `PluginsService.mountRemoteSecretsPlugin`, and asserts the full dispatch pipeline
 * (`creds/<role>` → `renew` → `revoke` → `unmount`) works across the process boundary.
 *
 * Critically: this proves the sandbox boundary holds. The child sees only the env vars
 * we list, has no access to arc-server's heap, and is killed cleanly on unmount.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";

const RUNTIME_CJS = join(__dirname, "../../../../packages/arc-plugin-sdk/dist/runtime.cjs");

function writePluginScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-remote-plugin-spec-"));
  const file = join(dir, "plugin.cjs");
  writeFileSync(
    file,
    `
const { runSecretsPlugin } = require("${RUNTIME_CJS}");
const plugin = (function () {
  ${body}
  return impl;
})();
runSecretsPlugin(plugin);
`,
    "utf8",
  );
  return file;
}

function buildHarness(): { plugins: PluginsService; engines: EnginesService } {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases };
  return { engines: new EnginesService(config), plugins: new PluginsService(config) };
}

describe("PluginsService — out-of-process plugin host", () => {
  it("spawns a child, mounts via RemoteSecretsPlugin, dispatches creds/<role> across the boundary", async () => {
    const script = writePluginScript(`
      let configured;
      let counter = 0;
      const impl = {
        meta: { name: "remote-aws", version: "1.0.0", kind: "secrets", description: "out-of-process fake" },
        async configure(input) { configured = input; },
        async issue(req) {
          counter++;
          return {
            data: { access_key: "AKIA-" + req.role + "-" + counter, region: configured?.region ?? null },
            leaseId: "remote/" + req.role + "/" + counter,
            ttlSeconds: req.ttlSeconds ?? 120,
            renewable: true,
          };
        },
        async renew(leaseId) { return { leaseId, ttlSeconds: 240, renewable: true }; },
        async revoke() {},
      };
    `);

    const { plugins, engines } = buildHarness();
    const mounted = await plugins.mountRemoteSecretsPlugin(
      { command: process.execPath, args: [script] },
      "remote-aws/",
      { region: "us-east-1" },
    );
    expect(mounted.meta).toMatchObject({ name: "remote-aws", version: "1.0.0", kind: "secrets" });
    expect(mounted.mount).toBe("remote-aws/");

    // Dispatch through arc-server's engines pipeline — proves the SecretsPlugin contract
    // crosses the process boundary cleanly.
    const issued = await engines.get("remote-aws/creds/deploy", {});
    expect(issued.data).toMatchObject({ access_key: "AKIA-deploy-1", region: "us-east-1" });
    expect(issued.renewable).toBe(true);
    expect(typeof issued.lease_id).toBe("string");

    // Renew via sys/leases — drives the child's `renew` method.
    const renewed = await engines.renewLease(issued.lease_id as string, undefined);
    expect(renewed.lease_id).toBe(issued.lease_id);

    // Revoke prefix + close the child cleanly.
    await plugins.unmount("remote-aws");
    expect((await engines.listMounts()).map((m) => m.path)).not.toContain("remote-aws/");
  }, 20_000);

  it("rejects an unspawnable plugin with a BadRequest carrying the spawn error", async () => {
    const { plugins } = buildHarness();
    await expect(
      plugins.mountRemoteSecretsPlugin(
        { command: process.execPath, args: ["-e", "process.exit(1)"], rpcTimeoutMs: 1_500 },
        "wont-mount/",
        {},
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: expect.arrayContaining([expect.stringMatching(/spawn|exited|timed out/)]) },
    });
  }, 20_000);

  it("rolls the child back when configure() throws", async () => {
    const script = writePluginScript(`
      const impl = {
        meta: { name: "bad-config", version: "1", kind: "secrets" },
        async configure() { throw new Error("config rejected"); },
        async issue() { throw new Error("nr"); },
        async renew() { throw new Error("nr"); },
        async revoke() {},
      };
    `);
    const { plugins } = buildHarness();
    await expect(
      plugins.mountRemoteSecretsPlugin({ command: process.execPath, args: [script] }, "bc/", { x: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: expect.arrayContaining([expect.stringMatching(/config rejected/)]) },
    });
    // The host should be clean — no half-mounted plugin.
    expect(plugins.list().map((p) => p.meta.name)).not.toContain("bad-config");
  }, 20_000);
});
