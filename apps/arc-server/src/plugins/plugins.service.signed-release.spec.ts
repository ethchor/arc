/**
 * End-to-end signed-release spec. Proves the entire plugin-distribution chain works in
 * the same shape an operator would use in production:
 *
 *   1. plugin author builds an artifact (here: a tiny Node script using
 *      `@arc/plugin-sdk/runtime`),
 *   2. publisher signs a manifest via `@arc/plugin-sign` pinning the artifact + the
 *      capability set,
 *   3. operator publishes the publisher pub key in `ARC_PLUGIN_TRUST_ANCHORS`,
 *   4. arc-server mounts the plugin via `mountRemoteSecretsPlugin`, re-hashes the
 *      artifact + verifies the signature against the anchor + pins the declared caps,
 *   5. dispatch enforces the gate at runtime.
 *
 * This is the only test in the suite that exercises every layer together; the unit
 * specs (`plugin-manifest.service.spec`, `plugins.service.manifest.spec`,
 * `plugins.service.capabilities.spec`) cover each in isolation.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { generatePublisherKey, signArtifact } from "@arc/plugin-sign";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";
import { PluginManifestService } from "./plugin-manifest.service";

const RUNTIME_CJS = join(__dirname, "../../../../packages/arc-plugin-sdk/dist/runtime.cjs");

/**
 * Build a self-contained executable plugin: a Node script with a shebang line so it can be
 * `spec.command` directly (no `node <script>` indirection), and `chmod +x` so the OS
 * actually runs it. That makes the bin file itself the artifact the manifest gate hashes —
 * the same shape an operator would distribute as the release tarball.
 */
function writePluginArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-signed-release-"));
  const file = join(dir, "arc-plugin-fake");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { runSecretsPlugin } = require("${RUNTIME_CJS}");
let counter = 0;
runSecretsPlugin({
  meta: { name: "arc-plugin-fake", version: "1.0.0", kind: "secrets", description: "signed release fixture" },
  async configure() {},
  async issue(req) {
    counter++;
    return {
      data: { token: "signed-" + req.role + "-" + counter },
      leaseId: "signed/" + req.role + "/" + counter,
      ttlSeconds: 120,
      renewable: true,
    };
  },
  async renew(leaseId) { return { leaseId, ttlSeconds: 240, renewable: true }; },
  async revoke() {},
});
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function buildHarness(): { plugins: PluginsService; engines: EnginesService } {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = {
    client: null,
    registry,
    enginesByMount,
    leases,
    manifestCapsByMount: new Map(),
  };
  return {
    engines: new EnginesService(config),
    plugins: new PluginsService(config, new PluginManifestService()),
  };
}

describe("PluginsService — signed release end-to-end", () => {
  const saved = process.env.ARC_PLUGIN_TRUST_ANCHORS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ARC_PLUGIN_TRUST_ANCHORS;
    else process.env.ARC_PLUGIN_TRUST_ANCHORS = saved;
  });

  it("publisher signs a manifest, operator pins the pub, server mounts + gates dispatch", async () => {
    const artifact = writePluginArtifact();
    const key = generatePublisherKey();
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;

    const manifest = await signArtifact({
      artifactPath: artifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "arc-plugin-fake",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read", "delete"], // intentionally omit `update` so renew gets refused
      issuedAt: "2026-06-08T00:00:00.000Z",
    });

    const { plugins, engines } = buildHarness();
    const mounted = await plugins.mountRemoteSecretsPlugin(
      { command: artifact, args: [] },
      "signed/",
      {},
      manifest,
    );
    expect(mounted.mount).toBe("signed/");

    // Declared `read` ⇒ creds issue works end-to-end.
    const issued = await engines.get("signed/creds/web", {});
    expect((issued.data as { token: string }).token).toBe("signed-web-1");
    const leaseId = issued.lease_id as string;

    // Declared `delete` ⇒ revoke works.
    await expect(engines.revokeLease(leaseId)).resolves.toBeUndefined();

    // Undeclared `update` ⇒ renew refused with the structured gate error.
    const second = await engines.get("signed/creds/web", {});
    await expect(engines.renewLease(second.lease_id as string)).rejects.toMatchObject({
      response: {
        reason: "plugin_capability_not_declared",
        capability: "update",
        mount: "signed/",
        declared: ["delete", "read"],
      },
    });

    await plugins.unmount("arc-plugin-fake");
  }, 20_000);

  it("refuses to mount when the artifact bytes were tampered after signing", async () => {
    const artifact = writePluginArtifact();
    const key = generatePublisherKey();
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;

    const manifest = await signArtifact({
      artifactPath: artifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "arc-plugin-fake",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });

    // Tamper the binary — append a harmless byte. The pinned SHA-256 no longer matches.
    writeFileSync(artifact, readFileSync(artifact) + "// tampered\n");

    const { plugins } = buildHarness();
    await expect(
      plugins.mountRemoteSecretsPlugin(
        { command: artifact, args: [] },
        "tampered/",
        {},
        manifest,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { reason: "artifact_hash_mismatch" },
    });
  }, 20_000);

  it("refuses to mount when the manifest names an unanchored publisher", async () => {
    const artifact = writePluginArtifact();
    const key = generatePublisherKey();
    // Intentionally pin a *different* anchor so this publisher is untrusted.
    const otherKey = generatePublisherKey();
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:rotated=${otherKey.pubB64u}`;

    const manifest = await signArtifact({
      artifactPath: artifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "arc-plugin-fake",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });

    const { plugins } = buildHarness();
    await expect(
      plugins.mountRemoteSecretsPlugin(
        { command: artifact, args: [] },
        "stranger/",
        {},
        manifest,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { reason: "untrusted_publisher" },
    });
  }, 20_000);
});
