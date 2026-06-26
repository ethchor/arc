import type { Lease, LeaseStore } from "@arc/leasing";
import type { Repository } from "typeorm";
import { VaultLeaseEntity } from "../database/entities";

/**
 * Postgres-backed {@link LeaseStore} (#113). Backs the arc {@link LeaseManager} with the
 * `vault_leases` table so leases survive a server restart and stay consistent across
 * replicas — the in-memory `Map` the manager shipped with did neither. All lifecycle math
 * stays in `@arc/leasing`; this class is *only* storage plus the one piece that can't live
 * in a framework-free package: a real row lock around the read-modify-write.
 *
 * **Atomicity.** {@link update} runs inside a transaction and, on Postgres, takes a
 * `SELECT … FOR UPDATE` row lock (`setLock("pessimistic_write")`) so two replicas can't
 * lose a concurrent renew/revoke to a read-modify-write race. On SQLite/sql.js (dev + test)
 * there is no `FOR UPDATE`; the lock is skipped and the transaction's serialized writes on
 * the single connection are sufficient — that path is never multi-replica anyway.
 */
export class TypeOrmLeaseStore implements LeaseStore {
  /** True when the underlying driver supports `SELECT … FOR UPDATE` (Postgres family). */
  private readonly supportsRowLock: boolean;

  constructor(private readonly repo: Repository<VaultLeaseEntity>) {
    this.supportsRowLock = repo.manager.connection.options.type === "postgres";
  }

  async insert(lease: Lease): Promise<void> {
    await this.repo.insert(toRow(lease));
  }

  async get(id: string): Promise<Lease | undefined> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? toLease(row) : undefined;
  }

  async list(): Promise<Lease[]> {
    const rows = await this.repo.find();
    return rows.map(toLease);
  }

  async update(id: string, mutate: (lease: Lease) => Lease): Promise<Lease | undefined> {
    return this.repo.manager.transaction(async (em) => {
      const txRepo = em.getRepository(VaultLeaseEntity);
      const qb = txRepo.createQueryBuilder("l").where("l.id = :id", { id });
      // The lock is the whole point of a persistent store: hold the row from the SELECT
      // through the UPDATE so a renew on replica A and a revoke on replica B serialize
      // instead of clobbering each other. sql.js has no row locks but is single-connection,
      // so the surrounding transaction already serializes the two writers.
      if (this.supportsRowLock) qb.setLock("pessimistic_write");
      const row = await qb.getOne();
      if (!row) return undefined;
      // `mutate` may throw (e.g. LeaseError on a revoked/expired lease). The throw escapes
      // the transaction callback, TypeORM rolls back, and nothing is persisted.
      const next = mutate(toLease(row));
      await txRepo.update({ id }, toRow(next));
      // `next` is already a fresh object from the mutator's spread — safe to hand back as
      // the store's copy without re-reading the row.
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

/**
 * Row → domain. Nullable columns (`backendLeaseId`, `revokedAt`, `taskId`) map back to the
 * `Lease`'s *absent* optionals rather than `null`, so the round-trip matches the in-memory
 * store exactly and the manager's `=== undefined` checks behave identically. The `bigint`
 * epoch-ms columns already come back as numbers via the entity transformer.
 */
function toLease(row: VaultLeaseEntity): Lease {
  return {
    id: row.id,
    mount: row.mount,
    ...(row.backendLeaseId != null ? { backendLeaseId: row.backendLeaseId } : {}),
    ttlSeconds: row.ttlSeconds,
    maxTtlSeconds: row.maxTtlSeconds,
    renewable: row.renewable,
    issuedAt: Number(row.issuedAt),
    expiresAt: Number(row.expiresAt),
    ...(row.revokedAt != null ? { revokedAt: Number(row.revokedAt) } : {}),
    ...(row.taskId != null ? { taskId: row.taskId } : {}),
  };
}

/**
 * Domain → row. Absent optionals become explicit `null` so a column that was previously set
 * gets cleared on update (the epoch-ms transformer also coerces `undefined → null`). The
 * auto-managed `createdAt` is intentionally omitted from both insert and update so it keeps
 * its DB default on insert and is left untouched on update.
 */
function toRow(lease: Lease): Partial<VaultLeaseEntity> {
  return {
    id: lease.id,
    mount: lease.mount,
    backendLeaseId: lease.backendLeaseId ?? null,
    ttlSeconds: lease.ttlSeconds,
    maxTtlSeconds: lease.maxTtlSeconds,
    renewable: lease.renewable,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    revokedAt: lease.revokedAt ?? null,
    taskId: lease.taskId ?? null,
  };
}
