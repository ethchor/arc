/**
 * `arc-vault plugin install/verify` spec. Drives `runPluginCli` directly with a stubbed
 * `fetch` so the tests don't touch the network. The signing primitives come from the
 * real `@arc/plugin-sign` (no mocking) so a successful round-trip here proves the wire
 * shape arc-server would accept.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePublisherKey, signArtifact } from "@arc/plugin-sign";
import type { SignedPluginManifest } from "@arc/types";
import { runPluginCli, type PluginCliIO } from "../src/plugin-commands";

interface Captured {
  out: string[];
  err: string[];
  code: number;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "arc-plug-cli-"));
});
afterEach(() => {
  // OS GCs /tmp; no explicit cleanup.
});

/** Stub fetch that maps `url -> Uint8Array`. Anything not in the map returns 404. */
function stubFetch(map: Map<string, Uint8Array>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const bytes = map.get(url);
    if (!bytes) {
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } } as Response;
    }
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    } as Response;
  }) as typeof fetch;
}

async function run(
  argv: string[],
  extra: Partial<PluginCliIO> = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPluginCli(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
    ...extra,
  });
  return { out, err, code };
}

interface Fixture {
  binBytes: Uint8Array;
  manifestJson: string;
  manifest: SignedPluginManifest;
  pubB64u: string;
  privB64u: string;
}

async function makeFixture(over: { capabilities?: readonly string[] } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "arc-plug-fixture-"));
  const artifact = join(dir, "bin.cjs");
  writeFileSync(artifact, "#!/usr/bin/env node\nconsole.log('fake')\n");

  const key = generatePublisherKey();
  const manifest = await signArtifact({
    artifactPath: artifact,
    publisherPrivB64u: key.privB64u,
    publisher: "publisher:arc-core",
    name: "arc-plugin-fake",
    version: "0.1.0",
    kind: "process",
    ...(over.capabilities !== undefined ? { capabilities: over.capabilities } : { capabilities: ["read", "delete"] }),
    issuedAt: "2026-06-08T00:00:00.000Z",
  });

  return {
    binBytes: new Uint8Array(readFileSync(artifact)),
    manifestJson: JSON.stringify(manifest, null, 2),
    manifest,
    pubB64u: key.pubB64u,
    privB64u: key.privB64u,
  };
}

describe("arc-vault plugin install --from-dir", () => {
  it("verifies + lays the artifact down + prints the env snippet operators copy-paste", async () => {
    const fx = await makeFixture();
    // Pre-populate a "release dir" that --from-dir will read.
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);

    const dest = join(tmp, "installed");
    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", fx.pubB64u,
      "--out-dir", dest,
    ]);
    expect(r.code).toBe(0);
    const pluginDir = join(dest, "arc-plugin-fake");
    expect(existsSync(join(pluginDir, "bin.cjs"))).toBe(true);
    expect(existsSync(join(pluginDir, "manifest.json"))).toBe(true);
    expect(statSync(join(pluginDir, "bin.cjs")).mode & 0o111).not.toBe(0); // executable
    const joined = r.out.join("\n");
    expect(joined).toMatch(/installed arc-plugin-fake@0.1.0 to/);
    expect(joined).toMatch(/capabilities: \[read, delete\]/);
    expect(joined).toMatch(/ARC_PLUGIN_MOUNTS=fake\/=.*bin.cjs\?manifest=.*manifest.json/);
    expect(joined).toMatch(/ARC_PLUGIN_TRUST_ANCHORS=publisher:arc-core=/);
  });

  it("refuses with exit 2 + reason on tamper, leaves the files on disk for inspection", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    // Tamper the binary the operator was about to install.
    writeFileSync(join(src, "bin.cjs"), Buffer.concat([fx.binBytes, Buffer.from("// extra")]));
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);

    const dest = join(tmp, "installed");
    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", fx.pubB64u,
      "--out-dir", dest,
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/refused: artifact_hash_mismatch/);
    // Files were written before the refusal so the operator can inspect them.
    expect(existsSync(join(dest, "arc-plugin-fake", "bin.cjs"))).toBe(true);
  });

  it("refuses when verified against a different publisher pub key", async () => {
    const fx = await makeFixture();
    const stranger = generatePublisherKey();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);

    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", stranger.pubB64u,
      "--out-dir", join(tmp, "installed"),
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/refused: invalid_signature/);
  });

  it("respects --name and --mount-path overrides", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", fx.pubB64u,
      "--out-dir", join(tmp, "installed"),
      "--name", "aws",
      "--mount-path", "cloud-aws/",
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, "installed", "aws", "bin.cjs"))).toBe(true);
    expect(r.out.join("\n")).toMatch(/ARC_PLUGIN_MOUNTS=cloud-aws\/=.*aws\/bin.cjs/);
  });

  it("accepts --pub as a path to a file containing the b64u key", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const pubFile = join(tmp, "publisher.pub");
    writeFileSync(pubFile, fx.pubB64u + "\n");

    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", pubFile,
      "--out-dir", join(tmp, "installed"),
    ]);
    expect(r.code).toBe(0);
  });

  it("accepts --pub as a file containing the publisher:<id>=<b64u> anchor shape", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const anchorFile = join(tmp, "anchor.txt");
    writeFileSync(anchorFile, `publisher:arc-core=${fx.pubB64u}\n`);

    const r = await run([
      "install",
      "--from-dir", src,
      "--pub", anchorFile,
      "--out-dir", join(tmp, "installed"),
    ]);
    expect(r.code).toBe(0);
  });
});

describe("arc-vault plugin install --release (HTTP)", () => {
  it("fetches bin + manifest from the release URL prefix, verifies, installs", async () => {
    const fx = await makeFixture();
    const base = "https://example.test/releases/plugin-aws-v0.1.0/";
    const fetchMap = new Map<string, Uint8Array>([
      [base + "bin.cjs", fx.binBytes],
      [base + "manifest.json", new TextEncoder().encode(fx.manifestJson)],
    ]);

    const dest = join(tmp, "installed");
    const r = await run(
      ["install", "--release", base, "--pub", fx.pubB64u, "--out-dir", dest],
      { fetch: stubFetch(fetchMap) },
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(dest, "arc-plugin-fake", "bin.cjs"))).toBe(true);
  });

  it("auto-appends the trailing slash to --release if the operator omits it", async () => {
    const fx = await makeFixture();
    const base = "https://example.test/r/plugin-aws-v0.1.0";
    const fetchMap = new Map<string, Uint8Array>([
      [base + "/bin.cjs", fx.binBytes],
      [base + "/manifest.json", new TextEncoder().encode(fx.manifestJson)],
    ]);
    const r = await run(
      ["install", "--release", base, "--pub", fx.pubB64u, "--out-dir", join(tmp, "installed")],
      { fetch: stubFetch(fetchMap) },
    );
    expect(r.code).toBe(0);
  });

  it("surfaces a clean error when the release URL 404s on one of the files", async () => {
    const fx = await makeFixture();
    const base = "https://example.test/missing/";
    // Only the manifest exists; bin.cjs 404s.
    const fetchMap = new Map<string, Uint8Array>([
      [base + "manifest.json", new TextEncoder().encode(fx.manifestJson)],
    ]);
    const r = await run(
      ["install", "--release", base, "--pub", fx.pubB64u, "--out-dir", join(tmp, "installed")],
      { fetch: stubFetch(fetchMap) },
    );
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/HTTP 404/);
  });
});

describe("arc-vault plugin verify", () => {
  it("verifies a local bin + manifest against a pub key", async () => {
    const fx = await makeFixture();
    const bin = join(tmp, "bin.cjs");
    const manifest = join(tmp, "manifest.json");
    writeFileSync(bin, fx.binBytes);
    writeFileSync(manifest, fx.manifestJson);

    const r = await run([
      "verify",
      "--artifact", bin,
      "--manifest", manifest,
      "--pub", fx.pubB64u,
    ]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/ok: arc-plugin-fake@0.1.0/);
  });

  it("exits 2 (refused) when the manifest doesn't match the artifact", async () => {
    const fx = await makeFixture();
    const bin = join(tmp, "bin.cjs");
    const manifest = join(tmp, "manifest.json");
    writeFileSync(bin, Buffer.concat([fx.binBytes, Buffer.from("tampered")]));
    writeFileSync(manifest, fx.manifestJson);

    const r = await run([
      "verify",
      "--artifact", bin,
      "--manifest", manifest,
      "--pub", fx.pubB64u,
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/refused: artifact_hash_mismatch/);
  });
});

describe("arc-vault plugin <usage>", () => {
  it("unknown subcommand returns 1 with usage", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/unknown plugin command: frobnicate/);
  });

  it("--help returns 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/arc-vault plugin <command>/);
  });

  it("install --from-dir and --release are mutually exclusive", async () => {
    const r = await run([
      "install",
      "--from-dir", tmp,
      "--release", "https://x/",
      "--pub", "AAA",
      "--out-dir", tmp,
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/mutually exclusive/);
  });
});
