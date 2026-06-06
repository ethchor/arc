import { describe, expect, it } from "vitest";
import {
  CachingPolicyStore,
  InMemoryPolicyStore,
  PolicyEngine,
  scope,
} from "../src/index";

describe("InMemoryPolicyStore — groups", () => {
  it("addToGroup is idempotent and surfaces in listSubjectsInGroup", () => {
    const store = new InMemoryPolicyStore();
    store.addToGroup("u1", "engineering");
    store.addToGroup("u1", "engineering"); // idempotent
    store.addToGroup("u2", "engineering");
    expect(store.listSubjectsInGroup("engineering")).toEqual(["u1", "u2"]);
  });

  it("removeFromGroup returns true on a hit and false on idempotent re-call", () => {
    const store = new InMemoryPolicyStore();
    store.addToGroup("u1", "ops");
    expect(store.removeFromGroup("u1", "ops")).toBe(true);
    expect(store.removeFromGroup("u1", "ops")).toBe(false);
    expect(store.listSubjectsInGroup("ops")).toEqual([]);
  });

  it("attachToGroup throws on unknown policy (catches admin typos)", () => {
    const store = new InMemoryPolicyStore();
    expect(() => store.attachToGroup("ops", "nonexistent")).toThrowError(/unknown policy/);
  });

  it("attachToGroup is idempotent; detachFromGroup returns hit/miss", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("a/", ["read"])] });
    store.attachToGroup("ops", "reader");
    store.attachToGroup("ops", "reader"); // idempotent
    expect(store.listGroupPolicies("ops")).toEqual(["reader"]);

    expect(store.detachFromGroup("ops", "reader")).toBe(true);
    expect(store.detachFromGroup("ops", "reader")).toBe(false);
  });

  it("listGroupsForSubject returns every group the subject belongs to", () => {
    const store = new InMemoryPolicyStore();
    store.addToGroup("u1", "engineering");
    store.addToGroup("u1", "ops");
    store.addToGroup("u2", "ops");
    expect(store.listGroupsForSubject("u1")).toEqual(["engineering", "ops"]);
    expect(store.listGroupsForSubject("u2")).toEqual(["ops"]);
    expect(store.listGroupsForSubject("ghost")).toEqual([]);
  });
});

describe("InMemoryPolicyStore — group → policy resolution", () => {
  it("subject inherits policies from groups it's a member of", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.upsertPolicy({ name: "deployer", scopes: [scope("deploy/", ["create"])] });

    store.attachToGroup("engineering", "reader");
    store.attachToGroup("engineering", "deployer");
    store.addToGroup("u1", "engineering");

    const policies = store.getPoliciesForSubject("u1");
    expect(policies.map((p) => p.name).sort()).toEqual(["deployer", "reader"]);
  });

  it("direct + group policies are unioned (no duplicates)", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.upsertPolicy({ name: "admin", scopes: [scope("", ["sudo"])] });

    store.attach("u1", "reader");
    store.attachToGroup("ops", "reader"); // same policy reached two ways
    store.attachToGroup("ops", "admin");
    store.addToGroup("u1", "ops");

    const policies = store.getPoliciesForSubject("u1");
    // "reader" appears once even though it's reachable both directly and via the group.
    expect(policies.map((p) => p.name).sort()).toEqual(["admin", "reader"]);
  });

  it("removing the subject from a group drops the inherited policies on next read", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.attachToGroup("ops", "reader");
    store.addToGroup("u1", "ops");

    expect(store.getPoliciesForSubject("u1").map((p) => p.name)).toEqual(["reader"]);
    store.removeFromGroup("u1", "ops");
    expect(store.getPoliciesForSubject("u1")).toEqual([]);
  });

  it("detaching a policy from the group drops it for every member at once", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.attachToGroup("ops", "reader");
    store.addToGroup("u1", "ops");
    store.addToGroup("u2", "ops");

    expect(store.getPoliciesForSubject("u1").map((p) => p.name)).toEqual(["reader"]);
    expect(store.getPoliciesForSubject("u2").map((p) => p.name)).toEqual(["reader"]);

    store.detachFromGroup("ops", "reader");
    expect(store.getPoliciesForSubject("u1")).toEqual([]);
    expect(store.getPoliciesForSubject("u2")).toEqual([]);
  });

  it("removing the policy (not just the attachment) filters out stale group links silently", () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    store.attachToGroup("ops", "reader");
    store.addToGroup("u1", "ops");
    store.removePolicy("reader");
    expect(store.getPoliciesForSubject("u1")).toEqual([]); // stale link silently ignored
  });
});

describe("PolicyEngine — decisions consider group policies", () => {
  it("a member of an attached group is allowed under the group's scopes", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("sys/", ["read"])] });
    store.attachToGroup("engineering", "reader");
    store.addToGroup("u1", "engineering");

    const engine = new PolicyEngine({ store, defaultMode: "deny" });
    expect(await engine.decide("u1", "sys/mounts", "read")).toBe("allow");
    expect(await engine.decide("u1", "sys/mounts", "delete")).toBe("deny");
  });

  it("a subject not in the group falls back to default-deny", async () => {
    const store = new InMemoryPolicyStore();
    store.upsertPolicy({ name: "reader", scopes: [scope("sys/", ["read"])] });
    store.attachToGroup("engineering", "reader");
    // u1 is NOT added to engineering
    const engine = new PolicyEngine({ store, defaultMode: "deny" });
    expect(await engine.decide("u1", "sys/mounts", "read")).toBe("deny");
  });
});

describe("CachingPolicyStore — group invalidation", () => {
  function counted(inner: InMemoryPolicyStore) {
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      async getPoliciesForSubject(s: string) {
        reads++;
        return inner.getPoliciesForSubject(s);
      },
      upsertPolicy: (p: Parameters<typeof inner.upsertPolicy>[0]) => inner.upsertPolicy(p),
      removePolicy: (n: string) => inner.removePolicy(n),
      attach: (s: string, p: string) => inner.attach(s, p),
      detach: (s: string, p: string) => inner.detach(s, p),
      listPolicies: () => inner.listPolicies(),
      addToGroup: (s: string, g: string) => inner.addToGroup(s, g),
      removeFromGroup: (s: string, g: string) => inner.removeFromGroup(s, g),
      attachToGroup: (g: string, p: string) => inner.attachToGroup(g, p),
      detachFromGroup: (g: string, p: string) => inner.detachFromGroup(g, p),
      listGroupsForSubject: (s: string) => inner.listGroupsForSubject(s),
      listSubjectsInGroup: (g: string) => inner.listSubjectsInGroup(g),
      listGroupPolicies: (g: string) => inner.listGroupPolicies(g),
    };
  }

  it("addToGroup invalidates only that subject's cache entry", async () => {
    const inner = new InMemoryPolicyStore();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attachToGroup("ops", "p");

    const tracked = counted(inner);
    const cache = new CachingPolicyStore({ store: tracked });

    await cache.getPoliciesForSubject("u1"); // read miss → populate, count 1
    await cache.getPoliciesForSubject("u2"); // read miss → populate, count 2
    expect(tracked.reads).toBe(2);

    await cache.addToGroup("u1", "ops"); // invalidate u1 only
    await cache.getPoliciesForSubject("u1"); // re-read, count 3
    await cache.getPoliciesForSubject("u2"); // still cached, no read
    expect(tracked.reads).toBe(3);
  });

  it("attachToGroup flushes the entire cache (any member might be affected)", async () => {
    const inner = new InMemoryPolicyStore();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.addToGroup("u1", "ops");
    inner.addToGroup("u2", "ops");
    const tracked = counted(inner);
    const cache = new CachingPolicyStore({ store: tracked });

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    expect(cache.size()).toBe(2);

    await cache.attachToGroup("ops", "p");
    expect(cache.size()).toBe(0);
  });

  it("a brand-new group attachment is visible on the next read with no stale TTL window", async () => {
    const inner = new InMemoryPolicyStore();
    inner.upsertPolicy({ name: "reader", scopes: [scope("a/", ["read"])] });
    const cache = new CachingPolicyStore({ store: inner, ttlMs: 60_000 });

    expect(await cache.getPoliciesForSubject("u1")).toEqual([]); // miss → cached as []

    await cache.attachToGroup("ops", "reader"); // flushes all
    await cache.addToGroup("u1", "ops"); // invalidates u1

    const after = await cache.getPoliciesForSubject("u1");
    expect(after.map((p) => p.name)).toEqual(["reader"]);
  });
});
