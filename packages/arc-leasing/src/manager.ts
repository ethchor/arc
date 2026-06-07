import type { IssueLeaseInput, Lease, LeaseErrorCode, LeaseState } from "./types";

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
}

const defaultIdGen = (): string => globalThis.crypto.randomUUID();

/**
 * In-memory lease registry. Backend-agnostic: it tracks TTLs/renewals/revocations for leases
 * whose real credential lives in OpenBao or a plugin. Persistence is a concern for the caller
 * (e.g. arc-server can mirror this into its store); this class is the pure lifecycle logic.
 */
export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  private readonly clock: () => number;
  private readonly idGen: () => string;

  constructor(options: LeaseManagerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idGen = options.idGen ?? defaultIdGen;
  }

  issue(input: IssueLeaseInput): Lease {
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
    this.leases.set(lease.id, lease);
    return lease;
  }

  get(id: string): Lease | undefined {
    return this.leases.get(id);
  }

  list(): Lease[] {
    return [...this.leases.values()];
  }

  state(id: string, now: number = this.clock()): LeaseState | undefined {
    const lease = this.leases.get(id);
    return lease ? computeState(lease, now) : undefined;
  }

  /**
   * Extends the lease from *now* by `incrementSeconds` (default the lease's ttl), capped at the
   * hard `issuedAt + maxTtlSeconds` ceiling — matching Vault, where renew is relative to now,
   * not to the current expiry.
   */
  renew(id: string, incrementSeconds?: number): Lease {
    const lease = this.leases.get(id);
    if (!lease) throw new LeaseError("not_found", `no lease ${id}`);
    const now = this.clock();
    const st = computeState(lease, now);
    if (st === "revoked") throw new LeaseError("revoked", `lease ${id} is revoked`);
    if (st === "expired") throw new LeaseError("expired", `lease ${id} is expired`);
    if (!lease.renewable) throw new LeaseError("not_renewable", `lease ${id} is not renewable`);
    const incrementMs = (incrementSeconds ?? lease.ttlSeconds) * 1000;
    if (incrementMs <= 0) throw new LeaseError("invalid_ttl", "increment must be > 0");
    const hardCapMs = lease.issuedAt + lease.maxTtlSeconds * 1000;
    lease.expiresAt = Math.min(now + incrementMs, hardCapMs);
    return lease;
  }

  /** Explicitly revoke a lease. Terminal and idempotent. */
  revoke(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) throw new LeaseError("not_found", `no lease ${id}`);
    if (lease.revokedAt === undefined) lease.revokedAt = this.clock();
  }

  /** Revoke every *active* lease whose mount starts with `mountPrefix`. Returns the count revoked. */
  revokePrefix(mountPrefix: string): number {
    const prefix = normalizeMount(mountPrefix);
    const now = this.clock();
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.mount.startsWith(prefix) && computeState(lease, now) === "active") {
        lease.revokedAt = now;
        count++;
      }
    }
    return count;
  }

  /**
   * Revoke every *active* lease tagged with `taskId` (ADR-005 Engine-C cascade). Returns the
   * count revoked. Closing an agent task calls this so every credential the agent minted
   * during the task is revoked in one shot — the "access opened during a task closes when
   * the task does" guarantee. Idempotent; already-revoked/expired leases are skipped.
   */
  revokeByTaskId(taskId: string): number {
    const now = this.clock();
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId && computeState(lease, now) === "active") {
        lease.revokedAt = now;
        count++;
      }
    }
    return count;
  }

  /** Drop expired and revoked leases from memory. Returns the ids removed. */
  sweep(now: number = this.clock()): string[] {
    const removed: string[] = [];
    for (const [id, lease] of this.leases) {
      if (computeState(lease, now) !== "active") {
        this.leases.delete(id);
        removed.push(id);
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
