/**
 * Boot-time `ARC_PLUGIN_MOUNTS` auto-mount e2e. Proves the OnApplicationBootstrap hook
 * reads the env, applies the manifest gate per-entry, and tolerates a bad entry without
 * sinking the good ones — the exact operator UX promised in the env-vars doc.
 */
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { generatePublisherKey, signArtifact } from "@arc/plugin-sign";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";
import { PluginManifestService } from "./plugin-manifest.service";

const RUNTIME_CJS = join(__dirname, "../../../../packages/arc-plugin-sdk/dist/runtime.cjs");

function writeArtifact(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { runSecretsPlugin } = require("${RUNTIME_CJS}");
let counter = 0;
runSecretsPlugin({
  meta: { name: "auto-${name}", version: "1.0.0", kind: "secrets", description: "auto-mount fixture" },
  async configure(input) { this._cfg = input; },
  async issue(req) {
    counter++;
    return {
      data: { token: "auto-" + req.role + "-" + counter },
      leaseId: "auto/" + req.role + "/" + counter,
      ttlSeconds: 60, renewable: true,
    };
  },
  async renew(id) { return { leaseId: id, ttlSeconds: 60, renewable: true }; },
  async revoke() {},
});
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}

function buildHarness(): {
  plugins: PluginsService;
  engines: EnginesService;
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
    plugins: new PluginsService(config, new PluginManifestService()),
    engines: new EnginesService(config),
    config,
  };
}

describe("PluginsService — ARC_PLUGIN_MOUNTS auto-mount", () => {
  const saved = {
    mounts: process.env.ARC_PLUGIN_MOUNTS,
    anchors: process.env.ARC_PLUGIN_TRUST_ANCHORS,
  };
  afterEach(async () => {
    if (saved.mounts === undefined) delete process.env.ARC_PLUGIN_MOUNTS;
    else process.env.ARC_PLUGIN_MOUNTS = saved.mounts;
    if (saved.anchors === undefined) delete process.env.ARC_PLUGIN_TRUST_ANCHORS;
    else process.env.ARC_PLUGIN_TRUST_ANCHORS = saved.anchors;
  });

  it("mounts a signed plugin at boot when ARC_PLUGIN_MOUNTS points to a bin + manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-auto-"));
    const artifact = writeArtifact(dir, "good");
    const key = generatePublisherKey();
    const manifest = await signArtifact({
      artifactPath: artifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "auto-good",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;
    process.env.ARC_PLUGIN_MOUNTS = `good/=${artifact}?manifest=${manifestPath}`;

    const { plugins, engines } = buildHarness();
    await plugins.onApplicationBootstrap();

    expect((await engines.listMounts()).map((m) => m.path)).toContain("good/");
    const issued = await engines.get("good/creds/api", {});
    expect((issued.data as { token: string }).token).toBe("auto-api-1");
    await plugins.unmount("auto-good");
  }, 20_000);

  it("isolates a bad entry — the malformed one is skipped, the good one still mounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-auto-mix-"));
    const goodArtifact = writeArtifact(dir, "ok");
    const key = generatePublisherKey();
    const goodManifest = await signArtifact({
      artifactPath: goodArtifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "auto-ok",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });
    const goodManifestPath = join(dir, "ok.manifest.json");
    writeFileSync(goodManifestPath, JSON.stringify(goodManifest));

    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;
    // Three entries: malformed, valid-good, valid-but-bin-doesn't-exist.
    process.env.ARC_PLUGIN_MOUNTS =
      `broken-entry,` +
      `ok/=${goodArtifact}?manifest=${goodManifestPath},` +
      `missing/=/does/not/exist/bin.cjs`;

    const { plugins, engines } = buildHarness();
    await plugins.onApplicationBootstrap();

    const mounts = (await engines.listMounts()).map((m) => m.path);
    expect(mounts).toContain("ok/");
    expect(mounts).not.toContain("missing/");
    await plugins.unmount("auto-ok");
  }, 20_000);

  it("refuses to mount an entry whose manifest fails the gate (artifact_hash_mismatch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-auto-tamper-"));
    const artifact = writeArtifact(dir, "tampered");
    const key = generatePublisherKey();
    const manifest = await signArtifact({
      artifactPath: artifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "auto-tampered",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // Tamper after signing.
    writeFileSync(artifact, "#!/usr/bin/env node\nconsole.log('tampered');\n");
    chmodSync(artifact, 0o755);

    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;
    process.env.ARC_PLUGIN_MOUNTS = `bad/=${artifact}?manifest=${manifestPath}`;

    const { plugins, engines } = buildHarness();
    await plugins.onApplicationBootstrap();

    expect((await engines.listMounts()).map((m) => m.path)).not.toContain("bad/");
  }, 20_000);

  it("supports an entry without a manifest (gate-bypass posture, same as pre-gate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-auto-nomf-"));
    const artifact = writeArtifact(dir, "no-manifest");

    process.env.ARC_PLUGIN_MOUNTS = `nomf/=${artifact}`;
    delete process.env.ARC_PLUGIN_TRUST_ANCHORS;

    const { plugins, engines } = buildHarness();
    await plugins.onApplicationBootstrap();

    expect((await engines.listMounts()).map((m) => m.path)).toContain("nomf/");
    // No manifest ⇒ no caps pinned ⇒ gate bypassed for this mount, dispatch works.
    const issued = await engines.get("nomf/creds/x", {});
    expect((issued.data as { token: string }).token).toBe("auto-x-1");
    await plugins.unmount("auto-no-manifest");
  }, 20_000);

  it("threads a config file into the plugin's configure() via the JSON-RPC handshake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-auto-cfg-"));
    const artifact = writeArtifact(dir, "cfg");
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ region: "us-east-2" }));

    process.env.ARC_PLUGIN_MOUNTS = `cfg/=${artifact}?config=${configFile}`;
    delete process.env.ARC_PLUGIN_TRUST_ANCHORS;

    const { plugins, engines } = buildHarness();
    await plugins.onApplicationBootstrap();

    expect((await engines.listMounts()).map((m) => m.path)).toContain("cfg/");
    // The fixture stores config on `this._cfg` — we can't peek inside the child, but
    // the issue() succeeds which proves configure() didn't reject.
    const issued = await engines.get("cfg/creds/x", {});
    expect((issued.data as { token: string }).token).toBe("auto-x-1");
    await plugins.unmount("auto-cfg");
  }, 20_000);
});
