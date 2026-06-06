import { describe, expect, it } from "vitest";
import { KubernetesAuthPlugin } from "../src/plugin";
import type { TokenReviewer, TokenReviewResult } from "../src/types";

function fakeReviewer(result: TokenReviewResult) {
  const calls: { token: string; audiences?: string[] }[] = [];
  const reviewer: TokenReviewer = {
    async review(token, audiences) {
      calls.push({ token, audiences });
      return result;
    },
  };
  return { reviewer, calls };
}

const okReview = (username: string, extra: Partial<TokenReviewResult> = {}): TokenReviewResult => ({
  authenticated: true,
  username,
  uid: "uid-123",
  ...extra,
});

const config = {
  roles: {
    deployer: {
      boundServiceAccountNames: ["deployer"],
      boundNamespaces: ["apps"],
      policies: ["deploy", "read-secrets"],
      tokenTtlSeconds: 1800,
      audiences: ["arc"],
    },
  },
};

describe("KubernetesAuthPlugin.configure", () => {
  it("rejects config without roles", async () => {
    const { reviewer } = fakeReviewer(okReview("x"));
    await expect(new KubernetesAuthPlugin(reviewer).configure({})).rejects.toThrow(/roles/);
  });

  it("rejects a role without policies", async () => {
    const { reviewer } = fakeReviewer(okReview("x"));
    await expect(
      new KubernetesAuthPlugin(reviewer).configure({
        roles: { r: { boundServiceAccountNames: ["a"], boundNamespaces: ["b"], policies: [] } },
      }),
    ).rejects.toThrow(/policy/);
  });
});

describe("KubernetesAuthPlugin.login", () => {
  it("authenticates a matching ServiceAccount and maps to policies", async () => {
    const { reviewer, calls } = fakeReviewer(okReview("system:serviceaccount:apps:deployer"));
    const p = new KubernetesAuthPlugin(reviewer);
    await p.configure(config);

    const res = await p.login({ mount: "auth/kubernetes/", credentials: { role: "deployer", jwt: "sa-token" } });

    expect(calls[0]).toEqual({ token: "sa-token", audiences: ["arc"] });
    expect(res.identityId).toBe("system:serviceaccount:apps:deployer");
    expect(res.policies).toEqual(["deploy", "read-secrets"]);
    expect(res.tokenTtlSeconds).toBe(1800);
    expect(res.metadata).toMatchObject({
      role: "deployer",
      namespace: "apps",
      serviceAccountName: "deployer",
      uid: "uid-123",
    });
  });

  it("rejects a token that did not authenticate", async () => {
    const { reviewer } = fakeReviewer({ authenticated: false, error: "token expired" });
    const p = new KubernetesAuthPlugin(reviewer);
    await p.configure(config);
    await expect(p.login({ mount: "m", credentials: { role: "deployer", jwt: "t" } })).rejects.toThrow(/did not authenticate: token expired/);
  });

  it("rejects a non-ServiceAccount identity (e.g. a user/node token)", async () => {
    const { reviewer } = fakeReviewer(okReview("system:node:worker-1"));
    const p = new KubernetesAuthPlugin(reviewer);
    await p.configure(config);
    await expect(p.login({ mount: "m", credentials: { role: "deployer", jwt: "t" } })).rejects.toThrow(/not a ServiceAccount/);
  });

  it("enforces bound namespace and service-account name", async () => {
    const wrongNs = fakeReviewer(okReview("system:serviceaccount:other:deployer"));
    const p1 = new KubernetesAuthPlugin(wrongNs.reviewer);
    await p1.configure(config);
    await expect(p1.login({ mount: "m", credentials: { role: "deployer", jwt: "t" } })).rejects.toThrow(/namespace "other" not permitted/);

    const wrongSa = fakeReviewer(okReview("system:serviceaccount:apps:intruder"));
    const p2 = new KubernetesAuthPlugin(wrongSa.reviewer);
    await p2.configure(config);
    await expect(p2.login({ mount: "m", credentials: { role: "deployer", jwt: "t" } })).rejects.toThrow(/service account "intruder" not permitted/);
  });

  it("supports wildcard bindings and defaults the ttl to 3600", async () => {
    const { reviewer } = fakeReviewer(okReview("system:serviceaccount:anything:whatever"));
    const p = new KubernetesAuthPlugin(reviewer);
    await p.configure({
      roles: { any: { boundServiceAccountNames: ["*"], boundNamespaces: ["*"], policies: ["read"] } },
    });
    const res = await p.login({ mount: "m", credentials: { role: "any", jwt: "t" } });
    expect(res.identityId).toBe("system:serviceaccount:anything:whatever");
    expect(res.tokenTtlSeconds).toBe(3600);
  });

  it("rejects unknown role, missing creds, and login-before-configure", async () => {
    const { reviewer } = fakeReviewer(okReview("system:serviceaccount:apps:deployer"));
    const p = new KubernetesAuthPlugin(reviewer);
    await expect(p.login({ mount: "m", credentials: { role: "deployer", jwt: "t" } })).rejects.toThrow(/not configured/);
    await p.configure(config);
    await expect(p.login({ mount: "m", credentials: { role: "ghost", jwt: "t" } })).rejects.toThrow(/unknown role/);
    await expect(p.login({ mount: "m", credentials: { role: "deployer" } })).rejects.toThrow(/jwt/);
  });
});
