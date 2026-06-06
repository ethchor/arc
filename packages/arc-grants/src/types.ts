/**
 * Policy verbs mirroring Vault / OpenBao capability names. `sudo` implies every other
 * capability — it's a separate name (not a wildcard) so policies that grant it are easy
 * to find in an audit.
 */
export type Capability = "create" | "read" | "update" | "delete" | "list" | "sudo";

/**
 * A single grant: which capabilities are allowed under a path prefix. Prefix is always
 * normalized to a single trailing slash on construction, so `secret/` covers `secret/foo`
 * but never `secret-other/foo` — slash-segment safety, same rule as MountRegistry.
 */
export interface Scope {
  pathPrefix: string;
  capabilities: readonly Capability[];
}

/** A named bundle of scopes. Policies attach to identities (users, groups). */
export interface Policy {
  name: string;
  scopes: readonly Scope[];
}

export type Decision = "allow" | "deny";

/**
 * Where the engine reads policies for a subject (user id, service-account id, etc.). The
 * subject is opaque to the engine — the policy layer doesn't care whether it's a vault
 * userId or a plugin-issued identity, just that it's a stable string handle.
 *
 * This is the *read* contract the {@link PolicyEngine} depends on. Admin tooling that
 * mutates policies works against {@link MutablePolicyStore} instead.
 */
export interface PolicyStore {
  /** Returns the policies attached to this subject, or `[]` if none. Never throws on miss. */
  getPoliciesForSubject(subject: string): Promise<Policy[]> | Policy[];
}

/**
 * The admin-facing store contract: read (via {@link PolicyStore}) plus create/attach/detach
 * for direct (subject → policy) attachments and group memberships + group → policy
 * attachments. Every method may be sync or async so an in-memory store and a
 * database-backed store both satisfy it.
 *
 * Behavioral contract shared by all implementations:
 *  - `attach` throws if the policy name is unknown (catches admin typos early) and is
 *    idempotent for an already-attached pair.
 *  - `detach` returns whether anything was removed (idempotent: false on a no-op).
 *  - `getPoliciesForSubject` returns the **union** of (a) policies attached directly to
 *    the subject and (b) policies attached to every group the subject is a member of.
 *    Duplicates (same policy reached via multiple paths) appear once. Stale attachments
 *    — a policy removed but the link lingering — are silently filtered.
 *  - Groups are opaque string identifiers, just like subjects. The store doesn't validate
 *    group existence on `addToGroup` — there's no "groups table" separate from
 *    memberships + group-policy attachments. A group with zero members and zero policies
 *    doesn't exist; it springs into existence when something attaches to it.
 */
export interface MutablePolicyStore extends PolicyStore {
  upsertPolicy(policy: Policy): Promise<void> | void;
  removePolicy(name: string): Promise<boolean> | boolean;
  attach(subject: string, policyName: string): Promise<void> | void;
  detach(subject: string, policyName: string): Promise<boolean> | boolean;
  listPolicies(): Promise<Policy[]> | Policy[];

  // -- groups --

  /** Add `subject` to `groupName`. Idempotent. */
  addToGroup(subject: string, groupName: string): Promise<void> | void;
  /** Remove `subject` from `groupName`. Returns whether anything was removed. */
  removeFromGroup(subject: string, groupName: string): Promise<boolean> | boolean;
  /** Attach `policyName` to `groupName`. Throws if the policy is unknown. Idempotent. */
  attachToGroup(groupName: string, policyName: string): Promise<void> | void;
  /** Detach `policyName` from `groupName`. Returns whether anything was removed. */
  detachFromGroup(groupName: string, policyName: string): Promise<boolean> | boolean;
  /** Groups a subject belongs to (sorted, deduped). Empty when the subject is in none. */
  listGroupsForSubject(subject: string): Promise<string[]> | string[];
  /** Subjects in a group (sorted, deduped). Useful for admin UIs. */
  listSubjectsInGroup(groupName: string): Promise<string[]> | string[];
  /** Policy names attached to a group (sorted, deduped). */
  listGroupPolicies(groupName: string): Promise<string[]> | string[];
}

/**
 * Default decision when a subject has zero policies. Production should use `"deny"`; the
 * `"allow"` default exists so dev / test harnesses without admin tooling don't grind to a
 * halt the moment policy enforcement is enabled.
 */
export type DefaultMode = "allow" | "deny";
