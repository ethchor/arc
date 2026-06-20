/**
 * Tiny relative-time helpers. SSR-safe (no `Date.now()` in module scope), no dependencies —
 * keeps the audit "x days ago" / item "updated 3 days ago" / device "last seen 3h ago" copy
 * consistent across the app. Two helpers, one source:
 *
 *   • {@link relativeAgo}      → bare phrase: "just now", "3 min ago", "3h ago", "3d ago",
 *                                "2mo ago", "1y ago" — falls back to the locale date for
 *                                anything > ~10 years or unparseable input.
 *   • {@link daysSince}        → integer day count (signed), or `null` when unparseable —
 *                                what `analyseSecurity` thresholds against for the "old
 *                                password" bucket.
 *
 * These are *device-local* — they read `Date.now()`, never the server clock — so any drift
 * is the user's own clock, not arc's. Acceptable: the granularity is days, not seconds.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** "3 days ago" / "1y ago" / etc. Returns the locale date for anything older than ~10y. */
export function relativeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const diff = now - t;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < MONTH) return `${Math.round(diff / DAY)}d ago`;
  if (diff < YEAR) return `${Math.round(diff / MONTH)}mo ago`;
  const years = diff / YEAR;
  if (years < 10) return `${years < 2 ? "1" : Math.round(years)}y ago`;
  return new Date(t).toLocaleDateString();
}

/** Whole days between `iso` and now (positive when `iso` is in the past). `null` if unparseable. */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY);
}
