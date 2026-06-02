import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwsSecretsPlugin, clampTtl } from "../src/index";
import type { StsAssumeRoleInput, StsAssumeRoleOutput, StsClient } from "../src/index";

function fakeSts(impl: (input: StsAssumeRoleInput) => StsAssumeRoleOutput): StsClient & {
  calls: StsAssumeRoleInput[];
} {
  const calls: StsAssumeRoleInput[] = [];
  return {
    calls,
    assumeRole: vi.fn(async (input: StsAssumeRoleInput) => {
      calls.push(input);
      return impl(input);
    }),
  };
}

function defaultStsResponse(input: StsAssumeRoleInput): StsAssumeRoleOutput {
  return {
    accessKeyId: `AKIA-${input.sessionName}`,
    secretAccessKey: "secret",
    sessionToken: `token-${input.sessionName}`,
    expirationSeconds: input.durationSeconds,
    assumedRoleArn: `arn:aws:sts::123456789012:assumed-role/${input.roleArn.split("/").pop()}/${input.sessionName}`,
  };
}

describe("AwsSecretsPlugin.configure", () => {
  it("rejects non-object input", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
    await expect(p.configure("oops")).rejects.toThrow(/must be an object/);
  });

  it("requires a roles map with at least one role", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await expect(p.configure({})).rejects.toThrow(/roles/);
    await expect(p.configure({ roles: {} })).rejects.toThrow(/at least one role/);
  });

  it("requires roleArn per role", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await expect(p.configure({ roles: { app: {} } })).rejects.toThrow(/roleArn is required/);
  });

  it("rejects defaultTtlSeconds > maxTtlSeconds (admin typo)", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await expect(
      p.configure({
        roles: {
          app: { roleArn: "arn:aws:iam::123:role/app", defaultTtlSeconds: 7200, maxTtlSeconds: 3600 },
        },
      }),
    ).rejects.toThrow(/defaultTtlSeconds > maxTtlSeconds/);
  });

  it("accepts a well-formed config and exposes configuredRoles", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await p.configure({
      region: "us-east-1",
      roles: {
        app: { roleArn: "arn:aws:iam::123:role/app" },
        deploy: { roleArn: "arn:aws:iam::123:role/deploy", defaultTtlSeconds: 1800 },
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["app", "deploy"]);
  });
});

describe("AwsSecretsPlugin.issue", () => {
  let plugin: AwsSecretsPlugin;
  let sts: ReturnType<typeof fakeSts>;
  beforeEach(async () => {
    sts = fakeSts(defaultStsResponse);
    plugin = new AwsSecretsPlugin(sts);
    await plugin.configure({
      roles: {
        app: { roleArn: "arn:aws:iam::123:role/app", defaultTtlSeconds: 1800 },
        deploy: { roleArn: "arn:aws:iam::123:role/deploy", maxTtlSeconds: 3600 },
        ext: { roleArn: "arn:aws:iam::123:role/ext", externalId: "secret-id" },
      },
    });
  });

  it("throws before configure() runs", async () => {
    const fresh = new AwsSecretsPlugin(sts);
    await expect(fresh.issue({ role: "app" })).rejects.toThrow(/not configured/);
  });

  it("rejects an unknown role (no silent default fall-through)", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("calls STS with the role's defaultTtl when caller omits ttlSeconds", async () => {
    const issued = await plugin.issue({ role: "app" });
    expect(sts.calls).toHaveLength(1);
    expect(sts.calls[0]!.durationSeconds).toBe(1800);
    expect(sts.calls[0]!.roleArn).toBe("arn:aws:iam::123:role/app");
    expect(issued.data.access_key).toMatch(/^AKIA-/);
    expect(issued.data.session_token).toMatch(/^token-/);
    expect(issued.data.assumed_role_arn).toMatch(/assumed-role\/app/);
    expect(issued.ttlSeconds).toBe(1800);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-aws\/app\//);
  });

  it("clamps caller TTL down to the role's maxTtlSeconds before hitting STS", async () => {
    await plugin.issue({ role: "deploy", ttlSeconds: 9999 });
    expect(sts.calls[0]!.durationSeconds).toBe(3600); // capped at role.maxTtlSeconds
  });

  it("passes externalId through to STS for cross-account roles", async () => {
    await plugin.issue({ role: "ext" });
    expect(sts.calls[0]!.externalId).toBe("secret-id");
  });

  it("uses STS's returned expiration as the lease TTL (not the requested duration)", async () => {
    // Real STS clamps to MaxSessionDuration; simulate that by returning a smaller window.
    sts = fakeSts((input) => ({
      ...defaultStsResponse(input),
      expirationSeconds: 600, // pretend MaxSessionDuration < requested
    }));
    plugin = new AwsSecretsPlugin(sts);
    await plugin.configure({
      roles: { app: { roleArn: "arn:aws:iam::123:role/app" } },
    });

    const issued = await plugin.issue({ role: "app", ttlSeconds: 3600 });
    expect(issued.ttlSeconds).toBe(600);
  });

  it("auto-generates a unique session name per issue (counter-based) when role has none", async () => {
    const a = await plugin.issue({ role: "app" });
    const b = await plugin.issue({ role: "app" });
    expect(a.leaseId).not.toBe(b.leaseId);
    expect(sts.calls[0]!.sessionName).not.toBe(sts.calls[1]!.sessionName);
  });
});

describe("AwsSecretsPlugin.renew", () => {
  it("always throws — STS credentials are not renewable", async () => {
    const p = new AwsSecretsPlugin(fakeSts(defaultStsResponse));
    await expect(p.renew("any-lease-id")).rejects.toThrow(/not renewable/);
  });
});

describe("AwsSecretsPlugin.revoke", () => {
  it("is a no-op at AWS but drops local lease tracking (idempotent)", async () => {
    const sts = fakeSts(defaultStsResponse);
    const p = new AwsSecretsPlugin(sts);
    await p.configure({ roles: { app: { roleArn: "arn:aws:iam::123:role/app" } } });
    const issued = await p.issue({ role: "app" });

    await p.revoke(issued.leaseId);
    // No additional STS calls (only the one from issue).
    expect(sts.calls).toHaveLength(1);
    // Idempotent: revoking again is fine.
    await p.revoke(issued.leaseId);
  });
});

describe("clampTtl", () => {
  const role = { roleArn: "x", defaultTtlSeconds: 1800, maxTtlSeconds: 3600 };

  it("uses defaultTtlSeconds when no request", () => {
    expect(clampTtl(undefined, role)).toBe(1800);
  });

  it("uses requested when within bounds", () => {
    expect(clampTtl(2400, role)).toBe(2400);
  });

  it("caps at role.maxTtlSeconds", () => {
    expect(clampTtl(7200, role)).toBe(3600);
  });

  it("clamps up to STS minimum (900s)", () => {
    expect(clampTtl(60, { roleArn: "x" })).toBe(900);
  });

  it("clamps down to STS maximum (43200s)", () => {
    expect(clampTtl(99999, { roleArn: "x" })).toBe(43200);
  });
});
