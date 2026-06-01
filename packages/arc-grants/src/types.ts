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
 */
export interface PolicyStore {
  /** Returns the policies attached to this subject, or `[]` if none. Never throws on miss. */
  getPoliciesForSubject(subject: string): Promise<Policy[]> | Policy[];
}

/**
 * Default decision when a subject has zero policies. Production should use `"deny"`; the
 * `"allow"` default exists so dev / test harnesses without admin tooling don't grind to a
 * halt the moment policy enforcement is enabled.
 */
export type DefaultMode = "allow" | "deny";
