import type { Lease } from "./types";

/**
 * Persistence boundary for the lease registry. The {@link LeaseManager} owns all lifecycle
 * math (TTL clamping, the `issuedAt + maxTtl` ceiling, state derivation, validation); a
 * `LeaseStore` is *only* storage. Keeping the math in the manager means every backend
 * behaves identically; keeping storage behind this interface lets arc-server back the
 * registry with Postgres — so leases survive a server restart and stay consistent across
 * replicas — while `@arc/leasing` stays free of any framework dependency.
 *
 * **Atomicity contract.** {@link update} MUST be a single atomic read-modify-write. The
 * in-memory implementation gets this from Node's single-threaded event loop; a SQL
 * implementation must take a row lock (`SELECT … FOR UPDATE` on Postgres) so two replicas
 * can't lose a concurrent renew/revoke to a read-modify-write race. Every method returns
 * *copies* — a caller never holds a live reference to stored state.
 */
export interface LeaseStore {
  /** Persist a newly-issued lease. The id is caller-assigned (the manager's `idGen`). */
  insert(lease: Lease): Promise<void>;
  /** Read one lease by id, or `undefined` if absent. Returns a copy. */
  get(id: string): Promise<Lease | undefined>;
  /** Every tracked lease (copies). Order is unspecified; the caller sorts. */
  list(): Promise<Lease[]>;
  /**
   * Atomic read-modify-write under a row lock. Loads the lease, applies `mutate` to a copy,
   * persists the result, and returns it. Returns `undefined` if the id is absent. `mutate`
   * is synchronous and may throw to abort the whole operation (e.g. a {@link LeaseError}) —
   * the store must NOT persist a partial change in that case.
   */
  update(id: string, mutate: (lease: Lease) => Lease): Promise<Lease | undefined>;
  /** Hard-delete by id. No-op if absent. */
  delete(id: string): Promise<void>;
}

/**
 * Default {@link LeaseStore} — a process-local `Map`. Behaviourally identical to the original
 * in-memory `LeaseManager`, now behind the async store boundary. Atomic by virtue of Node's
 * single-threaded model (there is no `await` inside {@link update}'s critical section, so no
 * other task can interleave between read and write). NOT shared across processes — arc-server
 * swaps in a DB-backed store for multi-replica + restart-survival.
 */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();

  async insert(lease: Lease): Promise<void> {
    this.leases.set(lease.id, { ...lease });
  }

  async get(id: string): Promise<Lease | undefined> {
    const lease = this.leases.get(id);
    return lease ? { ...lease } : undefined;
  }

  async list(): Promise<Lease[]> {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  async update(id: string, mutate: (lease: Lease) => Lease): Promise<Lease | undefined> {
    const current = this.leases.get(id);
    if (!current) return undefined;
    // `mutate` sees a copy and may throw before we persist — so an aborted mutate leaves the
    // stored lease untouched (the throw propagates out of `update`).
    const next = mutate({ ...current });
    this.leases.set(id, { ...next });
    return { ...next };
  }

  async delete(id: string): Promise<void> {
    this.leases.delete(id);
  }
}
