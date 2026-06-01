import { scopeAllows } from "./scope";
import type {
  Capability,
  Decision,
  DefaultMode,
  Policy,
  PolicyStore,
  Scope,
} from "./types";

export interface PolicyEngineOptions {
  store: PolicyStore;
  /**
   * Decision when a subject has zero attached policies. Defaults to `"deny"` — the safe
   * production posture. Dev/test harnesses can pass `"allow"` to keep working until policy
   * admin tooling lands.
   */
  defaultMode?: DefaultMode;
}

/**
 * Path-and-capability ACL engine. Resolves a subject + path + capability to allow/deny
 * by walking the subject's policies' scopes and matching with {@link scopeAllows}.
 *
 * Semantics:
 *  - Any matching scope that grants the capability → allow.
 *  - No matching scope, but the subject has at least one policy → deny ("you have
 *    policies, but none cover this").
 *  - No policies at all → fall back to `defaultMode`.
 *  - `sudo` capability is honored via `scopeAllows`.
 */
export class PolicyEngine {
  private readonly store: PolicyStore;
  private readonly defaultMode: DefaultMode;

  constructor(opts: PolicyEngineOptions) {
    this.store = opts.store;
    this.defaultMode = opts.defaultMode ?? "deny";
  }

  /**
   * Decide if `subject` can `capability` on `path`. Returns a structured {@link Decision}
   * + reason so callers can log / audit a denial without re-running the engine.
   */
  async decide(subject: string, path: string, capability: Capability): Promise<Decision> {
    const result = await this.decideDetailed(subject, path, capability);
    return result.decision;
  }

  /**
   * Like {@link decide} but returns the matched scope (if any) and the reason chain. Used
   * by the audit log to record *why* a request was allowed or denied.
   */
  async decideDetailed(
    subject: string,
    path: string,
    capability: Capability,
  ): Promise<DetailedDecision> {
    const policies = await this.store.getPoliciesForSubject(subject);
    if (policies.length === 0) {
      return { decision: this.defaultMode, reason: "no-policies", policies: [] };
    }
    const flatScopes: Scope[] = policies.flatMap((p) => [...p.scopes]);
    if (scopeAllows(flatScopes, path, capability)) {
      return { decision: "allow", reason: "scope-match", policies: policies.map((p) => p.name) };
    }
    return { decision: "deny", reason: "no-matching-scope", policies: policies.map((p) => p.name) };
  }
}

export interface DetailedDecision {
  decision: Decision;
  reason: "scope-match" | "no-matching-scope" | "no-policies";
  /** Names of the policies that were considered. Empty when no-policies. */
  policies: string[];
}

export type { Policy };
