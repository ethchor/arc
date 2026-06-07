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
});
