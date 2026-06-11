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

  it("parses env=K1:K2 (colon-separated) as an envPassthrough list", () => {
    // Colon-separator: comma is the outer entry separator, so an embedded comma would
    // smuggle one env name into the next mount entry.
    const r = parsePluginMountsEnv("aws/=/x/bin?env=AWS_REGION:AWS_PROFILE");
    expect(r.errors).toEqual([]);
    expect(r.specs[0]?.envPassthrough).toEqual(["AWS_REGION", "AWS_PROFILE"]);
  });

  it("parses env passthrough alongside manifest + config + a second mount entry", () => {
    const r = parsePluginMountsEnv(
      "aws/=/a/bin?manifest=/a/m.json&env=AWS_REGION:AWS_PROFILE,github/=/g/bin?config=/g/c.json",
    );
    expect(r.errors).toEqual([]);
    expect(r.specs).toHaveLength(2);
    expect(r.specs[0]).toMatchObject({
      mountPath: "aws/",
      manifestPath: "/a/m.json",
      envPassthrough: ["AWS_REGION", "AWS_PROFILE"],
    });
    expect(r.specs[1]).toMatchObject({ mountPath: "github/", configPath: "/g/c.json" });
    expect(r.specs[1]?.envPassthrough).toBeUndefined();
  });

  it("drops empty env tokens (env=A::B) without sinking the entry", () => {
    const r = parsePluginMountsEnv("aws/=/x/bin?env=A::B");
    expect(r.errors).toEqual([]);
    expect(r.specs[0]?.envPassthrough).toEqual(["A", "B"]);
  });

  it("rejects env names that aren't POSIX identifiers (refuses to smuggle = / ; / spaces)", () => {
    const r = parsePluginMountsEnv("aws/=/x/bin?env=GOOD:BAD=evil");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/invalid env-var name/);
  });

  it("omits envPassthrough when env= is absent (secure default)", () => {
    const r = parsePluginMountsEnv("aws/=/x/bin");
    expect(r.errors).toEqual([]);
    expect(r.specs[0]?.envPassthrough).toBeUndefined();
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
  it("maps the artifact path onto spec.command + forwards only PATH by default", () => {
    const spec = buildRemoteProcessSpec(
      { mountPath: "x/", artifactPath: "/x/bin" },
      { PATH: "/usr/bin" },
    );
    expect(spec).toEqual({ command: "/x/bin", args: [], env: { PATH: "/usr/bin" } });
  });

  // CRIT regression: without an explicit env on the spec, Node's spawn would inherit
  // arc-server's process.env (JWT_SECRET, BAO_TOKEN, DATABASE_URL, ARC_PUBLISHER_PRIV).
  it("does NOT forward arc-server secrets when envPassthrough is absent (CRIT regression)", () => {
    const fakeEnv = {
      JWT_SECRET: "must-not-leak",
      BAO_TOKEN: "root",
      DATABASE_URL: "postgres://secret",
      ARC_PUBLISHER_PRIV: "must-not-leak",
      PATH: "/usr/bin",
    };
    const spec = buildRemoteProcessSpec({ mountPath: "x/", artifactPath: "/x/bin" }, fakeEnv);
    // Only PATH is always-forwarded; nothing else crosses.
    expect(spec.env).toEqual({ PATH: "/usr/bin" });
    expect(spec.env).not.toHaveProperty("JWT_SECRET");
    expect(spec.env).not.toHaveProperty("BAO_TOKEN");
    expect(spec.env).not.toHaveProperty("DATABASE_URL");
    expect(spec.env).not.toHaveProperty("ARC_PUBLISHER_PRIV");
  });

  it("forwards only the env vars an operator listed in envPassthrough (plus PATH)", () => {
    const fakeEnv = {
      JWT_SECRET: "must-not-leak",
      BAO_TOKEN: "must-not-leak",
      AWS_REGION: "us-west-2",
      AWS_PROFILE: "prod",
      PATH: "/usr/bin",
    };
    const spec = buildRemoteProcessSpec(
      { mountPath: "x/", artifactPath: "/x/bin", envPassthrough: ["AWS_REGION", "AWS_PROFILE"] },
      fakeEnv,
    );
    expect(spec.env).toEqual({
      PATH: "/usr/bin",
      AWS_REGION: "us-west-2",
      AWS_PROFILE: "prod",
    });
    // Belt + suspenders: explicit assertions that server secrets did NOT cross.
    expect(spec.env).not.toHaveProperty("JWT_SECRET");
    expect(spec.env).not.toHaveProperty("BAO_TOKEN");
  });

  it("silently drops env-passthrough names that aren't set in the host env", () => {
    const spec = buildRemoteProcessSpec(
      { mountPath: "x/", artifactPath: "/x/bin", envPassthrough: ["AWS_REGION", "MISSING"] },
      { AWS_REGION: "us-east-1", PATH: "/usr/bin" },
    );
    expect(spec.env).toEqual({ AWS_REGION: "us-east-1", PATH: "/usr/bin" });
  });

  it("operator-listed envPassthrough cannot smuggle a secret by re-listing arc-server keys", () => {
    // An operator who tries to forward JWT_SECRET via envPassthrough succeeds — but that's
    // a *deliberate* operator action via the explicit allowlist, not an accidental leak
    // from undefined-env-default. The CRIT was the *implicit* inheritance; the explicit
    // path is the operator's call (and code review's catch).
    const spec = buildRemoteProcessSpec(
      { mountPath: "x/", artifactPath: "/x/bin", envPassthrough: ["JWT_SECRET"] },
      { JWT_SECRET: "operator-explicitly-allowed-this", PATH: "/usr/bin" },
    );
    expect(spec.env?.JWT_SECRET).toBe("operator-explicitly-allowed-this");
  });
});
