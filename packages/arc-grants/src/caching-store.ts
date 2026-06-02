import type { MutablePolicyStore, Policy } from "./types";

export interface CachingPolicyStoreOptions {
  store: MutablePolicyStore;
  /** Cache TTL in milliseconds. Default 30_000 (30s). 0 disables read caching entirely. */
  ttlMs?: number;
  /** Injectable now-clock so tests can advance time deterministically. */
  clock?: () => number;
}

interface CacheEntry {
  policies: Policy[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Per-subject read cache around any {@link MutablePolicyStore}. Eliminates the two indexed
 * queries `CapabilityGuard` does on every `/v1/*` request by memoizing
 * `getPoliciesForSubject` for `ttlMs`. All mutations invalidate the cache so an admin who
 * just attached a policy doesn't have to wait for the TTL to elapse before the new
 * permission takes effect.
 *
 * Invalidation strategy (correctness-first, low cardinality):
 *  - `attach`/`detach(subject, _)` → drop just that subject's entry.
 *  - `upsertPolicy`/`removePolicy` → drop the entire cache. A policy edit could change
 *    *any* attached subject's effective scopes, and we don't track the reverse
 *    (policy → subjects) index here. A future refinement could index attachments by
 *    policy and selectively invalidate; the all-flush is fine until profiling says otherwise.
 *
 * Behavior preserves the {@link MutablePolicyStore} contract semantics — same
 * unknown-policy throw on attach, same idempotent detach return value, same stale-attachment
 * tolerance on read.
 */
export class CachingPolicyStore implements MutablePolicyStore {
  private readonly store: MutablePolicyStore;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: CachingPolicyStoreOptions) {
    this.store = opts.store;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  async getPoliciesForSubject(subject: string): Promise<Policy[]> {
    if (this.ttlMs > 0) {
      const now = this.clock();
      const hit = this.entries.get(subject);
      if (hit && hit.expiresAt > now) return hit.policies;
    }
    const fresh = await this.store.getPoliciesForSubject(subject);
    if (this.ttlMs > 0) {
      this.entries.set(subject, {
        policies: fresh,
        expiresAt: this.clock() + this.ttlMs,
      });
    }
    return fresh;
  }

  async upsertPolicy(policy: Policy): Promise<void> {
    await this.store.upsertPolicy(policy);
    this.entries.clear();
  }

  async removePolicy(name: string): Promise<boolean> {
    const removed = await this.store.removePolicy(name);
    this.entries.clear();
    return removed;
  }

  async attach(subject: string, policyName: string): Promise<void> {
    await this.store.attach(subject, policyName);
    this.entries.delete(subject);
  }

  async detach(subject: string, policyName: string): Promise<boolean> {
    const removed = await this.store.detach(subject, policyName);
    this.entries.delete(subject);
    return removed;
  }

  async listPolicies(): Promise<Policy[]> {
    // Not cached: low-frequency admin operation, always wants fresh data.
    return this.store.listPolicies();
  }

  // -- introspection for tests --

  /** Number of cached subjects (post-eviction). Test-only convenience. */
  size(): number {
    return this.entries.size;
  }

  /** Drop every cached entry. Equivalent to a mutating call, but explicit. */
  clear(): void {
    this.entries.clear();
  }
}
