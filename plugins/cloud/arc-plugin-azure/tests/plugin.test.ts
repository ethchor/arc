import { beforeEach, describe, expect, it, vi } from "vitest";
import { AzureSecretsPlugin } from "../src/index";
import type {
  AcquireTokenInput,
  AcquireTokenOutput,
  AzureTokenClient,
} from "../src/index";

function fakeAad(
  impl: (input: AcquireTokenInput) => AcquireTokenOutput,
): AzureTokenClient & { calls: AcquireTokenInput[] } {
  const calls: AcquireTokenInput[] = [];
  return {
    calls,
    acquireToken: vi.fn(async (input: AcquireTokenInput) => {
      calls.push(input);
      return impl(input);
    }),
  };
}

const baseResponse = (input: AcquireTokenInput): AcquireTokenOutput => ({
  accessToken: `eyJ.${input.clientId}.${input.scope}`,
  expirationSeconds: 3600,
  scope: input.scope,
});

const baseRole = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  clientSecret: "super-secret",
  scope: "https://management.azure.com/.default",
};

describe("AzureSecretsPlugin.configure", () => {
  it("rejects non-object input", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await expect(p.configure(null)).rejects.toThrow(/must be an object/);
  });

  it("requires a roles map with at least one role", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await expect(p.configure({})).rejects.toThrow(/roles/);
    await expect(p.configure({ roles: {} })).rejects.toThrow(/at least one role/);
  });

  it("requires tenantId / clientId / clientSecret / scope per role", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await expect(p.configure({ roles: { r: {} } })).rejects.toThrow(/tenantId is required/);
    await expect(p.configure({ roles: { r: { tenantId: "x" } } })).rejects.toThrow(
      /clientId is required/,
    );
  });

  it("rejects non-positive-integer maxTtlSeconds", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await expect(
      p.configure({ roles: { r: { ...baseRole, maxTtlSeconds: 0 } } }),
    ).rejects.toThrow(/positive integer/);
  });

  it("accepts a well-formed config + exposes configuredRoles", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await p.configure({
      loginUrl: "https://login.microsoftonline.us",
      roles: {
        prod: baseRole,
        staging: { ...baseRole, clientId: "different" },
      },
    });
    expect(p.configuredRoles().sort()).toEqual(["prod", "staging"]);
  });
});

describe("AzureSecretsPlugin.issue", () => {
  let plugin: AzureSecretsPlugin;
  let aad: ReturnType<typeof fakeAad>;

  beforeEach(async () => {
    aad = fakeAad(baseResponse);
    plugin = new AzureSecretsPlugin(aad);
    await plugin.configure({
      roles: {
        prod: baseRole,
        capped: { ...baseRole, maxTtlSeconds: 1800 },
      },
    });
  });

  it("throws before configure()", async () => {
    const fresh = new AzureSecretsPlugin(aad);
    await expect(fresh.issue({ role: "prod" })).rejects.toThrow(/not configured/);
  });

  it("rejects an unknown role (no silent default)", async () => {
    await expect(plugin.issue({ role: "nope" })).rejects.toThrow(/unknown role: nope/);
  });

  it("calls AAD with the role's tenant/client/secret/scope + global loginUrl by default", async () => {
    const issued = await plugin.issue({ role: "prod" });
    expect(aad.calls).toHaveLength(1);
    expect(aad.calls[0]!.loginUrl).toBe("https://login.microsoftonline.com");
    expect(aad.calls[0]!.tenantId).toBe(baseRole.tenantId);
    expect(aad.calls[0]!.clientId).toBe(baseRole.clientId);
    expect(aad.calls[0]!.clientSecret).toBe(baseRole.clientSecret);
    expect(aad.calls[0]!.scope).toBe(baseRole.scope);

    expect(issued.data.access_token).toMatch(/^eyJ\./);
    expect(issued.data.tenant_id).toBe(baseRole.tenantId);
    expect(issued.data.client_id).toBe(baseRole.clientId);
    expect(issued.data.scope).toBe(baseRole.scope);
    expect(issued.ttlSeconds).toBe(3600);
    expect(issued.renewable).toBe(false);
    expect(issued.leaseId).toMatch(/^arc-plugin-azure\/prod\/\d+$/);
  });

  it("clamps the returned TTL down to role.maxTtlSeconds when set", async () => {
    aad = fakeAad((input) => ({ ...baseResponse(input), expirationSeconds: 3600 }));
    plugin = new AzureSecretsPlugin(aad);
    await plugin.configure({ roles: { capped: { ...baseRole, maxTtlSeconds: 1800 } } });
    const issued = await plugin.issue({ role: "capped" });
    expect(issued.ttlSeconds).toBe(1800);
  });

  it("honors a configured loginUrl override (sovereign cloud)", async () => {
    plugin = new AzureSecretsPlugin(aad);
    await plugin.configure({
      loginUrl: "https://login.partner.microsoftonline.cn",
      roles: { r: baseRole },
    });
    await plugin.issue({ role: "r" });
    expect(aad.calls.at(-1)!.loginUrl).toBe("https://login.partner.microsoftonline.cn");
  });

  it("generates a unique leaseId per issue", async () => {
    const a = await plugin.issue({ role: "prod" });
    const b = await plugin.issue({ role: "prod" });
    expect(a.leaseId).not.toBe(b.leaseId);
  });
});

describe("AzureSecretsPlugin.renew / revoke", () => {
  it("renew always throws", async () => {
    const p = new AzureSecretsPlugin(fakeAad(baseResponse));
    await expect(p.renew("anything")).rejects.toThrow(/not renewable/);
  });

  it("revoke is no-op at AAD + drops local tracking + idempotent", async () => {
    const aad = fakeAad(baseResponse);
    const p = new AzureSecretsPlugin(aad);
    await p.configure({ roles: { r: baseRole } });
    const issued = await p.issue({ role: "r" });
    await p.revoke(issued.leaseId);
    expect(aad.calls).toHaveLength(1); // no extra calls
    await p.revoke(issued.leaseId); // idempotent
  });
});
