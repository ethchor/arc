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
 * The admin-facing store contract: read (via {@link PolicyStore}) plus create/attach/detach.
 * Every method may be sync or async so an in-memory store and a database-backed store both
 * satisfy it. `InMemoryPolicyStore` implements this synchronously; arc-server's TypeORM
 * store implements it against Postgres.
 *
 * Behavioral contract shared by all implementations:
 *  - `attach` throws if the policy name is unknown (catches admin typos early) and is
 *    idempotent for an already-attached (subject, policy) pair.
 *  - `detach` returns whether anything was removed (idempotent: false on a no-op).
 *  - `getPoliciesForSubject` tolerates stale attachments — if a policy was removed but an
 *    attachment lingers, it's silently filtered out rather than surfaced as a phantom.
 */
export interface MutablePolicyStore extends PolicyStore {
  upsertPolicy(policy: Policy): Promise<void> | void;
  removePolicy(name: string): Promise<boolean> | boolean;
  attach(subject: string, policyName: string): Promise<void> | void;
  detach(subject: string, policyName: string): Promise<boolean> | boolean;
  listPolicies(): Promise<Policy[]> | Policy[];
}

/**
 * Default decision when a subject has zero policies. Production should use `"deny"`; the
 * `"allow"` default exists so dev / test harnesses without admin tooling don't grind to a
 * halt the moment policy enforcement is enabled.
 */
export type DefaultMode = "allow" | "deny";
