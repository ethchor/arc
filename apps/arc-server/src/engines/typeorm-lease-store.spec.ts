/**
 * {@link TypeOrmLeaseStore} held to the same behavioural contract `@arc/leasing`'s
 * `InMemoryLeaseStore` passes — re-asserted here against a real sql.js DataSource so the
 * persistent path (mapping, nullable round-trip, transactional update, copy-semantics) is
 * proven independently. Plus the two properties only a persistent store can have: a lease
 * survives being read through a *different* store instance over the same database (#113's
 * restart-survival, modelled without an actual process bounce since sql.js is in-memory),
 * and a renew is durable across instances.
 *
 * sql.js has no `SELECT … FOR UPDATE`, so the row lock is skipped here (the store detects a
 * non-Postgres driver) and this suite covers the transactional read-modify-write + rollback,
 * not the lock itself. The actual cross-replica lock is proven in
 * `typeorm-lease-store.pg.spec.ts`, which runs against a real Postgres only when
 * `DATABASE_URL` is set — skipped in the default `pnpm test` run, mirroring the adapter's
 * `BAO_ADDR`-gated integration suite.
 */
import { DataSource, type Repository } from "typeorm";
import type { Lease } from "@arc/leasing";
import { VaultLeaseEntity } from "../database/entities";
import { TypeOrmLeaseStore } from "./typeorm-lease-store";

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

describe("TypeOrmLeaseStore — LeaseStore contract (sql.js)", () => {
  let ds: DataSource;
  let repo: Repository<VaultLeaseEntity>;

  beforeAll(async () => {
    ds = new DataSource({
      type: "sqljs",
      autoSave: false,
      entities: [VaultLeaseEntity],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(VaultLeaseEntity);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  const make = () => new TypeOrmLeaseStore(repo);

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

  it("stores epoch-ms timestamps as numbers (bigint transformer round-trip)", async () => {
    const s = make();
    // A timestamp larger than 2^31 proves the bigint column (not int) and the transformer
    // both behave — epoch-ms in 2025 is ~1.7e12, well past int range.
    const big = 1_750_000_000_000;
    await s.insert(lease("a", { issuedAt: big, expiresAt: big + 60_000 }));
    const got = await s.get("a");
    expect(typeof got?.issuedAt).toBe("number");
    expect(got?.issuedAt).toBe(big);
    expect(got?.expiresAt).toBe(big + 60_000);
  });

  // -- restart / multi-replica survival (#113) --

  it("a lease written by one store instance is visible through another over the same DB", async () => {
    // Two store instances over one DataSource model two replicas (or the same server before
    // and after a restart) reading the one durable table.
    const writer = make();
    const reader = new TypeOrmLeaseStore(repo);
    await writer.insert(lease("shared", { taskId: "task-1" }));
    const seen = await reader.get("shared");
    expect(seen?.id).toBe("shared");
    expect(seen?.taskId).toBe("task-1");
  });

  it("a renew through one instance is durable and seen by another", async () => {
    const a = new TypeOrmLeaseStore(repo);
    const b = new TypeOrmLeaseStore(repo);
    await a.insert(lease("r"));
    await a.update("r", (l) => ({ ...l, expiresAt: 9_000_000 }));
    expect((await b.get("r"))?.expiresAt).toBe(9_000_000);
  });

  it("a revoke through one instance is seen as revoked by another", async () => {
    const a = new TypeOrmLeaseStore(repo);
    const b = new TypeOrmLeaseStore(repo);
    await a.insert(lease("v"));
    await a.update("v", (l) => ({ ...l, revokedAt: 1_058_000 }));
    expect((await b.get("v"))?.revokedAt).toBe(1_058_000);
  });
});
