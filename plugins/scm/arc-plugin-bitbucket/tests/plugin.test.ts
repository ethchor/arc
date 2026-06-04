import { beforeEach, describe, expect, it, vi } from "vitest";
import { BitbucketSecretsPlugin } from "../src/index";
import type {
  BitbucketClient,
  CreateRepoTokenInput,
  CreateRepoTokenOutput,
} from "../src/index";

interface RevokeCall {
  workspace: string;
  repoSlug: string;
  tokenUuid: string;
}

function fakeBb(): BitbucketClient & {
  createCalls: CreateRepoTokenInput[];
  revokeCalls: RevokeCall[];
} {
  const createCalls: CreateRepoTokenInput[] = [];
  const revokeCalls: RevokeCall[] = [];
  let nextUuid = 0;
  return {
    createCalls,
    revokeCalls,
    createRepoToken: vi.fn(async (input: CreateRepoTokenInput): Promise<CreateRepoTokenOutput> => {
      createCalls.push(input);
      nextUuid++;
      return { token: `BBAT-${nextUuid}-${input.name}`, tokenUuid: `{uuid-${nextUuid}}` };
    }),
    revokeRepoToken: vi.fn(async (input) => {
      revokeCalls.push({
        workspace: input.workspace,
        repoSlug: input.repoSlug,
        tokenUuid: input.tokenUuid,
      });
    }),
  };
}

const baseRole = {
  workspace: "acme",
  repoSlug: "platform",
  scopes: ["repository:read"],
};

describe("BitbucketSecretsPlugin.configure", () => {
  it("rejects non-object input + missing adminToken / roles", async () => {
    const p = new BitbucketSecretsPlugin(fakeBb());
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
    await expect(p.configure({})).rejects.toThrow(/adminToken/);
    await expect(p.configure({ adminToken: "x" })).rejects.toThrow(/roles/);
    await expect(p.configure({ adminToken: "x", roles: {} })).rejects.toThrow(/at least one role/);
  });

  it("requires workspace + repoSlug + non-empty scopes per role", async () => {
    const p = new BitbucketSecretsPlugin(fakeBb());
    await expect(
      p.configure({ adminToken: "x", roles: { r: { repoSlug: "p", scopes: ["s"] } } }),
    ).rejects.toThrow(/workspace is required/);
    await expect(
      p.configure({ adminToken: "x", roles: { r: { workspace: "w", scopes: ["s"] } } }),
    ).rejects.toThrow(/repoSlug is required/);
    await expect(
      p.configure({ adminToken: "x", roles: { r: { workspace: "w", repoSlug: "p" } } }),
    ).rejects.toThrow(/scopes/);
  });

  it("accepts a well-formed config + lists configuredRoles", async () => {
    const p = new BitbucketSecretsPlugin(fakeBb());
    await p.configure({
      adminToken: "BBA-admin",
      apiBaseUrl: "https://bitbucket.acme.example.com",
      roles: {
        read: baseRole,
        write: { ...baseRole, scopes: ["repository:write"], ttlSeconds: 86400 },
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["read", "write"]);
  });
});

describe("BitbucketSecretsPlugin.issue", () => {
  let plugin: BitbucketSecretsPlugin;
  let bb: ReturnType<typeof fakeBb>;

  beforeEach(async () => {
    bb = fakeBb();
    plugin = new BitbucketSecretsPlugin(bb);
    await plugin.configure({
      adminToken: "BBA-admin",
      roles: {
        deploy: { ...baseRole, namePrefix: "deployer", ttlSeconds: 3600 },
      },
    });
  });

  it("throws before configure()", async () => {
    const fresh = new BitbucketSecretsPlugin(bb);
    await expect(fresh.issue({ role: "deploy" })).rejects.toThrow(/not configured/);
  });

  it("rejects unknown role", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("passes workspace / repoSlug / scopes / namePrefix through; surfaces ttlSeconds on the lease", async () => {
    const issued = await plugin.issue({ role: "deploy" });
    expect(bb.createCalls).toHaveLength(1);
    expect(bb.createCalls[0]!.workspace).toBe("acme");
    expect(bb.createCalls[0]!.repoSlug).toBe("platform");
    expect(bb.createCalls[0]!.scopes).toEqual(["repository:read"]);
    expect(bb.createCalls[0]!.name).toMatch(/^deployer-\d+$/);
    expect(bb.createCalls[0]!.adminToken).toBe("BBA-admin");
    expect(issued.data.token).toMatch(/^BBAT-/);
    expect(issued.data.workspace).toBe("acme");
    expect(issued.data.token_uuid).toMatch(/^\{uuid-/);
    expect(issued.ttlSeconds).toBe(3600);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-bitbucket\/deploy\/\{uuid-/);
  });

  it("falls back to the 7-day default ttl when the role omits ttlSeconds", async () => {
    plugin = new BitbucketSecretsPlugin(bb);
    await plugin.configure({ adminToken: "x", roles: { r: baseRole } });
    const issued = await plugin.issue({ role: "r" });
    expect(issued.ttlSeconds).toBe(7 * 24 * 3600);
  });
});

describe("BitbucketSecretsPlugin.renew / revoke", () => {
  it("renew always throws", async () => {
    const p = new BitbucketSecretsPlugin(fakeBb());
    await expect(p.renew("anything")).rejects.toThrow(/not renewable/);
  });

  it("revoke calls DELETE with the stored uuid + drops tracking", async () => {
    const bb = fakeBb();
    const p = new BitbucketSecretsPlugin(bb);
    await p.configure({ adminToken: "x", roles: { r: baseRole } });
    const issued = await p.issue({ role: "r" });
    await p.revoke(issued.leaseId);
    expect(bb.revokeCalls).toHaveLength(1);
    expect(bb.revokeCalls[0]!.workspace).toBe("acme");
    expect(bb.revokeCalls[0]!.repoSlug).toBe("platform");
    expect(bb.revokeCalls[0]!.tokenUuid).toMatch(/^\{uuid-/);
    await p.revoke(issued.leaseId); // idempotent
    expect(bb.revokeCalls).toHaveLength(1);
  });
});
