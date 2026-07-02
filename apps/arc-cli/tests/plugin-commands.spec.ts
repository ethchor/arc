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

/** List a dir, tolerating "doesn't exist" (returns []). Used to assert refusals write nothing. */
function readdirSyncSafe(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("node:fs").readdirSync(dir) as string[]).filter((n) => !n.startsWith(".staging-"));
  } catch {
    return [];
  }
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
      `--pub=${fx.pubB64u}`,
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

  it("refuses with exit 2 on tamper and writes NOTHING to the plugin dir (verify-before-install)", async () => {
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
      `--pub=${fx.pubB64u}`,
      "--out-dir", dest,
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/refused: artifact_hash_mismatch/);
    // The unverified artifact is staged + verified, never written to the live plugin path;
    // a refusal cleans the staging dir, so nothing persists under out-dir.
    expect(existsSync(join(dest, "arc-plugin-fake"))).toBe(false);
    expect(readdirSyncSafe(dest)).toEqual([]);
  });

  it("refuses a manifest whose name escapes --out-dir (path traversal) and writes nothing", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    // Malicious/MITM'd release: manifest claims a traversal name. We must refuse purely on
    // the name, before writing anything (signature would fail too, but that's not the gate).
    const evil = { ...fx.manifest, claims: { ...fx.manifest.claims, name: "../../pwned" } };
    writeFileSync(join(src, "manifest.json"), JSON.stringify(evil));

    const dest = join(tmp, "installed");
    const r = await run(["install", "--from-dir", src, `--pub=${fx.pubB64u}`, "--out-dir", dest]);
    expect(r.code).toBe(1); // thrown → runPluginCli maps to exit 1
    expect(r.err.join("\n")).toMatch(/unsafe plugin name/);
    // Nothing was written outside (or inside) out-dir.
    expect(existsSync(join(tmp, "pwned"))).toBe(false);
    expect(existsSync(dest) ? readdirSyncSafe(dest) : []).toEqual([]);
  });

  it("refuses an operator-supplied --name that traverses", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const r = await run([
      "install", "--from-dir", src, `--pub=${fx.pubB64u}`,
      "--out-dir", join(tmp, "installed"), "--name", "../escape",
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/unsafe plugin name/);
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
      `--pub=${stranger.pubB64u}`,
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
      `--pub=${fx.pubB64u}`,
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
      ["install", "--release", base, `--pub=${fx.pubB64u}`, "--out-dir", dest],
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
      ["install", "--release", base, `--pub=${fx.pubB64u}`, "--out-dir", join(tmp, "installed")],
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
      ["install", "--release", base, `--pub=${fx.pubB64u}`, "--out-dir", join(tmp, "installed")],
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
      `--pub=${fx.pubB64u}`,
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
      `--pub=${fx.pubB64u}`,
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

describe("arc-vault plugin install --cosign-bundle", () => {
  it("accepts when the cosign verifier returns ok=true", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const bundlePath = join(src, "bin.cjs.bundle");
    writeFileSync(bundlePath, Buffer.from("synthetic cosign bundle bytes"));

    let verifierSawArgs: { identityRegexp: string; issuer: string } | null = null;
    const r = await run(
      [
        "install",
        "--from-dir", src,
        `--pub=${fx.pubB64u}`,
        "--out-dir", join(tmp, "installed"),
        "--cosign-bundle", bundlePath,
        "--cosign-identity", "^https://github.com/ethchor/arc/.github/workflows/release-plugin-.*",
        "--cosign-issuer", "https://token.actions.githubusercontent.com",
      ],
      {
        cosignVerify: async (args) => {
          verifierSawArgs = { identityRegexp: args.identityRegexp, issuer: args.issuer };
          return { ok: true, stderr: "" };
        },
      },
    );
    expect(r.code).toBe(0);
    expect(verifierSawArgs!.identityRegexp).toMatch(/release-plugin-/);
    expect(verifierSawArgs!.issuer).toBe("https://token.actions.githubusercontent.com");
    expect(r.out.join("\n")).toMatch(/cosign keyless: verified/);
  });

  it("refuses install with exit 2 when cosign rejects, leaves files on disk for inspection", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const bundlePath = join(src, "bin.cjs.bundle");
    writeFileSync(bundlePath, Buffer.from("tampered bundle"));

    const r = await run(
      [
        "install",
        "--from-dir", src,
        `--pub=${fx.pubB64u}`,
        "--out-dir", join(tmp, "installed"),
        "--cosign-bundle", bundlePath,
        "--cosign-identity", "^https://github.com/.*",
      ],
      {
        cosignVerify: async () => ({
          ok: false,
          stderr: "Error: no matching signatures: identity not in certificate identities",
        }),
      },
    );
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/cosign verify-blob rejected the bundle/);
    expect(r.err.join("\n")).toMatch(/identity not in certificate identities/);
    // A cosign refusal (like a signature refusal) installs nothing — the artifact was only
    // ever staged, and the staging dir is cleaned up.
    expect(existsSync(join(tmp, "installed", "arc-plugin-fake"))).toBe(false);
  });

  it("refuses install with exit 2 + actionable error when cosign is not on PATH", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    writeFileSync(join(src, "bin.cjs.bundle"), Buffer.from("x"));

    const r = await run(
      [
        "install",
        "--from-dir", src,
        `--pub=${fx.pubB64u}`,
        "--out-dir", join(tmp, "installed"),
        "--cosign-bundle", join(src, "bin.cjs.bundle"),
        "--cosign-identity", "^https://github.com/.*",
      ],
      { cosignVerify: async () => null },
    );
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/cosign.*is not on PATH/);
  });

  it("usage error when --cosign-bundle is set without --cosign-identity", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    writeFileSync(join(src, "bin.cjs.bundle"), Buffer.from("x"));

    const r = await run([
      "install",
      "--from-dir", src,
      `--pub=${fx.pubB64u}`,
      "--out-dir", join(tmp, "installed"),
      "--cosign-bundle", join(src, "bin.cjs.bundle"),
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/--cosign-bundle requires --cosign-identity/);
  });
});

describe("arc-vault plugin uninstall", () => {
  it("removes a previously installed plugin and prints the env-var snippet to remove", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const outDir = join(tmp, "installed");

    // Install first so we have a real on-disk layout to uninstall.
    const inst = await run([
      "install",
      "--from-dir", src,
      `--pub=${fx.pubB64u}`,
      "--out-dir", outDir,
    ]);
    expect(inst.code).toBe(0);
    expect(existsSync(join(outDir, "arc-plugin-fake", "bin.cjs"))).toBe(true);

    const u = await run([
      "uninstall",
      "--name", "arc-plugin-fake",
      "--out-dir", outDir,
    ]);
    expect(u.code).toBe(0);
    expect(u.out.join("\n")).toMatch(/uninstalled arc-plugin-fake@0\.1\.0/);
    expect(u.out.join("\n")).toMatch(/publisher: publisher:arc-core/);
    expect(u.out.join("\n")).toMatch(/fake\/=.*\?manifest=/);
    // Files gone
    expect(existsSync(join(outDir, "arc-plugin-fake"))).toBe(false);
  });

  it("refuses to wipe a directory that doesn't look like an arc-installed plugin", async () => {
    const outDir = join(tmp, "weird");
    const pluginDir = join(outDir, "rando");
    require("node:fs").mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "important-data.txt"), "I am not a plugin");

    const r = await run([
      "uninstall",
      "--name", "rando",
      "--out-dir", outDir,
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/does not look like an installed plugin/);
    // The user's file is still safe.
    expect(existsSync(join(pluginDir, "important-data.txt"))).toBe(true);
  });

  it("--yes overrides the refusal and force-deletes the directory", async () => {
    const outDir = join(tmp, "force");
    const pluginDir = join(outDir, "rando");
    require("node:fs").mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "data.txt"), "x");

    const r = await run([
      "uninstall",
      "--name", "rando",
      "--out-dir", outDir,
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(pluginDir)).toBe(false);
  });

  it("prints the admin-API DELETE recipe for live-mounted plugins", async () => {
    const fx = await makeFixture();
    const src = join(tmp, "release");
    require("node:fs").mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "bin.cjs"), fx.binBytes);
    writeFileSync(join(src, "manifest.json"), fx.manifestJson);
    const outDir = join(tmp, "installed");

    await run([
      "install", "--from-dir", src, `--pub=${fx.pubB64u}`, "--out-dir", outDir,
    ]);

    const u = await run([
      "uninstall", "--name", "arc-plugin-fake", "--out-dir", outDir,
    ]);
    // Mount path encoded — `fake/` → `fake%2F`. `[\s\S]*` because the CLI wraps the
    // `curl -X DELETE \\` onto a second line.
    expect(u.out.join("\n")).toMatch(/DELETE[\s\S]*\/v1\/sys\/plugins\/mounts\/fake%2F/);
  });

  it("usage error when --name is missing", async () => {
    const r = await run(["uninstall", "--out-dir", tmp]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/missing required --name/);
  });
});
