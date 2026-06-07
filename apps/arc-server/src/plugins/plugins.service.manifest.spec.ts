/**
 * Plugin-manifest gate (ADR-005 Phase 5b) at the PluginsService boundary. Proves the
 * verifier short-circuits the mount path *before* spawn — a bad manifest never reaches
 * `RemoteSecretsPlugin.spawn`, so no child process is forked and no port/binary is touched.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import {
  generateSigningKeyPair,
  pluginArtifactDigest,
  signPluginManifest,
  toB64u,
} from "@arc/crypto";
import type { PluginManifestClaims, SignedPluginManifest } from "@arc/types";
import { type EnginesConfig } from "../engines/engines.service";
import { PluginManifestService } from "./plugin-manifest.service";
import { PluginsService } from "./plugins.service";

function writeFakeBinary(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-pm-int-"));
  const file = join(dir, "fake-binary");
  writeFileSync(file, bytes);
  return file;
}

function buildHarness(): { plugins: PluginsService } {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases };
  return { plugins: new PluginsService(config, new PluginManifestService()) };
}

function makeManifest(over: Partial<PluginManifestClaims> = {}): {
  manifest: SignedPluginManifest;
  pubB64u: string;
} {
  const k = generateSigningKeyPair();
  const claims: PluginManifestClaims = {
    v: 1,
    name: "arc-plugin-fake",
    version: "0.1.0",
    kind: "process",
    sha256: "0".repeat(64),
    publisher: "publisher:arc-core",
    issuedAt: "2026-06-07T00:00:00.000Z",
    ...over,
  };
  return { manifest: { claims, signature: signPluginManifest(k.priv, claims) }, pubB64u: toB64u(k.pub) };
}

describe("PluginsService — plugin manifest gate", () => {
  const saved = process.env.ARC_PLUGIN_TRUST_ANCHORS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ARC_PLUGIN_TRUST_ANCHORS;
    else process.env.ARC_PLUGIN_TRUST_ANCHORS = saved;
  });

  it("refuses to spawn an OOP plugin whose manifest names an untrusted publisher", async () => {
    delete process.env.ARC_PLUGIN_TRUST_ANCHORS; // no anchors → every publisher is untrusted
    const { plugins } = buildHarness();
    const cmd = writeFakeBinary(Buffer.from("real-bytes"));
    const { manifest } = makeManifest({ sha256: pluginArtifactDigest(Buffer.from("real-bytes")) });

    await expect(
      plugins.mountRemoteSecretsPlugin({ command: cmd, args: [], env: {} }, "fake/", {}, manifest),
    ).rejects.toMatchObject({ status: 400, response: { reason: "untrusted_publisher" } });
  });

  it("refuses to spawn an OOP plugin whose pinned sha256 doesn't match the executable bytes", async () => {
    const cmd = writeFakeBinary(Buffer.from("the-real-binary"));
    // Trust the publisher whose signature we attach, but lie about the hash.
    const { manifest, pubB64u } = makeManifest({ sha256: "1".repeat(64) });
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${pubB64u}`;
    const { plugins } = buildHarness();

    await expect(
      plugins.mountRemoteSecretsPlugin({ command: cmd, args: [], env: {} }, "fake/", {}, manifest),
    ).rejects.toMatchObject({ status: 400, response: { reason: "artifact_hash_mismatch" } });
  });

  it("refuses a wasm-kind manifest against a process mount (kind mismatch)", async () => {
    const cmd = writeFakeBinary(Buffer.from("p"));
    const { manifest, pubB64u } = makeManifest({
      kind: "wasm",
      sha256: pluginArtifactDigest(Buffer.from("p")),
    });
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${pubB64u}`;
    const { plugins } = buildHarness();

    await expect(
      plugins.mountRemoteSecretsPlugin({ command: cmd, args: [], env: {} }, "fake/", {}, manifest),
    ).rejects.toMatchObject({ status: 400, response: { reason: "kind_mismatch" } });
  });
});
