import type { Capability, Scope } from "./types";

/** Normalize a path prefix to "<trimmed>/" — single trailing slash, no leading slash. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}

/** Build a {@link Scope} with the prefix normalized once at construction. */
export function scope(pathPrefix: string, capabilities: readonly Capability[]): Scope {
  return { pathPrefix: normalizePrefix(pathPrefix), capabilities };
}

/**
 * True if `scopes` permit `capability` on `path`. A scope matches when its trailing-slash
 * prefix covers the path; `sudo` implies every capability. The path's leading slashes are
 * trimmed before matching, and the probe uses `<path>/` so segment boundaries are
 * respected (a `secret/` scope never spuriously matches `secret-other/foo`).
 *
 * Empty scope arrays always return false — callers decide what to do with that (a
 * higher-level engine may apply a default-allow / default-deny rule).
 */
export function scopeAllows(
  scopes: readonly Scope[],
  path: string,
  capability: Capability,
): boolean {
  const probe = `${path.trim().replace(/^\/+/, "")}/`;
  for (const s of scopes) {
    if (!probe.startsWith(s.pathPrefix)) continue;
    if (s.capabilities.includes(capability)) return true;
    if (s.capabilities.includes("sudo")) return true;
  }
  return false;
}
