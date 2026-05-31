import { describe, expect, it } from "vitest";
import { PluginError, PluginHost, scopeAllows } from "../src/index";
import type { IssueRequest, IssuedSecret, LeaseInfo, Scope, SecretsPlugin } from "../src/index";

class FakeSecretsPlugin implements SecretsPlugin {
  readonly meta = { name: "fake-db", version: "0.0.0", kind: "secrets" as const };
  configured = false;
  async configure(): Promise<void> {
    this.configured = true;
  }
  async issue(req: IssueRequest): Promise<IssuedSecret> {
    return {
      data: { username: `v-${req.role}`, password: "secret" },
      leaseId: "l1",
      ttlSeconds: req.ttlSeconds ?? 60,
      renewable: true,
    };
  }
  async renew(leaseId: string): Promise<LeaseInfo> {
    return { leaseId, ttlSeconds: 60, renewable: true };
  }
  async revoke(): Promise<void> {}
}

describe("PluginHost", () => {
  it("registers and retrieves a plugin by kind", async () => {
    const host = new PluginHost();
    host.register(new FakeSecretsPlugin());
    expect(host.has("fake-db")).toBe(true);
    expect(host.list("secrets").map((m) => m.name)).toEqual(["fake-db"]);
    const issued = await host.getSecrets("fake-db").issue({ role: "app" });
    expect(issued.data.username).toBe("v-app");
  });

  it("rejects duplicate registration", () => {
    const host = new PluginHost();
    host.register(new FakeSecretsPlugin());
    expect(() => host.register(new FakeSecretsPlugin())).toThrowError(PluginError);
  });

  it("rejects a kind mismatch on lookup", () => {
    const host = new PluginHost();
    host.register(new FakeSecretsPlugin());
    expect(() => host.getAuth("fake-db")).toThrowError(/expected "auth"/);
  });
});

describe("scopeAllows", () => {
  const scopes: Scope[] = [{ pathPrefix: "database/", capabilities: ["read", "create"] }];

  it("permits a covered capability on a covered path", () => {
    expect(scopeAllows(scopes, "database/creds/app", "read")).toBe(true);
  });

  it("denies an uncovered capability", () => {
    expect(scopeAllows(scopes, "database/creds/app", "delete")).toBe(false);
  });

  it("denies an uncovered path", () => {
    expect(scopeAllows(scopes, "aws/creds/app", "read")).toBe(false);
  });

  it("treats sudo as implying every capability", () => {
    const sudo: Scope[] = [{ pathPrefix: "sys/", capabilities: ["sudo"] }];
    expect(scopeAllows(sudo, "sys/seal", "update")).toBe(true);
  });
});
