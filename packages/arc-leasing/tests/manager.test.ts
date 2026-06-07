import { describe, expect, it } from "vitest";
import { LeaseError, LeaseManager } from "../src/index";

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (sec: number) => (t += sec * 1000) };
}

let counter = 0;
const seqId = () => `lease-${++counter}`;

describe("LeaseManager", () => {
  it("issues a lease with normalized mount and computed expiry", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = m.issue({ mount: "/database", ttlSeconds: 60 });
    expect(lease.mount).toBe("database/");
    expect(lease.expiresAt).toBe(lease.issuedAt + 60_000);
    expect(m.state(lease.id)).toBe("active");
  });

  it("renews from now and caps at maxTtl", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = m.issue({ mount: "db", ttlSeconds: 60, maxTtlSeconds: 100 });
    clk.advance(30);
    m.renew(lease.id, 60); // now +30s, +60s => +90s (< cap 100)
    expect(lease.expiresAt).toBe(lease.issuedAt + 90_000);
    clk.advance(50);
    m.renew(lease.id, 60); // now +80s, +60s => +140s, capped to +100s
    expect(lease.expiresAt).toBe(lease.issuedAt + 100_000);
  });

  it("expires after ttl and refuses renewal", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const lease = m.issue({ mount: "db", ttlSeconds: 10 });
    clk.advance(11);
    expect(m.state(lease.id)).toBe("expired");
    expect(() => m.renew(lease.id)).toThrowError(LeaseError);
  });

  it("revoke is terminal and idempotent", () => {
    const m = new LeaseManager({ idGen: seqId });
    const lease = m.issue({ mount: "db", ttlSeconds: 10 });
    m.revoke(lease.id);
    expect(m.state(lease.id)).toBe("revoked");
    m.revoke(lease.id); // no throw
    expect(() => m.renew(lease.id)).toThrowError(/revoked/);
  });

  it("rejects renewal of a non-renewable lease", () => {
    const m = new LeaseManager({ idGen: seqId });
    const lease = m.issue({ mount: "db", ttlSeconds: 10, renewable: false });
    expect(() => m.renew(lease.id)).toThrowError(/not renewable/);
  });

  it("revokePrefix revokes only matching active leases", () => {
    const m = new LeaseManager({ idGen: seqId });
    const a = m.issue({ mount: "database/pg", ttlSeconds: 60 });
    const b = m.issue({ mount: "database/mysql", ttlSeconds: 60 });
    const c = m.issue({ mount: "aws", ttlSeconds: 60 });
    expect(m.revokePrefix("database/")).toBe(2);
    expect(m.state(a.id)).toBe("revoked");
    expect(m.state(b.id)).toBe("revoked");
    expect(m.state(c.id)).toBe("active");
  });

  it("sweep removes non-active leases", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const a = m.issue({ mount: "db", ttlSeconds: 10 });
    const b = m.issue({ mount: "db", ttlSeconds: 1000 });
    clk.advance(11);
    const removed = m.sweep();
    expect(removed).toContain(a.id);
    expect(m.get(a.id)).toBeUndefined();
    expect(m.get(b.id)).toBeDefined();
  });

  it("rejects invalid ttls at issue time", () => {
    const m = new LeaseManager({ idGen: seqId });
    expect(() => m.issue({ mount: "db", ttlSeconds: 0 })).toThrowError(/ttlSeconds/);
    expect(() => m.issue({ mount: "db", ttlSeconds: 60, maxTtlSeconds: 10 })).toThrowError(
      /maxTtlSeconds/,
    );
  });
});

describe("LeaseManager.revokeByTaskId (Engine-C cascade, ADR-005)", () => {
  it("revokes only active leases tagged with the given taskId", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const a1 = m.issue({ mount: "database", ttlSeconds: 60, taskId: "task-A" });
    const a2 = m.issue({ mount: "pki", ttlSeconds: 60, taskId: "task-A" });
    const b1 = m.issue({ mount: "database", ttlSeconds: 60, taskId: "task-B" });
    const untagged = m.issue({ mount: "secret", ttlSeconds: 60 });

    const revoked = m.revokeByTaskId("task-A");
    expect(revoked).toBe(2);
    expect(m.state(a1.id)).toBe("revoked");
    expect(m.state(a2.id)).toBe("revoked");
    expect(m.state(b1.id)).toBe("active");
    expect(m.state(untagged.id)).toBe("active");

    // Idempotent: a second call revokes nothing more.
    expect(m.revokeByTaskId("task-A")).toBe(0);
  });

  it("skips already-expired leases when cascading", () => {
    const clk = fixedClock();
    const m = new LeaseManager({ clock: clk.now, idGen: seqId });
    const l = m.issue({ mount: "database", ttlSeconds: 10, taskId: "task-C" });
    clk.advance(20); // lease now expired
    expect(m.revokeByTaskId("task-C")).toBe(0);
    expect(m.state(l.id)).toBe("expired");
  });
})
