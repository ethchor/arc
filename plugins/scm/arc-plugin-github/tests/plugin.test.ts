import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAppPlugin } from "../src/index";
import type {
  CreateInstallationTokenInput,
  CreateInstallationTokenOutput,
  GitHubAppClient,
} from "../src/index";

function fakeGh(
  impl: (input: CreateInstallationTokenInput) => CreateInstallationTokenOutput,
): GitHubAppClient & { calls: CreateInstallationTokenInput[] } {
  const calls: CreateInstallationTokenInput[] = [];
  return {
    calls,
    createInstallationToken: vi.fn(async (input: CreateInstallationTokenInput) => {
      calls.push(input);
      return impl(input);
    }),
  };
}

const defaultResponse = (input: CreateInstallationTokenInput): CreateInstallationTokenOutput => ({
  token: `ghs_install_${input.installationId}`,
  expirationSeconds: 3600,
  permissions: input.permissions
    ? Object.fromEntries(Object.entries(input.permissions))
    : { contents: "read" },
  repositorySelection: input.repositories ? "selected" : "all",
});

// Minimal stub PEM — only required because the config validator checks for a non-empty
// string; the plugin itself doesn't sign anything (the injected client does, in prod).
const STUB_PEM = "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n";

describe("GitHubAppPlugin.configure", () => {
  it("rejects non-object input", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
  });

  it("requires appId, privateKeyPem, and a roles map", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await expect(p.configure({})).rejects.toThrow(/appId/);
    await expect(p.configure({ appId: 1 })).rejects.toThrow(/privateKeyPem/);
    await expect(p.configure({ appId: 1, privateKeyPem: STUB_PEM })).rejects.toThrow(/roles/);
    await expect(
      p.configure({ appId: 1, privateKeyPem: STUB_PEM, roles: {} }),
    ).rejects.toThrow(/at least one role/);
  });

  it("requires positive integer installationId per role", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await expect(
      p.configure({ appId: 1, privateKeyPem: STUB_PEM, roles: { r: {} } }),
    ).rejects.toThrow(/installationId/);
    await expect(
      p.configure({ appId: 1, privateKeyPem: STUB_PEM, roles: { r: { installationId: -5 } } }),
    ).rejects.toThrow(/installationId/);
  });

  it("validates permission verbs (read|write|admin only)", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await expect(
      p.configure({
        appId: 1,
        privateKeyPem: STUB_PEM,
        roles: { r: { installationId: 1, permissions: { contents: "frobnicate" } } },
      }),
    ).rejects.toThrow(/permissions\.contents must be read\|write\|admin/);
  });

  it("accepts a well-formed config + exposes configuredRoles", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await p.configure({
      appId: 12345,
      privateKeyPem: STUB_PEM,
      apiBaseUrl: "https://github.example.com/api/v3",
      roles: {
        deploy: {
          installationId: 1,
          repositories: ["acme/api", "acme/web"],
          permissions: { contents: "read", actions: "write" },
        },
        read: {
          installationId: 2,
          permissions: { contents: "read" },
        },
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["deploy", "read"]);
  });
});

describe("GitHubAppPlugin.issue", () => {
  let plugin: GitHubAppPlugin;
  let gh: ReturnType<typeof fakeGh>;

  beforeEach(async () => {
    gh = fakeGh(defaultResponse);
    plugin = new GitHubAppPlugin(gh);
    await plugin.configure({
      appId: 99,
      privateKeyPem: STUB_PEM,
      roles: {
        deploy: {
          installationId: 555,
          repositories: ["acme/api"],
          permissions: { contents: "write" },
        },
        read: {
          installationId: 777,
        },
      },
    });
  });

  it("throws before configure()", async () => {
    const fresh = new GitHubAppPlugin(gh);
    await expect(fresh.issue({ role: "deploy" })).rejects.toThrow(/not configured/);
  });

  it("rejects an unknown role", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("passes the role's installationId, repositories, and permissions through to GitHub", async () => {
    const issued = await plugin.issue({ role: "deploy" });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.installationId).toBe(555);
    expect(gh.calls[0]!.repositories).toEqual(["acme/api"]);
    expect(gh.calls[0]!.permissions).toEqual({ contents: "write" });
    expect(issued.data.token).toMatch(/^ghs_install_555$/);
    expect(issued.data.installation_id).toBe(555);
    expect(issued.data.permissions).toBeDefined();
    expect(issued.data.repository_selection).toBe("selected");
    expect(issued.ttlSeconds).toBe(3600);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-github\/deploy\/\d+$/);
  });

  it("a role without repos/permissions sends none and gets `all` selection back", async () => {
    const issued = await plugin.issue({ role: "read" });
    expect(gh.calls[0]!.repositories).toBeUndefined();
    expect(gh.calls[0]!.permissions).toBeUndefined();
    expect(issued.data.repository_selection).toBe("all");
  });

  it("surfaces GitHub's reported expiration as the lease TTL (not a hardcoded 3600)", async () => {
    // Pretend GitHub returned a clock-skewed expiration that's only 1700s in the future.
    gh = fakeGh(() => ({ token: "ghs_x", expirationSeconds: 1700 }));
    plugin = new GitHubAppPlugin(gh);
    await plugin.configure({
      appId: 1,
      privateKeyPem: STUB_PEM,
      roles: { x: { installationId: 1 } },
    });
    const issued = await plugin.issue({ role: "x" });
    expect(issued.ttlSeconds).toBe(1700);
  });

  it("generates a unique leaseId per issue", async () => {
    const a = await plugin.issue({ role: "deploy" });
    const b = await plugin.issue({ role: "deploy" });
    expect(a.leaseId).not.toBe(b.leaseId);
  });
});

describe("GitHubAppPlugin.renew / revoke", () => {
  it("renew always throws", async () => {
    const p = new GitHubAppPlugin(fakeGh(defaultResponse));
    await expect(p.renew("anything")).rejects.toThrow(/not renewable/);
  });

  it("revoke is a no-op at GitHub + drops local tracking + idempotent", async () => {
    const gh = fakeGh(defaultResponse);
    const p = new GitHubAppPlugin(gh);
    await p.configure({
      appId: 1,
      privateKeyPem: STUB_PEM,
      roles: { r: { installationId: 1 } },
    });
    const issued = await p.issue({ role: "r" });
    await p.revoke(issued.leaseId);
    expect(gh.calls).toHaveLength(1);
    await p.revoke(issued.leaseId); // idempotent
  });
});
