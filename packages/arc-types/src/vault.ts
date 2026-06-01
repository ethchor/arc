/**
 * Cross-package vault domain types: shape of vault identities, membership roles, and
 * vault types. The wire and storage forms agree, so all clients (server entities, SDK,
 * web UI, CLI) reference the same string union.
 */

/** Membership roles, ordered by capability (`owner` is strictest). */
export type MemberRole = "owner" | "admin" | "editor" | "viewer";

export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "admin", "editor", "viewer"];

/** Vault kinds. `personal` is a one-member vault (docs/07 §7.1). */
export type VaultType = "personal" | "team" | "org";

export const VAULT_TYPES: readonly VaultType[] = ["personal", "team", "org"];
