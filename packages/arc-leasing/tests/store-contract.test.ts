import { describe, expect, it } from "vitest";
import { InMemoryLeaseStore, type Lease, type LeaseStore } from "../src/index";

/**
 * Behavioural contract every {@link LeaseStore} must satisfy. arc-server's TypeORM-backed
 * store has its own copy of these assertions (jest, against a sql.js DataSource) so both
 * implementations are held to the same bar — the in-memory one here, the persistent one
 * there. If you add a store method, extend both.
 */
function lease(id: string, over: Partial<Lease> = {}): Lease {
  return {
    id,
    mount: "database/",
    backendLeaseId: `backend-${id}`,
    ttlSeconds: 60,
    maxTtlSeconds: 600,
    renewable: true,
    issuedAt: 1_000_000,
    expiresAt: 1_060_000,
    ...over,
  };
}

function runContract(name: string, make: () => LeaseStore) {
  describe(`LeaseStore contract — ${name}`, () => {
    it("insert then get returns an equal lease", async () => {
      const s = make();
      await s.insert(lease("a"));
      expect(await s.get("a")).toMatchObject({ id: "a", mount: "database/", ttlSeconds: 60 });
    });

    it("get of an absent id is undefined", async () => {
      expect(await make().get("nope")).toBeUndefined();
    });

    it("list returns every inserted lease", async () => {
      const s = make();
      await s.insert(lease("a"));
      await s.insert(lease("b", { taskId: "t1" }));
      const ids = (await s.list()).map((l) => l.id).sort();
      expect(ids).toEqual(["a", "b"]);
    });

    it("update applies the mutator and persists the result", async () => {
      const s = make();
      await s.insert(lease("a"));
      const out = await s.update("a", (l) => ({ ...l, expiresAt: 2_000_000 }));
      expect(out?.expiresAt).toBe(2_000_000);
      expect((await s.get("a"))?.expiresAt).toBe(2_000_000);
    });

    it("update of an absent id returns undefined and writes nothing", async () => {
      const s = make();
      const out = await s.update("ghost", (l) => ({ ...l, expiresAt: 0 }));
      expect(out).toBeUndefined();
      expect(await s.list()).toEqual([]);
    });

    it("a throwing mutator aborts — the stored lease is untouched", async () => {
      const s = make();
      await s.insert(lease("a", { expiresAt: 1_060_000 }));
      await expect(
        s.update("a", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await s.get("a"))?.expiresAt).toBe(1_060_000);
    });

    it("delete removes the lease", async () => {
      const s = make();
      await s.insert(lease("a"));
      await s.delete("a");
      expect(await s.get("a")).toBeUndefined();
    });

    it("delete of an absent id is a no-op (no throw)", async () => {
      await expect(make().delete("ghost")).resolves.toBeUndefined();
    });

    it("returned leases are copies — mutating one does not corrupt the store", async () => {
      const s = make();
      await s.insert(lease("a"));
      const got = await s.get("a");
      (got as { expiresAt: number }).expiresAt = 0;
      expect((await s.get("a"))?.expiresAt).toBe(1_060_000);
    });

    it("round-trips nullable fields (revokedAt set, backendLeaseId/taskId absent)", async () => {
      const s = make();
      await s.insert({
        ...lease("a"),
        backendLeaseId: undefined,
        taskId: undefined,
        revokedAt: 1_055_000,
      });
      const got = await s.get("a");
      expect(got?.revokedAt).toBe(1_055_000);
      expect(got?.backendLeaseId).toBeUndefined();
      expect(got?.taskId).toBeUndefined();
    });
  });
}

runContract("InMemoryLeaseStore", () => new InMemoryLeaseStore());
