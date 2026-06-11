/**
 * Round-trip between {@link RemoteSecretsPlugin} and {@link runSecretsPlugin}. Spawns a Node
 * child that runs an in-process plugin behind the stdio runtime, then drives it from the
 * host side and asserts the contract holds across the process boundary.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSecretsPlugin, RemotePluginError } from "../src/remote";
import { spawnSync } from "node:child_process";

/**
 * Write a small Node script that requires the compiled CJS runtime and a hand-rolled
 * SecretsPlugin, then return the path. Each test gets its own script so they can vary
 * behaviour (errors, slow responses, immediate exit).
 */
function writePluginScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-remote-plugin-"));
  const file = join(dir, "plugin.cjs");
  writeFileSync(
    file,
    `
const { runSecretsPlugin } = require("${join(process.cwd(), "dist", "runtime.cjs")}");

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

describe("RemoteSecretsPlugin ↔ runSecretsPlugin round-trip", () => {
  const plugins: RemoteSecretsPlugin[] = [];

  afterEach(async () => {
    while (plugins.length > 0) {
      const p = plugins.pop();
      if (p) await p.close().catch(() => undefined);
    }
  });

  it("completes meta handshake and surfaces plugin metadata on the host", async () => {
    const file = writePluginScript(`
      const impl = {
        meta: { name: "echo", version: "1.0.0", kind: "secrets", description: "test plugin" },
        async configure() {},
        async issue(req) { return { data: { role: req.role }, leaseId: "lease-1", ttlSeconds: 60, renewable: false }; },
        async renew() { throw new Error("not implemented"); },
        async revoke() {},
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
    plugins.push(p);
    expect(p.meta).toEqual({
      name: "echo",
      version: "1.0.0",
      kind: "secrets",
      description: "test plugin",
    });
  });

  it("configure → issue → revoke round-trips faithfully", async () => {
    const file = writePluginScript(`
      let configured;
      const issued = new Set();
      const impl = {
        meta: { name: "echo", version: "1", kind: "secrets" },
        async configure(input) { configured = input; },
        async issue(req) {
          const id = "lease-" + (issued.size + 1);
          issued.add(id);
          return {
            data: { role: req.role, ttl: req.ttlSeconds ?? null, configured },
            leaseId: id,
            ttlSeconds: req.ttlSeconds ?? 30,
            renewable: false,
          };
        },
        async renew() { throw new Error("not renewable"); },
        async revoke(leaseId) { issued.delete(leaseId); },
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
    plugins.push(p);

    await p.configure({ apiKey: "k" });
    const issued = await p.issue({ role: "deployer", ttlSeconds: 900 });
    expect(issued).toMatchObject({
      data: { role: "deployer", ttl: 900, configured: { apiKey: "k" } },
      leaseId: "lease-1",
      ttlSeconds: 900,
      renewable: false,
    });

    await p.revoke(issued.leaseId);
    // The plugin processes revoke; nothing observable from the host except no error.
  });

  it("propagates plugin errors as RemotePluginError, with message preserved", async () => {
    const file = writePluginScript(`
      const impl = {
        meta: { name: "echo", version: "1", kind: "secrets" },
        async configure() {},
        async issue() { throw new Error("bad role"); },
        async renew() { throw new Error("not renewable"); },
        async revoke() {},
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
    plugins.push(p);
    await expect(p.issue({ role: "x" })).rejects.toBeInstanceOf(RemotePluginError);
    await expect(p.issue({ role: "x" })).rejects.toThrow(/bad role/);
  });

  it("fails the in-flight call with RemotePluginError when the child exits unexpectedly", async () => {
    const file = writePluginScript(`
      const impl = {
        meta: { name: "echo", version: "1", kind: "secrets" },
        async configure() {},
        async issue() {
          // Block, then crash before responding so the host sees an in-flight exit.
          setTimeout(() => process.exit(1), 10);
          return new Promise(() => {});
        },
        async renew() { throw new Error("nr"); },
        async revoke() {},
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
    plugins.push(p);
    const err = await p.issue({ role: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(RemotePluginError);
    expect((err as Error).message).toMatch(/exited/);
  });

  it("close() drives the child through SIGTERM cleanly", async () => {
    const file = writePluginScript(`
      const impl = {
        meta: { name: "echo", version: "1", kind: "secrets" },
        async configure() {},
        async issue() { return { data: {}, leaseId: "x", ttlSeconds: 1, renewable: false }; },
        async renew() { throw new Error("nr"); },
        async revoke() {},
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
    plugins.push(p);
    await p.close();
    // Idempotent.
    await p.close();
  });

  it("rejects a spawn that does not produce a meta response", async () => {
    // Use a command that exits immediately (`node -e "process.exit(0)"`).
    await expect(
      RemoteSecretsPlugin.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        rpcTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/exited|timed out/);
  });

  it("verifies the runtime exists in dist (build prerequisite for the round-trip tests)", () => {
    // If this fires the developer needs to `pnpm --filter @arc/plugin-sdk build` first.
    // It's not strictly part of the protocol, but it's the cheapest signal that the test
    // setup is sane.
    const result = spawnSync(process.execPath, ["-e", `require("${join(process.cwd(), "dist", "runtime.cjs")}")`], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  /**
   * Regression for the env-leak CRIT: with `spec.env` undefined, Node's `child_process.spawn`
   * would inherit `process.env`, handing the child arc-server's `JWT_SECRET`, `BAO_TOKEN`,
   * `DATABASE_URL`, etc. The documented contract on `RemoteProcessSpec.env`
   * ("Environment vars merged on top of an *empty* env") requires the opposite — undefined
   * means empty, not inherit. This test asserts the host honors that contract by sneaking
   * a marker env var into the runner and asserting the child cannot see it.
   */
  it("does NOT inherit arc-server's env when spec.env is undefined (CRIT regression)", async () => {
    const marker = "ARC_TEST_LEAK_MARKER_DO_NOT_LEAK";
    const sentinel = `SENTINEL-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env[marker] = sentinel;
    try {
      // Plugin reflects what it sees of the marker var into its `meta.description`. If the
      // child inherits the parent's env it'll echo the sentinel back; if isolated it echoes
      // "<absent>".
      const file = writePluginScript(`
        const leaked = process.env["${marker}"];
        const impl = {
          meta: {
            name: "env-leak-probe",
            version: "1",
            kind: "secrets",
            description: leaked ? "leaked:" + leaked : "<absent>",
          },
          async configure() {},
          async issue() { return { data: {}, leaseId: "x", ttlSeconds: 1, renewable: false }; },
          async renew() { throw new Error("nr"); },
          async revoke() {},
        };
      `);
      // No env in spec → undefined → contract says empty env.
      const p = await RemoteSecretsPlugin.spawn({ command: process.execPath, args: [file] });
      plugins.push(p);
      expect(p.meta.description).toBe("<absent>");
      expect(p.meta.description).not.toContain(sentinel);
    } finally {
      delete process.env[marker];
    }
  });

  /**
   * Counterpart to the env-leak regression: an *explicit* env passthrough must reach the
   * child. Without this the security default would also break legitimate plugins that need
   * AWS_REGION etc.; this test pins the operator-opt-in path.
   */
  it("DOES pass through env vars an operator explicitly lists in spec.env", async () => {
    const file = writePluginScript(`
      const impl = {
        meta: {
          name: "env-passthrough-probe",
          version: "1",
          kind: "secrets",
          description: "got:" + (process.env.AWS_REGION ?? "<absent>"),
        },
        async configure() {},
        async issue() { return { data: {}, leaseId: "x", ttlSeconds: 1, renewable: false }; },
        async renew() { throw new Error("nr"); },
        async revoke() {},
      };
    `);
    const p = await RemoteSecretsPlugin.spawn({
      command: process.execPath,
      args: [file],
      env: { AWS_REGION: "us-west-2" },
    });
    plugins.push(p);
    expect(p.meta.description).toBe("got:us-west-2");
  });
});
