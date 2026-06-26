/**
 * Postgres-only concurrency proof for {@link TypeOrmLeaseStore}'s row lock (#113). Runs ONLY
 * when `DATABASE_URL` points at Postgres — otherwise the whole describe is skipped so the
 * default `pnpm test` stays green without a database, mirroring the openbao-adapter's
 * `BAO_ADDR`-gated integration suite.
 *
 * Why it exists: the sql.js store spec can't exercise `SELECT … FOR UPDATE` (SQLite has no
 * row locks), so the multi-replica guarantee — concurrent renew/revoke serialize instead of
 * losing a write — is only verifiable here. Both tests below would FAIL if the
 * `pessimistic_write` lock were dropped: without it, concurrent read-modify-write transactions
 * under READ COMMITTED read the same stale row and clobber each other (lost update).
 *
 * Run it:
 *   DATABASE_URL=postgres://user:pw@localhost:5432/arc pnpm --filter @arc/server test
 */
import { DataSource } from "typeorm";
import type { Lease } from "@arc/leasing";
import { VaultLeaseEntity } from "../database/entities";
import { TypeOrmLeaseStore } from "./typeorm-lease-store";

const url = process.env.DATABASE_URL ?? "";
const isPg = /^postgres(ql)?:\/\//.test(url);
// jest has no describe.skipIf — pick describe vs describe.skip up front.
const pgDescribe = isPg ? describe : describe.skip;

function lease(id: string, over: Partial<Lease> = {}): Lease {
  return {
    id,
    mount: "database/",
    backendLeaseId: `backend-${id}`,
    ttlSeconds: 60,
    maxTtlSeconds: 600,
    renewable: true,
    issuedAt: 1_000_000,
    expiresAt: 0,
    ...over,
  };
}

pgDescribe("TypeOrmLeaseStore — Postgres row-lock concurrency (#113)", () => {
  let ds: DataSource;
  let store: TypeOrmLeaseStore;

  beforeAll(async () => {
    // A single DataSource with the pg driver's default connection pool (max ~10): each
    // concurrent transaction grabs its own physical connection, so the row lock is contended
    // for real even from one DataSource.
    ds = new DataSource({
      type: "postgres",
      url,
      entities: [VaultLeaseEntity],
      synchronize: true,
    });
    await ds.initialize();
    store = new TypeOrmLeaseStore(ds.getRepository(VaultLeaseEntity));
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.getRepository(VaultLeaseEntity).clear();
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    await ds.getRepository(VaultLeaseEntity).clear();
  });

  it("serializes N concurrent read-modify-write updates with no lost update", async () => {
    const N = 20;
    await store.insert(lease("race", { expiresAt: 0 }));
    // Each update reads expiresAt and writes +1. Under SELECT…FOR UPDATE every transaction
    // holds the row from read through COMMIT, so the increments serialize and the final value
    // is exactly N. Drop the lock and concurrent readers see stale values → final < N.
    await Promise.all(
      Array.from({ length: N }, () =>
        store.update("race", (l) => ({ ...l, expiresAt: l.expiresAt + 1 })),
      ),
    );
    expect((await store.get("race"))?.expiresAt).toBe(N);
  });

  it("a renew racing a revoke on one lease: both land, neither is lost", async () => {
    await store.insert(lease("rv", { expiresAt: 1_000 }));
    // The lock serializes the two; whichever commits second re-reads the first's row (the
    // store persists the full row), so the final state carries BOTH mutations instead of one
    // clobbering the other. Without the lock the loser's field reverts.
    await Promise.all([
      store.update("rv", (l) => ({ ...l, expiresAt: l.expiresAt + 5_000 })),
      store.update("rv", (l) => ({ ...l, revokedAt: 1_058_000 })),
    ]);
    const got = await store.get("rv");
    expect(got?.expiresAt).toBe(6_000);
    expect(got?.revokedAt).toBe(1_058_000);
  });
});
