import { beforeEach, describe, expect, it, vi } from "vitest";
import { GcpSecretsPlugin, clampTtl } from "../src/index";
import type {
  GenerateAccessTokenInput,
  GenerateAccessTokenOutput,
  IamCredentialsClient,
} from "../src/index";

function fakeIam(
  impl: (input: GenerateAccessTokenInput) => GenerateAccessTokenOutput,
): IamCredentialsClient & { calls: GenerateAccessTokenInput[] } {
  const calls: GenerateAccessTokenInput[] = [];
  return {
    calls,
    generateAccessToken: vi.fn(async (input: GenerateAccessTokenInput) => {
      calls.push(input);
      return impl(input);
    }),
  };
}

const defaultResponse = (input: GenerateAccessTokenInput): GenerateAccessTokenOutput => ({
  accessToken: `ya29.${input.targetServiceAccount}.${input.lifetimeSeconds}`,
  expirationSeconds: input.lifetimeSeconds,
});

describe("GcpSecretsPlugin.configure", () => {
  it("rejects non-object input", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
  });

  it("requires a roles map with at least one role", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await expect(p.configure({})).rejects.toThrow(/roles/);
    await expect(p.configure({ roles: {} })).rejects.toThrow(/at least one role/);
  });

  it("requires targetServiceAccount + non-empty scopes per role", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await expect(p.configure({ roles: { r: {} } })).rejects.toThrow(/targetServiceAccount/);
    await expect(
      p.configure({ roles: { r: { targetServiceAccount: "sa@p.iam.gserviceaccount.com" } } }),
    ).rejects.toThrow(/scopes must be a non-empty array/);
  });

  it("rejects defaultTtl > maxTtl (admin typo)", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await expect(
      p.configure({
        roles: {
          r: {
            targetServiceAccount: "sa@p.iam.gserviceaccount.com",
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            defaultTtlSeconds: 7200,
            maxTtlSeconds: 3600,
          },
        },
      }),
    ).rejects.toThrow(/defaultTtlSeconds > maxTtlSeconds/);
  });

  it("accepts a well-formed config + exposes configuredRoles", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await p.configure({
      project: "arc-test",
      roles: {
        deploy: {
          targetServiceAccount: "deploy@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          delegates: ["mid@arc.iam.gserviceaccount.com"],
        },
        read: {
          targetServiceAccount: "read@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
        },
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["deploy", "read"]);
  });
});

describe("GcpSecretsPlugin.issue", () => {
  let plugin: GcpSecretsPlugin;
  let iam: ReturnType<typeof fakeIam>;

  beforeEach(async () => {
    iam = fakeIam(defaultResponse);
    plugin = new GcpSecretsPlugin(iam);
    await plugin.configure({
      roles: {
        app: {
          targetServiceAccount: "app@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          defaultTtlSeconds: 1800,
        },
        capped: {
          targetServiceAccount: "capped@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
          maxTtlSeconds: 1800,
        },
        delegated: {
          targetServiceAccount: "leaf@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          delegates: ["mid@arc.iam.gserviceaccount.com"],
        },
      },
    });
  });

  it("throws before configure()", async () => {
    const fresh = new GcpSecretsPlugin(iam);
    await expect(fresh.issue({ role: "app" })).rejects.toThrow(/not configured/);
  });

  it("rejects an unknown role (no silent default)", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("calls IAM Credentials with the role's defaultTtl + scopes when caller omits ttl", async () => {
    const issued = await plugin.issue({ role: "app" });
    expect(iam.calls).toHaveLength(1);
    expect(iam.calls[0]!.lifetimeSeconds).toBe(1800);
    expect(iam.calls[0]!.targetServiceAccount).toBe("app@arc.iam.gserviceaccount.com");
    expect(iam.calls[0]!.scopes).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
    expect(iam.calls[0]!.delegates).toEqual([]);
    expect(issued.data.access_token).toMatch(/^ya29\./);
    expect(issued.data.target_service_account).toBe("app@arc.iam.gserviceaccount.com");
    expect(issued.ttlSeconds).toBe(1800);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-gcp\/app\/\d+$/);
  });

  it("clamps caller TTL down to role.maxTtlSeconds before hitting IAM Credentials", async () => {
    await plugin.issue({ role: "capped", ttlSeconds: 9999 });
    expect(iam.calls[0]!.lifetimeSeconds).toBe(1800);
  });

  it("passes the delegate chain through to IAM Credentials", async () => {
    await plugin.issue({ role: "delegated" });
    expect(iam.calls[0]!.delegates).toEqual(["mid@arc.iam.gserviceaccount.com"]);
  });

  it("surfaces IAM Credentials's returned expiration as the lease TTL", async () => {
    // Real GCP may clamp lifetime to 1h despite us asking for more.
    iam = fakeIam((input) => ({
      accessToken: `clamped-${input.lifetimeSeconds}`,
      expirationSeconds: 600,
    }));
    plugin = new GcpSecretsPlugin(iam);
    await plugin.configure({
      roles: {
        app: {
          targetServiceAccount: "app@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      },
    });
    const issued = await plugin.issue({ role: "app", ttlSeconds: 3600 });
    expect(issued.ttlSeconds).toBe(600);
  });

  it("generates a unique leaseId per issue (counter-based)", async () => {
    const a = await plugin.issue({ role: "app" });
    const b = await plugin.issue({ role: "app" });
    expect(a.leaseId).not.toBe(b.leaseId);
  });
});

describe("GcpSecretsPlugin.renew / revoke", () => {
  it("renew always throws", async () => {
    const p = new GcpSecretsPlugin(fakeIam(defaultResponse));
    await expect(p.renew("anything")).rejects.toThrow(/not renewable/);
  });

  it("revoke is no-op at GCP + drops local tracking + idempotent", async () => {
    const iam = fakeIam(defaultResponse);
    const p = new GcpSecretsPlugin(iam);
    await p.configure({
      roles: {
        app: {
          targetServiceAccount: "app@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      },
    });
    const issued = await p.issue({ role: "app" });
    await p.revoke(issued.leaseId);
    expect(iam.calls).toHaveLength(1); // no extra IAM call from revoke
    await p.revoke(issued.leaseId); // idempotent
  });
});

describe("clampTtl", () => {
  const role = {
    targetServiceAccount: "x",
    scopes: ["x"],
    defaultTtlSeconds: 1800,
    maxTtlSeconds: 3600,
  };

  it("uses defaultTtl when caller omits", () => {
    expect(clampTtl(undefined, role)).toBe(1800);
  });

  it("uses 3600s fallback when neither caller nor role specifies", () => {
    expect(clampTtl(undefined, { targetServiceAccount: "x", scopes: ["x"] })).toBe(3600);
  });

  it("caps at role.maxTtlSeconds", () => {
    expect(clampTtl(7200, role)).toBe(3600);
  });

  it("clamps to [1, 43200]", () => {
    expect(clampTtl(0, { targetServiceAccount: "x", scopes: ["x"] })).toBe(1);
    expect(clampTtl(99999, { targetServiceAccount: "x", scopes: ["x"] })).toBe(43200);
  });
});
