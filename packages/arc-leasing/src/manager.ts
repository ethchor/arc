import type { IssueLeaseInput, Lease, LeaseErrorCode, LeaseState } from "./types";
import { InMemoryLeaseStore, type LeaseStore } from "./store";

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;
  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

export interface LeaseManagerOptions {
  /** Returns the current time as unix epoch ms. Injectable for deterministic tests. */
  clock?: () => number;
  /** Returns a fresh unique lease id. Injectable for deterministic tests. */
  idGen?: () => string;
  /**
   * Persistence backend. Defaults to a process-local {@link InMemoryLeaseStore} (the original
   * behaviour). arc-server injects a Postgres-backed store so leases survive a restart and
   * stay consistent across replicas — see issue #113.
   */
  store?: LeaseStore;
}

const defaultIdGen = (): string => globalThis.crypto.randomUUID();

/**
 * Backend-agnostic lease lifecycle: tracks TTLs/renewals/revocations for leases whose real
 * credential lives in OpenBao or a plugin. All the *math* (TTL clamping, the hard
 * `issuedAt + maxTtl` ceiling, state derivation, validation) lives here; *persistence* is
 * delegated to a pluggable {@link LeaseStore}. The default store is in-memory, so the simple
 * `new LeaseManager()` keeps its original semantics; arc-server passes a TypeORM-backed store.
 *
 * Every method is async because a DB-backed store is async — the cost of doing renew/revoke
 * under a real row lock (the only way to be correct across replicas).
 */
export class LeaseManager {
  private readonly store: LeaseStore;
  private readonly clock: () => number;
  private readonly idGen: () => string;

  constructor(options: LeaseManagerOptions = {}) {
    this.store = options.store ?? new InMemoryLeaseStore();
    this.clock = options.clock ?? Date.now;
    this.idGen = options.idGen ?? defaultIdGen;
  }

  async issue(input: IssueLeaseInput): Promise<Lease> {
    const { ttlSeconds } = input;
    const maxTtlSeconds = input.maxTtlSeconds ?? ttlSeconds;
    if (ttlSeconds <= 0) throw new LeaseError("invalid_ttl", "ttlSeconds must be > 0");
    if (maxTtlSeconds < ttlSeconds) {
      throw new LeaseError("invalid_ttl", "maxTtlSeconds must be >= ttlSeconds");
    }
    const now = this.clock();
    const lease: Lease = {
      id: this.idGen(),
      mount: normalizeMount(input.mount),
      backendLeaseId: input.backendLeaseId,
      ttlSeconds,
      maxTtlSeconds,
      renewable: input.renewable ?? true,
      issuedAt: now,
      expiresAt: now + ttlSeconds * 1000,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    };
    await this.store.insert(lease);
    return lease;
  }

  async get(id: string): Promise<Lease | undefined> {
    return this.store.get(id);
  }

  async list(): Promise<Lease[]> {
    return this.store.list();
  }

  async state(id: string, now: number = this.clock()): Promise<LeaseState | undefined> {
    const lease = await this.store.get(id);
    return lease ? computeState(lease, now) : undefined;
  }

  /**
   * Extends the lease from *now* by `incrementSeconds` (default the lease's ttl), capped at the
   * hard `issuedAt + maxTtlSeconds` ceiling — matching Vault, where renew is relative to now,
   * not to the current expiry. The whole read-validate-write happens inside the store's atomic
   * {@link LeaseStore.update} so a concurrent renew/revoke on another replica can't be lost.
   */
  async renew(id: string, incrementSeconds?: number): Promise<Lease> {
    const clock = this.clock;
    const updated = await this.store.update(id, (lease) => {
      const now = clock();
      const st = computeState(lease, now);
      if (st === "revoked") throw new LeaseError("revoked", `lease ${id} is revoked`);
      if (st === "expired") throw new LeaseError("expired", `lease ${id} is expired`);
      if (!lease.renewable) throw new LeaseError("not_renewable", `lease ${id} is not renewable`);
      const incrementMs = (incrementSeconds ?? lease.ttlSeconds) * 1000;
      if (incrementMs <= 0) throw new LeaseError("invalid_ttl", "increment must be > 0");
      const hardCapMs = lease.issuedAt + lease.maxTtlSeconds * 1000;
      return { ...lease, expiresAt: Math.min(now + incrementMs, hardCapMs) };
    });
    if (!updated) throw new LeaseError("not_found", `no lease ${id}`);
    return updated;
  }

  /** Explicitly revoke a lease. Terminal and idempotent. */
  async revoke(id: string): Promise<void> {
    const clock = this.clock;
    const updated = await this.store.update(id, (lease) =>
      lease.revokedAt === undefined ? { ...lease, revokedAt: clock() } : lease,
    );
    if (!updated) throw new LeaseError("not_found", `no lease ${id}`);
  }

  /** Revoke every *active* lease whose mount starts with `mountPrefix`. Returns the count revoked. */
  async revokePrefix(mountPrefix: string): Promise<number> {
    const prefix = normalizeMount(mountPrefix);
    const now = this.clock();
    const all = await this.store.list();
    let count = 0;
    for (const lease of all) {
      if (lease.mount.startsWith(prefix) && computeState(lease, now) === "active") {
        await this.store.update(lease.id, (l) =>
          l.revokedAt === undefined ? { ...l, revokedAt: now } : l,
        );
        count++;
      }
    }
    return count;
  }

  /**
   * Revoke every *active* lease tagged with `taskId` (ADR-005 Engine-C cascade). Returns the
   * count revoked. Closing an agent task calls this so every credential the agent minted
   * during the task is revoked in one shot — the "access opened during a task closes when the
   * task does" guarantee. Idempotent; already-revoked/expired leases are skipped.
   */
  async revokeByTaskId(taskId: string): Promise<number> {
    const now = this.clock();
    const all = await this.store.list();
    let count = 0;
    for (const lease of all) {
      if (lease.taskId === taskId && computeState(lease, now) === "active") {
        await this.store.update(lease.id, (l) =>
          l.revokedAt === undefined ? { ...l, revokedAt: now } : l,
        );
        count++;
      }
    }
    return count;
  }

  /**
   * Drop terminal (expired or revoked) leases from the store. Returns the ids removed. With a
   * DB-backed store this is the table-pruning janitor — without it the `vault_leases` table
   * grows forever (the in-memory store used to be cleared by process restart). `olderThanMs`
   * keeps recently-terminal leases around (so the operator UI can still show them) and only
   * prunes ones whose terminal moment is older than `now - olderThanMs`; the default of `0`
   * prunes every non-active lease (the original behaviour).
   */
  async sweep(now: number = this.clock(), opts: { olderThanMs?: number } = {}): Promise<string[]> {
    const cutoff = now - (opts.olderThanMs ?? 0);
    const all = await this.store.list();
    const removed: string[] = [];
    for (const lease of all) {
      if (computeState(lease, now) === "active") continue;
      const terminalAt = lease.revokedAt ?? lease.expiresAt;
      if (terminalAt <= cutoff) {
        await this.store.delete(lease.id);
        removed.push(lease.id);
      }
    }
    return removed;
  }
}

export function computeState(lease: Lease, now: number): LeaseState {
  if (lease.revokedAt !== undefined) return "revoked";
  if (now >= lease.expiresAt) return "expired";
  return "active";
}

/** Normalize a mount path to a single trailing slash, no leading slash (e.g. "/db/pg/" -> "db/pg/"). */
export function normalizeMount(mount: string): string {
  const trimmed = mount.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}
