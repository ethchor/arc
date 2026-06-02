import { describe, expect, it, vi } from "vitest";
import { CachingPolicyStore, InMemoryPolicyStore, scope } from "../src/index";
import type { MutablePolicyStore, Policy } from "../src/index";

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Counting wrapper so tests can assert the cache actually short-circuits the underlying read. */
function counted(store: MutablePolicyStore): MutablePolicyStore & { reads: number } {
  const wrapped = {
    reads: 0,
    async getPoliciesForSubject(subject: string): Promise<Policy[]> {
      wrapped.reads++;
      return store.getPoliciesForSubject(subject);
    },
    upsertPolicy: (p: Policy) => store.upsertPolicy(p),
    removePolicy: (n: string) => store.removePolicy(n),
    attach: (s: string, p: string) => store.attach(s, p),
    detach: (s: string, p: string) => store.detach(s, p),
    listPolicies: () => store.listPolicies(),
  };
  return wrapped as MutablePolicyStore & { reads: number };
}

function freshStores(ttlMs = 30_000, clock = Date.now) {
  const inner = new InMemoryPolicyStore();
  const tracked = counted(inner);
  const cache = new CachingPolicyStore({ store: tracked, ttlMs, clock });
  return { inner, tracked, cache };
}

describe("CachingPolicyStore — read caching", () => {
  it("hits the underlying store once and serves subsequent reads from cache", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "reader", scopes: [scope("a/", ["read"])] });
    inner.attach("u1", "reader");

    const a = await cache.getPoliciesForSubject("u1");
    const b = await cache.getPoliciesForSubject("u1");
    const c = await cache.getPoliciesForSubject("u1");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(tracked.reads).toBe(1);
  });

  it("expires after ttlMs and re-reads", async () => {
    const clk = fixedClock();
    const { inner, tracked, cache } = freshStores(1000, clk.now);
    inner.upsertPolicy({ name: "reader", scopes: [] });
    inner.attach("u1", "reader");

    await cache.getPoliciesForSubject("u1");
    expect(tracked.reads).toBe(1);

    clk.advance(500);
    await cache.getPoliciesForSubject("u1");
    expect(tracked.reads).toBe(1); // still within TTL

    clk.advance(600); // total 1100ms > ttl
    await cache.getPoliciesForSubject("u1");
    expect(tracked.reads).toBe(2);
  });

  it("ttlMs=0 disables read caching entirely (every read hits the store)", async () => {
    const { inner, tracked, cache } = freshStores(0);
    inner.upsertPolicy({ name: "reader", scopes: [] });
    inner.attach("u1", "reader");

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u1");
    expect(tracked.reads).toBe(3);
    expect(cache.size()).toBe(0); // nothing cached
  });

  it("caches per-subject independently", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");
    inner.attach("u2", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    expect(tracked.reads).toBe(2); // one per subject, then cached
  });
});

describe("CachingPolicyStore — invalidation on mutation", () => {
  it("attach(subject, _) invalidates ONLY that subject's entry", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");
    inner.attach("u2", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    expect(tracked.reads).toBe(2);

    // Attach a new policy to u1 — only u1's cache entry should drop.
    inner.upsertPolicy({ name: "extra", scopes: [scope("x/", ["read"])] });
    // upsertPolicy direct on inner store doesn't go through cache; mimic admin attach instead.
    await cache.attach("u1", "extra");

    await cache.getPoliciesForSubject("u1"); // miss → re-read
    await cache.getPoliciesForSubject("u2"); // still hit
    expect(tracked.reads).toBe(3);
  });

  it("detach(subject, _) invalidates that subject's entry", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.detach("u1", "p");
    await cache.getPoliciesForSubject("u1");
    expect(tracked.reads).toBe(2);
  });

  it("upsertPolicy flushes the entire cache (couldn't know which subjects are affected)", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");
    inner.attach("u2", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    expect(cache.size()).toBe(2);

    await cache.upsertPolicy({ name: "p", scopes: [scope("a/", ["sudo"])] });
    expect(cache.size()).toBe(0);
  });

  it("removePolicy flushes the entire cache", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.removePolicy("p");
    expect(cache.size()).toBe(0);
  });

  it("listPolicies bypasses the cache (admin always sees fresh)", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });

    await cache.listPolicies();
    await cache.listPolicies();
    // listPolicies doesn't go through the read-counter (it's a separate call), and the
    // cache shouldn't store list results — `size()` should remain 0.
    expect(cache.size()).toBe(0);
  });

  it("propagates the unknown-policy throw from attach (preserves contract)", async () => {
    const { cache } = freshStores();
    await expect(cache.attach("u1", "nope")).rejects.toThrow(/unknown policy/);
  });
});

describe("CachingPolicyStore — correctness end-to-end", () => {
  it("a newly-attached policy is visible on the very next read (no stale TTL window)", async () => {
    const clk = fixedClock();
    const { inner, cache } = freshStores(60_000, clk.now); // long TTL
    inner.upsertPolicy({ name: "reader", scopes: [scope("a/", ["read"])] });

    // First read: u1 has no policies → cached as [].
    expect(await cache.getPoliciesForSubject("u1")).toEqual([]);

    // Admin attaches *through the cache* — invalidation kicks in.
    await cache.attach("u1", "reader");

    // Same wall clock: the cached [] is gone, fresh read returns the new policy.
    const after = await cache.getPoliciesForSubject("u1");
    expect(after.map((p) => p.name)).toEqual(["reader"]);
  });

  it("a removed policy disappears for every subject on the next read", async () => {
    const { inner, cache } = freshStores(60_000);
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");
    inner.attach("u2", "p");

    await cache.getPoliciesForSubject("u1");
    await cache.getPoliciesForSubject("u2");
    await cache.removePolicy("p");

    expect((await cache.getPoliciesForSubject("u1")).map((p) => p.name)).toEqual([]);
    expect((await cache.getPoliciesForSubject("u2")).map((p) => p.name)).toEqual([]);
  });

  it("clear() drops every entry without going through the store", async () => {
    const { inner, tracked, cache } = freshStores();
    inner.upsertPolicy({ name: "p", scopes: [] });
    inner.attach("u1", "p");
    await cache.getPoliciesForSubject("u1");
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(tracked.reads).toBe(1); // unchanged — clear() doesn't read
  });
});
