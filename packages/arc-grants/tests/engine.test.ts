import { describe, expect, it } from "vitest";
import { InMemoryPolicyStore, PolicyEngine, scope } from "../src/index";

function makeStore(...attachments: Array<[subject: string, policyName: string]>) {
  const store = new InMemoryPolicyStore();
  const seen = new Set<string>();
  for (const [, policyName] of attachments) {
    if (!seen.has(policyName)) {
      seen.add(policyName);
      // Test stub: policies attached by these helpers come from `attach()` calls below.
    }
  }
  return store;
}

describe("PolicyEngine.decide — default modes", () => {
  it("default-deny when the subject has no policies", async () => {
    const store = makeStore();
    const engine = new PolicyEngine({ store }); // defaultMode unset → "deny"
    expect(await engine.decide("u1", "secret/foo", "read")).toBe("deny");
  });

  it("default-allow when the subject has no policies and `allow` is requested explicitly", async () => {
    const store = makeStore();
    const engine = new PolicyEngine({ store, defaultMode: "allow" });
    expect(await engine.decide("u1", "secret/foo", "read")).toBe("allow");
  });

  it("ignores default-allow once the subject has *any* policy attached (strict from then on)", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.attach("u1", "reader");
    const engine = new PolicyEngine({ store, defaultMode: "allow" });
    expect(await engine.decide("u1", "secret/foo", "read")).toBe("allow");
    // Same user, uncovered path → deny, not the default.
    expect(await engine.decide("u1", "database/creds/app", "read")).toBe("deny");
  });
});

describe("PolicyEngine.decide — scope matching", () => {
  it("allows when any attached policy covers the capability", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "p1", scopes: [scope("secret/", ["read"])] });
    store.upsertPolicy({ name: "p2", scopes: [scope("database/", ["create"])] });
    store.attach("u1", "p1");
    store.attach("u1", "p2");
    const engine = new PolicyEngine({ store });
    expect(await engine.decide("u1", "secret/foo", "read")).toBe("allow");
    expect(await engine.decide("u1", "database/creds/app", "create")).toBe("allow");
    expect(await engine.decide("u1", "secret/foo", "delete")).toBe("deny");
  });

  it("sudo on a prefix implies every capability under it", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "ops", scopes: [scope("sys/", ["sudo"])] });
    store.attach("ops-user", "ops");
    const engine = new PolicyEngine({ store });
    expect(await engine.decide("ops-user", "sys/seal", "update")).toBe("allow");
    expect(await engine.decide("ops-user", "sys/audit", "delete")).toBe("allow");
  });

  it("decideDetailed returns the policy names considered + the reason", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.attach("u1", "reader");
    const engine = new PolicyEngine({ store });

    const allow = await engine.decideDetailed("u1", "secret/foo", "read");
    expect(allow.decision).toBe("allow");
    expect(allow.reason).toBe("scope-match");
    expect(allow.policies).toEqual(["reader"]);

    const deny = await engine.decideDetailed("u1", "secret/foo", "delete");
    expect(deny.decision).toBe("deny");
    expect(deny.reason).toBe("no-matching-scope");

    const noPolicies = await engine.decideDetailed("u2", "secret/foo", "read");
    expect(noPolicies.decision).toBe("deny");
    expect(noPolicies.reason).toBe("no-policies");
    expect(noPolicies.policies).toEqual([]);
  });
});

describe("InMemoryPolicyStore", () => {
  it("attach + getPoliciesForSubject returns the upserted policy", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "p", scopes: [scope("a/", ["read"])] });
    store.attach("u", "p");
    expect(store.getPoliciesForSubject("u")).toHaveLength(1);
  });

  it("throws when attaching an unknown policy (catches typos at admin time)", () => {
    const store = new InMemoryPolicyStore();
    expect(() => store.attach("u", "nope")).toThrowError(/unknown policy/);
  });

  it("detach removes the attachment idempotently", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "p", scopes: [] });
    store.attach("u", "p");
    expect(store.detach("u", "p")).toBe(true);
    expect(store.detach("u", "p")).toBe(false);
    expect(store.getPoliciesForSubject("u")).toEqual([]);
  });

  it("removePolicy doesn't break attachments on lookup (stale-attachment is tolerated, returned as zero)", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "p", scopes: [scope("a/", ["read"])] });
    store.attach("u", "p");
    store.removePolicy("p");
    // The attachment lingers but lookup filters out the now-missing policy.
    expect(store.getPoliciesForSubject("u")).toEqual([]);
  });
});
