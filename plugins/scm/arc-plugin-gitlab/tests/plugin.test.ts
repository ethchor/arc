import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabSecretsPlugin } from "../src/index";
import type {
  CreateProjectTokenInput,
  CreateProjectTokenOutput,
  GitLabClient,
} from "../src/index";

function fakeGl(impl?: {
  create?: (input: CreateProjectTokenInput) => CreateProjectTokenOutput;
  revoke?: (input: { projectId: string; tokenId: number }) => void;
}): GitLabClient & {
  createCalls: CreateProjectTokenInput[];
  revokeCalls: Array<{ projectId: string; tokenId: number }>;
} {
  const createCalls: CreateProjectTokenInput[] = [];
  const revokeCalls: Array<{ projectId: string; tokenId: number }> = [];
  let nextId = 100;
  return {
    createCalls,
    revokeCalls,
    createProjectToken: vi.fn(async (input: CreateProjectTokenInput) => {
      createCalls.push(input);
      if (impl?.create) return impl.create(input);
      const id = nextId++;
      return {
        token: `glpat-${id}-${input.name}`,
        expirationSeconds: 30 * 24 * 3600,
        tokenId: id,
      };
    }),
    revokeProjectToken: vi.fn(async (input) => {
      revokeCalls.push({ projectId: input.projectId, tokenId: input.tokenId });
      impl?.revoke?.({ projectId: input.projectId, tokenId: input.tokenId });
    }),
  };
}

const baseRole = {
  projectId: "1234",
  scopes: ["read_repository"],
  accessLevel: 20 as const,
};

describe("GitLabSecretsPlugin.configure", () => {
  it("rejects non-object input", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
  });

  it("requires adminToken + roles map", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await expect(p.configure({})).rejects.toThrow(/adminToken/);
    await expect(p.configure({ adminToken: "x" })).rejects.toThrow(/roles/);
    await expect(p.configure({ adminToken: "x", roles: {} })).rejects.toThrow(/at least one role/);
  });

  it("requires projectId + scopes + accessLevel per role", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await expect(
      p.configure({ adminToken: "x", roles: { r: { scopes: ["api"], accessLevel: 20 } } }),
    ).rejects.toThrow(/projectId/);
    await expect(
      p.configure({ adminToken: "x", roles: { r: { projectId: "1", accessLevel: 20 } } }),
    ).rejects.toThrow(/scopes/);
    await expect(
      p.configure({ adminToken: "x", roles: { r: { projectId: "1", scopes: ["api"] } } }),
    ).rejects.toThrow(/accessLevel must be 10\|20\|30\|40\|50/);
  });

  it("accepts a well-formed config + lists configuredRoles", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await p.configure({
      adminToken: "glpat-admin",
      apiBaseUrl: "https://gitlab.example.com",
      roles: {
        deploy: { ...baseRole, scopes: ["read_repository", "write_repository"], accessLevel: 40 },
        read: baseRole,
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["deploy", "read"]);
  });
});

describe("GitLabSecretsPlugin.issue", () => {
  let plugin: GitLabSecretsPlugin;
  let gl: ReturnType<typeof fakeGl>;

  beforeEach(async () => {
    gl = fakeGl();
    plugin = new GitLabSecretsPlugin(gl);
    await plugin.configure({
      adminToken: "glpat-admin",
      roles: {
        deploy: { projectId: "42", scopes: ["read_repository"], accessLevel: 30, namePrefix: "deployer" },
      },
    });
  });

  it("throws before configure()", async () => {
    const fresh = new GitLabSecretsPlugin(gl);
    await expect(fresh.issue({ role: "deploy" })).rejects.toThrow(/not configured/);
  });

  it("rejects an unknown role", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("passes projectId, scopes, accessLevel, and namePrefix through to GitLab", async () => {
    const issued = await plugin.issue({ role: "deploy" });
    expect(gl.createCalls).toHaveLength(1);
    expect(gl.createCalls[0]!.projectId).toBe("42");
    expect(gl.createCalls[0]!.scopes).toEqual(["read_repository"]);
    expect(gl.createCalls[0]!.accessLevel).toBe(30);
    expect(gl.createCalls[0]!.name).toMatch(/^deployer-\d+$/);
    expect(gl.createCalls[0]!.adminToken).toBe("glpat-admin");
    expect(issued.data.token).toMatch(/^glpat-/);
    expect(issued.data.project_id).toBe("42");
    expect(issued.data.access_level).toBe(30);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-gitlab\/deploy\/\d+$/);
  });

  it("supplies a default expires_at (30 days out) when the role omits one", async () => {
    await plugin.issue({ role: "deploy" });
    const expires = gl.createCalls[0]!.expiresAt;
    const days = Math.round((Date.parse(expires) - Date.now()) / (24 * 3600 * 1000));
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  it("uses the role's explicit expiresAt when configured", async () => {
    plugin = new GitLabSecretsPlugin(gl);
    await plugin.configure({
      adminToken: "x",
      roles: { r: { projectId: "1", scopes: ["api"], accessLevel: 20, expiresAt: "2027-01-01" } },
    });
    await plugin.issue({ role: "r" });
    expect(gl.createCalls.at(-1)!.expiresAt).toBe("2027-01-01");
  });

  it("surfaces GitLab's computed expirationSeconds on the lease", async () => {
    gl = fakeGl({
      create: (input) => ({
        token: `glpat-${input.name}`,
        expirationSeconds: 7200,
        tokenId: 999,
      }),
    });
    plugin = new GitLabSecretsPlugin(gl);
    await plugin.configure({
      adminToken: "x",
      roles: { r: { projectId: "1", scopes: ["api"], accessLevel: 20 } },
    });
    const issued = await plugin.issue({ role: "r" });
    expect(issued.ttlSeconds).toBe(7200);
  });
});

describe("GitLabSecretsPlugin.renew / revoke", () => {
  it("renew always throws", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await expect(p.renew("anything")).rejects.toThrow(/not renewable/);
  });

  it("revoke calls DELETE with the stored projectId + tokenId, then drops local tracking", async () => {
    const gl = fakeGl();
    const p = new GitLabSecretsPlugin(gl);
    await p.configure({
      adminToken: "x",
      roles: { r: { projectId: "9", scopes: ["api"], accessLevel: 20 } },
    });
    const issued = await p.issue({ role: "r" });
    await p.revoke(issued.leaseId);
    expect(gl.revokeCalls).toHaveLength(1);
    expect(gl.revokeCalls[0]!.projectId).toBe("9");
    expect(gl.revokeCalls[0]!.tokenId).toBeGreaterThan(0);
    await p.revoke(issued.leaseId); // idempotent — no second revoke call
    expect(gl.revokeCalls).toHaveLength(1);
  });

  it("revoke is a no-op when the plugin isn't configured (defensive)", async () => {
    const p = new GitLabSecretsPlugin(fakeGl());
    await expect(p.revoke("anything")).resolves.toBeUndefined();
  });
});
