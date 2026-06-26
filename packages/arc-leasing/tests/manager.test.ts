import { describe, expect, it } from "vitest";
import { LeaseError, LeaseManager } from "../src/index";

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (sec: number) => (t += sec * 1000) };
}

let counter = 0;
const seqId = () => `lease-${++counter}`;

describe("LeaseManager", () => {
  it("issues a lease with normalized mount and computed expiry", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = await m.issue({ mount: "/database", ttlSeconds: 60 });
    expect(lease.mount).toBe("database/");
    expect(lease.expiresAt).toBe(lease.issuedAt + 60_000);
    expect(await m.state(lease.id)).toBe("active");
  });

  it("renews from now and caps at maxTtl", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = await m.issue({ mount: "db", ttlSeconds: 60, maxTtlSeconds: 100 });
    clk.advance(30);
    const r1 = await m.renew(lease.id, 60); // now +30s, +60s => +90s (< cap 100)
    expect(r1.expiresAt).toBe(lease.issuedAt + 90_000);
    clk.advance(50);
    const r2 = await m.renew(lease.id, 60); // now +80s, +60s => +140s, capped to +100s
    expect(r2.expiresAt).toBe(lease.issuedAt + 100_000);
  });

  it("expires after ttl and refuses renewal", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = await m.issue({ mount: "db", ttlSeconds: 10 });
    clk.advance(11);
    expect(await m.state(lease.id)).toBe("expired");
    await expect(m.renew(lease.id)).rejects.toThrowError(LeaseError);
  });

  it("revoke is terminal and idempotent", async () => {
    const m = new LeaseManager({ idGen: seqId });
    const lease = await m.issue({ mount: "db", ttlSeconds: 10 });
    await m.revoke(lease.id);
    expect(await m.state(lease.id)).toBe("revoked");
    await m.revoke(lease.id); // no throw
    await expect(m.renew(lease.id)).rejects.toThrowError(/revoked/);
  });

  it("renew/revoke of an unknown lease throw not_found", async () => {
    const m = new LeaseManager({ idGen: seqId });
    await expect(m.renew("ghost")).rejects.toThrowError(/no lease/);
    await expect(m.revoke("ghost")).rejects.toThrowError(/no lease/);
  });

  it("rejects renewal of a non-renewable lease", async () => {
    const m = new LeaseManager({ idGen: seqId });
    const lease = await m.issue({ mount: "db", ttlSeconds: 10, renewable: false });
    await expect(m.renew(lease.id)).rejects.toThrowError(/not renewable/);
  });

  it("revokePrefix revokes only matching active leases", async () => {
    const m = new LeaseManager({ idGen: seqId });
    const a = await m.issue({ mount: "database/pg", ttlSeconds: 60 });
    const b = await m.issue({ mount: "database/mysql", ttlSeconds: 60 });
    const c = await m.issue({ mount: "aws", ttlSeconds: 60 });
    expect(await m.revokePrefix("database/")).toBe(2);
    expect(await m.state(a.id)).toBe("revoked");
    expect(await m.state(b.id)).toBe("revoked");
    expect(await m.state(c.id)).toBe("active");
  });

  it("sweep removes non-active leases", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const a = await m.issue({ mount: "db", ttlSeconds: 10 });
    const b = await m.issue({ mount: "db", ttlSeconds: 1000 });
    clk.advance(11);
    const removed = await m.sweep();
    expect(removed).toContain(a.id);
    expect(await m.get(a.id)).toBeUndefined();
    expect(await m.get(b.id)).toBeDefined();
  });

  it("sweep honours olderThanMs retention (keeps recently-terminal leases)", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const a = await m.issue({ mount: "db", ttlSeconds: 10 });
    clk.advance(11); // a is now expired (terminal moment = its expiresAt)
    // With a 1h retention window, a (expired 1s ago) is kept.
    expect(await m.sweep(clk.now(), { olderThanMs: 3_600_000 })).toEqual([]);
    expect(await m.get(a.id)).toBeDefined();
    // Advance past the window → now it's pruned.
    clk.advance(3601);
    expect(await m.sweep(clk.now(), { olderThanMs: 3_600_000 })).toContain(a.id);
    expect(await m.get(a.id)).toBeUndefined();
  });

  it("rejects invalid ttls at issue time", async () => {
    const m = new LeaseManager({ idGen: seqId });
    await expect(m.issue({ mount: "db", ttlSeconds: 0 })).rejects.toThrowError(/ttlSeconds/);
    await expect(
      m.issue({ mount: "db", ttlSeconds: 60, maxTtlSeconds: 10 }),
    ).rejects.toThrowError(/maxTtlSeconds/);
  });

  it("does not alias stored state — a returned lease is a copy", async () => {
    const m = new LeaseManager({ idGen: seqId });
    const lease = await m.issue({ mount: "db", ttlSeconds: 60 });
    // Mutating the returned object must not affect the stored lease.
    (lease as { expiresAt: number }).expiresAt = 0;
    const fresh = await m.get(lease.id);
    expect(fresh?.expiresAt).toBeGreaterThan(0);
  });
});

describe("LeaseManager.revokeByTaskId (Engine-C cascade, ADR-005)", () => {
  it("revokes only active leases tagged with the given taskId", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const a1 = await m.issue({ mount: "database", ttlSeconds: 60, taskId: "task-A" });
    const a2 = await m.issue({ mount: "pki", ttlSeconds: 60, taskId: "task-A" });
    const b1 = await m.issue({ mount: "database", ttlSeconds: 60, taskId: "task-B" });
    const untagged = await m.issue({ mount: "secret", ttlSeconds: 60 });

    const revoked = await m.revokeByTaskId("task-A");
    expect(revoked).toBe(2);
    expect(await m.state(a1.id)).toBe("revoked");
    expect(await m.state(a2.id)).toBe("revoked");
    expect(await m.state(b1.id)).toBe("active");
    expect(await m.state(untagged.id)).toBe("active");

    // Idempotent: a second call revokes nothing more.
    expect(await m.revokeByTaskId("task-A")).toBe(0);
  });

  it("skips already-expired leases when cascading", async () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const l = await m.issue({ mount: "database", ttlSeconds: 10, taskId: "task-C" });
    clk.advance(20); // lease now expired
    expect(await m.revokeByTaskId("task-C")).toBe(0);
    expect(await m.state(l.id)).toBe("expired");
  });
});
