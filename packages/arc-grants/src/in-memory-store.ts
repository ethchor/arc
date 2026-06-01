import type { Policy, PolicyStore } from "./types";

/**
 * Process-local {@link PolicyStore}. Persistence is a follow-up (Postgres-backed store
 * will live in arc-server's database module); the in-memory version covers dev/test and
 * tiny single-process deployments.
 *
 * Policies are stored by name and attached to subjects via a separate mapping, the same
 * shape Vault/OpenBao use ("attach policy `foo` to entity `e1`") — so a single policy
 * can be reused across many subjects without copying its scopes.
 */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, Policy>();
  private readonly bySubject = new Map<string, Set<string>>();

  upsertPolicy(policy: Policy): void {
    this.policies.set(policy.name, policy);
  }

  removePolicy(name: string): boolean {
    return this.policies.delete(name);
  }

  attach(subject: string, policyName: string): void {
    if (!this.policies.has(policyName)) {
      throw new Error(`unknown policy: ${policyName}`);
    }
    let set = this.bySubject.get(subject);
    if (!set) {
      set = new Set();
      this.bySubject.set(subject, set);
    }
    set.add(policyName);
  }

  detach(subject: string, policyName: string): boolean {
    const set = this.bySubject.get(subject);
    if (!set) return false;
    const removed = set.delete(policyName);
    if (removed && set.size === 0) this.bySubject.delete(subject);
    return removed;
  }

  listPolicies(): Policy[] {
    return [...this.policies.values()];
  }

  getPoliciesForSubject(subject: string): Policy[] {
    const names = this.bySubject.get(subject);
    if (!names) return [];
    const out: Policy[] = [];
    for (const name of names) {
      const policy = this.policies.get(name);
      if (policy) out.push(policy);
    }
    return out;
  }
}
