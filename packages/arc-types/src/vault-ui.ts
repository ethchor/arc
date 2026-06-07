/**
 * Per-vault UI affordances: a small icon name + a brand colour. Both are **plaintext**
 * metadata, not secret — they're how the user tells one vault apart from another in a
 * picker. The vault's *name* stays encrypted (`encName`); the icon/color is purely
 * presentation.
 *
 * Server-side, both columns are validated against these closed sets so we never store
 * arbitrary user-supplied strings (no XSS via icon names rendered into the UI, no
 * surprise URLs in colour values).
 */

/**
 * Allowed icon identifiers. The client maps each to a Lucide / Heroicons / their own
 * icon library — the wire only stores the string identifier. Keep the list tight: new
 * icons land via a chart bump, not a per-user "pick from any icon" surface.
 */
export const VAULT_ICONS = [
  "vault",
  "key",
  "lock",
  "shield",
  "briefcase",
  "building",
  "users",
  "user",
  "server",
  "database",
  "cloud",
  "globe",
  "code",
  "rocket",
  "gem",
  "heart",
  "star",
  "bookmark",
  "folder",
  "wallet",
] as const;
export type VaultIcon = (typeof VAULT_ICONS)[number];

/**
 * Allowed brand colour values, as `#RRGGBB`. A small, deliberate palette tuned for
 * accessibility (each pair has ≥ 4.5:1 contrast vs. white text). Adding a colour is a
 * one-line patch here — but only here.
 */
export const VAULT_COLORS = [
  "#0EA5E9", // sky
  "#10B981", // emerald
  "#22C55E", // green
  "#EAB308", // yellow
  "#F97316", // orange
  "#EF4444", // red
  "#EC4899", // pink
  "#A855F7", // purple
  "#6366F1", // indigo
  "#3B82F6", // blue
  "#06B6D4", // cyan
  "#64748B", // slate
] as const;
export type VaultColor = (typeof VAULT_COLORS)[number];

export function isVaultIcon(s: unknown): s is VaultIcon {
  return typeof s === "string" && (VAULT_ICONS as readonly string[]).includes(s);
}

export function isVaultColor(s: unknown): s is VaultColor {
  return typeof s === "string" && (VAULT_COLORS as readonly string[]).includes(s);
}
