/**
 * Unit spec for the `ARC_PLUGIN_MOUNTS` env parser + file resolver. Boot-time auto-mount
 * itself is exercised in the e2e (`plugins.service.auto-mount.spec.ts`); this file just
 * pins the parsing contract since one bad entry must not sink the rest, malformed env
 * lines surface with a useful diagnostic, and the resolver fails loudly on unreadable
 * manifest/config files.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemoteProcessSpec,
  parsePluginMountsEnv,
  resolveMountFiles,
  type PluginMountSpec,
} from "./plugin-mounts";

describe("parsePluginMountsEnv", () => {
  it("returns empty for undefined / empty input", () => {
    expect(parsePluginMountsEnv(undefined)).toEqual({ specs: [], errors: [] });
    expect(parsePluginMountsEnv("")).toEqual({ specs: [], errors: [] });
    expect(parsePluginMountsEnv("   ")).toEqual({ specs: [], errors: [] });
  });

  it("parses a single bare entry into a normalized mount path", () => {
    const r = parsePluginMountsEnv("aws=/opt/arc/plugins/aws/bin.cjs");
    expect(r.errors).toEqual([]);
    expect(r.specs).toEqual<PluginMountSpec[]>([
      { mountPath: "aws/", artifactPath: "/opt/arc/plugins/aws/bin.cjs" },
    ]);
  });

  it("parses multiple comma-separated entries", () => {
    const r = parsePluginMountsEnv(
      "aws/=/a/bin.cjs?manifest=/a/manifest.json,github/=/g/bin.cjs?manifest=/g/manifest.json&config=/g/c.json",
    );
    expect(r.errors).toEqual([]);
    expect(r.specs).toEqual<PluginMountSpec[]>([
      { mountPath: "aws/", artifactPath: "/a/bin.cjs", manifestPath: "/a/manifest.json" },
      {
        mountPath: "github/",
        artifactPath: "/g/bin.cjs",
        manifestPath: "/g/manifest.json",
        configPath: "/g/c.json",
      },
    ]);
  });

  it("normalizes leading + trailing slashes on the mount path", () => {
    const r = parsePluginMountsEnv("/cloud-aws/=/x/bin.cjs");
    expect(r.specs[0]?.mountPath).toBe("cloud-aws/");
  });

  it("ignores unknown query params (forward-compat with v2 additions)", () => {
    const r = parsePluginMountsEnv("aws/=/x/bin?manifest=/m.json&future=ignored");
    expect(r.errors).toEqual([]);
    expect(r.specs[0]).toEqual({
      mountPath: "aws/",
      artifactPath: "/x/bin",
      manifestPath: "/m.json",
    });
  });

  it("records malformed entries without sinking the valid ones", () => {
    const r = parsePluginMountsEnv("aws/=/ok/bin.cjs,broken,github/=/g/bin.cjs");
    expect(r.specs.map((s) => s.mountPath)).toEqual(["aws/", "github/"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ entry: "broken", index: 1 });
    expect(r.errors[0]?.reason).toMatch(/expected/);
  });

  it("rejects empty mount path", () => {
    const r = parsePluginMountsEnv("=/x/bin.cjs");
    expect(r.errors).toHaveLength(1);
    expect(r.specs).toEqual([]);
  });

  it("rejects empty bin path", () => {
    const r = parsePluginMountsEnv("aws/=");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/missing bin path/);
  });
});

describe("resolveMountFiles", () => {
  it("returns config={} when configPath is unset and no manifest is given", async () => {
    const r = await resolveMountFiles({ mountPath: "x/", artifactPath: "/x/bin" });
    expect(r.manifest).toBeUndefined();
    expect(r.config).toEqual({});
  });

  it("reads + parses manifest + config JSON when both paths point at valid files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-mounts-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        claims: {
          v: 1,
          name: "x",
          version: "0.0.1",
          kind: "process",
          sha256: "0".repeat(64),
          publisher: "publisher:p",
          issuedAt: "2026-06-08T00:00:00.000Z",
        },
        signature: { alg: "Ed25519", sig: "AA" },
      }),
    );
    writeFileSync(join(dir, "config.json"), '{"region":"us-east-1"}');

    const r = await resolveMountFiles({
      mountPath: "x/",
      artifactPath: "/x/bin",
      manifestPath: join(dir, "manifest.json"),
      configPath: join(dir, "config.json"),
    });
    expect(r.manifest?.claims.name).toBe("x");
    expect(r.config).toEqual({ region: "us-east-1" });
  });

  it("throws a clear error when manifestPath is unreadable", async () => {
    await expect(
      resolveMountFiles({
        mountPath: "x/",
        artifactPath: "/x/bin",
        manifestPath: "/does/not/exist",
      }),
    ).rejects.toThrow(/manifest at \/does\/not\/exist unreadable/);
  });

  it("throws a clear error when manifestPath isn't valid JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-mounts-bad-"));
    writeFileSync(join(dir, "manifest.json"), "{not-json");
    await expect(
      resolveMountFiles({ mountPath: "x/", artifactPath: "/x/bin", manifestPath: join(dir, "manifest.json") }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws when configPath is unreadable", async () => {
    await expect(
      resolveMountFiles({
        mountPath: "x/",
        artifactPath: "/x/bin",
        configPath: "/does/not/exist",
      }),
    ).rejects.toThrow(/config at \/does\/not\/exist unreadable/);
  });
});

describe("buildRemoteProcessSpec", () => {
  it("maps the artifact path onto spec.command (operators chmod +x'd the bin at install)", () => {
    expect(buildRemoteProcessSpec({ mountPath: "x/", artifactPath: "/x/bin" })).toEqual({
      command: "/x/bin",
      args: [],
    });
  });
});
