import type { MutablePolicyStore, Policy } from "./types";

/**
 * Process-local {@link MutablePolicyStore}. Covers dev/test and tiny single-process
 * deployments; arc-server's TypeORM store implements the same contract against Postgres
 * so production deployments survive a restart.
 *
 * Storage shape (all in-memory Maps, no FKs):
 *  - `policies`: name → Policy
 *  - `bySubject`: subject → Set<policyName>          (direct attachments)
 *  - `groupMembers`: groupName → Set<subject>        (group memberships)
 *  - `groupPolicies`: groupName → Set<policyName>    (group → policy attachments)
 *
 * `getPoliciesForSubject` returns the union of the subject's direct policies + every
 * policy reached via a group the subject belongs to. Same shape Vault / OpenBao use.
 */
export class InMemoryPolicyStore implements MutablePolicyStore {
  private readonly policies = new Map<string, Policy>();
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly groupMembers = new Map<string, Set<string>>();
  private readonly groupPolicies = new Map<string, Set<string>>();

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

  // -- groups --

  addToGroup(subject: string, groupName: string): void {
    let set = this.groupMembers.get(groupName);
    if (!set) {
      set = new Set();
      this.groupMembers.set(groupName, set);
    }
    set.add(subject);
  }

  removeFromGroup(subject: string, groupName: string): boolean {
    const set = this.groupMembers.get(groupName);
    if (!set) return false;
    const removed = set.delete(subject);
    if (removed && set.size === 0) this.groupMembers.delete(groupName);
    return removed;
  }

  attachToGroup(groupName: string, policyName: string): void {
    if (!this.policies.has(policyName)) {
      throw new Error(`unknown policy: ${policyName}`);
    }
    let set = this.groupPolicies.get(groupName);
    if (!set) {
      set = new Set();
      this.groupPolicies.set(groupName, set);
    }
    set.add(policyName);
  }

  detachFromGroup(groupName: string, policyName: string): boolean {
    const set = this.groupPolicies.get(groupName);
    if (!set) return false;
    const removed = set.delete(policyName);
    if (removed && set.size === 0) this.groupPolicies.delete(groupName);
    return removed;
  }

  listGroupsForSubject(subject: string): string[] {
    const out: string[] = [];
    for (const [groupName, members] of this.groupMembers) {
      if (members.has(subject)) out.push(groupName);
    }
    return out.sort();
  }

  listSubjectsInGroup(groupName: string): string[] {
    return [...(this.groupMembers.get(groupName) ?? new Set<string>())].sort();
  }

  listGroupPolicies(groupName: string): string[] {
    return [...(this.groupPolicies.get(groupName) ?? new Set<string>())].sort();
  }

  /**
   * Union of direct attachments + every group the subject belongs to. Stale attachments
   * (policy removed but link lingering) are silently filtered out.
   */
  getPoliciesForSubject(subject: string): Policy[] {
    const wantedNames = new Set<string>();
    const direct = this.bySubject.get(subject);
    if (direct) for (const n of direct) wantedNames.add(n);
    for (const [groupName, members] of this.groupMembers) {
      if (!members.has(subject)) continue;
      const policies = this.groupPolicies.get(groupName);
      if (policies) for (const n of policies) wantedNames.add(n);
    }
    const out: Policy[] = [];
    for (const name of wantedNames) {
      const policy = this.policies.get(name);
      if (policy) out.push(policy);
    }
    return out;
  }
}
