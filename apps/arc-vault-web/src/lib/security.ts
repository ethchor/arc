import type { PulledItem } from "@arc/sdk";
import { asLogin, asTotp, itemTitle } from "./items";
import { daysSince } from "./datetime";

/** Past this many days a login is "old" (`mid` severity). Industry norm: rotate yearly. */
const OLD_DAYS = 365;
/** Past this many days a login is "very old" (`high` severity). */
const VERY_OLD_DAYS = 730;

/**
 * Client-side security analysis over already-decrypted vault items.
 *
 * Zero-knowledge invariant: every computation here runs on the device, on items already
 * decrypted under the user's vault key. Nothing in this module derives a network call,
 * touches the server, hashes against a remote breach list, or persists results anywhere.
 * The "your security score" surface is *what the user can see in their own vault*, full
 * stop — that's what makes it truthful.
 */

export type IssueKind = "weak" | "reused" | "old" | "exposed";

export interface FlaggedItem {
  id: string;
  title: string;
  /** A short, user-facing reason ("Reused across 3 sites"). */
  reason: string;
  kind: IssueKind;
  /** Severity for sorting + colouring. `high` = the danger plate; `mid` = the warning plate. */
  severity: "high" | "mid";
}

export interface SecurityReport {
  /** 0-100. Higher is better. */
  score: number;
  /** Buckets used by the Home dashboard breakdown bar. */
  buckets: {
    strong: number;
    weak: number;
    reused: number;
    old: number;
    twoFactor: number; // items with TOTP companion
    exposed: number; // logins found in a known breach (HIBP) — 0 until the opt-in check runs
    total: number;
  };
  flagged: FlaggedItem[];
}

/**
 * A small set of the most common passwords / base words. Not a full breach corpus (that's
 * what the opt-in HIBP k-anonymity check is for) — just the handful that sit at the very
 * top of every leak. We test the raw password *and* a de-leeted, punctuation-stripped
 * "core" against this set so `P@ssw0rd!` and `Passw0rd` collapse onto their base word.
 */
const COMMON = new Set([
  "password", "passwd", "p@ssword", "qwerty", "qwertyuiop", "letmein", "secret",
  "admin", "welcome", "iloveyou", "abc123", "monkey", "dragon", "sunshine",
  "princess", "football", "baseball", "superman", "trustno1", "master",
  "login", "starwars", "whatever", "freedom", "ninja", "azerty", "google",
]);

/** Leet substitutions, applied before the common-word lookup so `P@ssw0rd` → `password`.
 *  Only glyph→letter swaps belong here; trailing punctuation like `!` is stripped by
 *  {@link deleetCore}, not mapped to a letter (else `letmein!` wouldn't match `letmein`). */
const LEET: Record<string, string> = {
  "@": "a", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s",
};

/** Lower-case, de-leet, strip non-letters — the "base word" we match against {@link COMMON}. */
function deleetCore(pw: string): string {
  let out = "";
  for (const ch of pw.toLowerCase()) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, "");
}

/** Ordered alphabets we treat as predictable when a password walks along them (either
 *  direction): the latin alphabet, the digit run, and the three QWERTY keyboard rows. */
const SEQ_SETS = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** Length of the predictable run starting at `i`, walking `dir` (+1 ascending / -1 descending) in `set`. */
function runLength(s: string, i: number, set: string, dir: number): number {
  let idx = set.indexOf(s[i]!);
  if (idx < 0) return 1;
  let len = 1;
  while (i + len < s.length) {
    const next = set.indexOf(s[i + len]!);
    if (next < 0 || next !== idx + dir) break;
    idx = next;
    len++;
  }
  return len;
}

/** Characters carrying ~no entropy because they continue a sequence (`123`, `cba`, `qwert`):
 *  we keep the first character of each run of length ≥3 and discount the rest. */
function redundantFromSequences(pw: string): number {
  const s = pw.toLowerCase();
  let redundant = 0;
  for (let i = 0; i < s.length; ) {
    let best = 1;
    for (const set of SEQ_SETS) {
      best = Math.max(best, runLength(s, i, set, 1), runLength(s, i, set, -1));
    }
    if (best >= 3) {
      redundant += best - 1;
      i += best;
    } else {
      i += 1;
    }
  }
  return redundant;
}

/** Characters carrying ~no entropy because they repeat the previous one (`aaa`, `!!!!`). */
function redundantFromRepeats(pw: string): number {
  let redundant = 0;
  for (let i = 0; i < pw.length; ) {
    let len = 1;
    while (i + len < pw.length && pw[i + len] === pw[i]) len++;
    if (len >= 3) redundant += len - 1;
    i += len;
  }
  return redundant;
}

/**
 * Structure-aware password-strength score (0–4). The single source of truth for "how
 * strong is this password" across the app — the vault list's inline "weak" badge and the
 * security dashboard both classify through here so they can never disagree (see
 * {@link isWeakPassword}).
 *
 * Why not raw charset entropy: `length × log2(alphabet)` assumes every character is an
 * independent uniform draw, so it rates `vimu@123` (8 chars, three classes) at ~49 bits =
 * "strong" — nonsense, because it's a 4-letter word plus the sequence `123`. Real passwords
 * cluster into predictable shapes, so we estimate *effective* entropy instead:
 *
 *   1. Hard-floor known-common base words, including de-leeted (`P@ssw0rd!` → `password`).
 *   2. Discount characters that merely continue a sequence (`123`, `cba`) or repeat (`aaa`).
 *   3. Cap the ubiquitous "word + short number/symbol suffix" template (`vimu@123`,
 *      `Summer2024`, `hunter!1`) to ~30 bits — gated on a short letter core so genuine
 *      passphrases that happen to end in digits aren't penalised.
 *
 * This is a heuristic (a tiny, dependency-free cousin of zxcvbn's pattern matching), kept
 * fully on-device so the zero-knowledge invariant holds. It is intentionally conservative:
 * it would rather call a borderline password "fair" than wave a weak one through as strong.
 */
export function passwordStrength(pw: string): number {
  if (pw.length === 0) return 0;
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(deleetCore(pw))) return 1;

  let space = 0;
  if (/[a-z]/.test(pw)) space += 26;
  if (/[A-Z]/.test(pw)) space += 26;
  if (/[0-9]/.test(pw)) space += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) space += 33;
  const perChar = Math.log2(Math.max(space, 1));

  // Effective length: drop the characters that only continue a sequence or a repeat run.
  const redundant = Math.min(pw.length - 1, redundantFromSequences(pw) + redundantFromRepeats(pw));
  let bits = (pw.length - redundant) * perChar;

  // "word + optional separator + short digit run" — the dominant weak shape (`vimu@123`).
  const template = /^([A-Za-z]+)[^A-Za-z0-9]{0,2}\d{1,4}$/.exec(pw);
  if (template && template[1]!.length <= 12) bits = Math.min(bits, 30);

  // 0..4 scale on *effective* bits: <28 weak, 28-40 fair, 40-56 strong, >=56 excellent.
  if (bits < 28) return 1;
  if (bits < 40) return 2;
  if (bits < 56) return 3;
  return 4;
}

/**
 * The one "is this password weak" predicate for the whole UI. A login is weak when its
 * strength is `<= 2` (under ~40 bits of estimated entropy, or a known common password) —
 * exactly the threshold the security dashboard uses to populate its `weak` bucket. Empty
 * passwords aren't flagged here (an item may legitimately have no password field yet).
 */
export function isWeakPassword(pw: string): boolean {
  if (!pw) return false;
  return passwordStrength(pw) <= 2;
}

/**
 * Analyse the user's items. Pure function over already-decrypted state — the caller hands
 * us the items it already has in memory; we never re-fetch or send anything here.
 *
 * `exposed` is an optional itemId→breach-count map from the opt-in HIBP check (lib/breach).
 * When supplied, exposed logins are flagged (kind "exposed", high severity), excluded from
 * the "strong & unique" bucket, and weighed into the score. It's threaded in rather than
 * fetched here so this function stays pure + synchronous and the network call remains
 * strictly opt-in.
 *
 * `old`: each item carries an `updatedAt` from the server's `@UpdateDateColumn` — bumps on
 * every save (any field, incl. a password rotation). We flag past {@link OLD_DAYS} (1 year)
 * as `mid` and {@link VERY_OLD_DAYS} (2 years) as `high`. We say "Last updated …" rather
 * than "Last rotated …" because save-bumping is broader than a password change — but the
 * signal is still honest: a login the user hasn't touched in 2 years almost certainly
 * hasn't had its password rotated either.
 */
export function analyseSecurity(
  items: readonly PulledItem[],
  exposed?: ReadonlyMap<string, number>,
): SecurityReport {
  const logins = items.map((i) => ({ item: i, login: asLogin(i) })).filter((x) => x.login) as {
    item: PulledItem;
    login: NonNullable<ReturnType<typeof asLogin>>;
  }[];

  const totpCompanions = new Set<string>();
  for (const i of items) {
    const t = asTotp(i);
    if (t?.issuer) totpCompanions.add(t.issuer.toLowerCase());
    if (t?.key) totpCompanions.add(t.key.toLowerCase());
  }

  const passwordCounts = new Map<string, number>();
  for (const { login } of logins) {
    const p = login.fields.password;
    if (!p) continue;
    passwordCounts.set(p, (passwordCounts.get(p) ?? 0) + 1);
  }

  const flagged: FlaggedItem[] = [];
  let strong = 0;
  let weak = 0;
  let reused = 0;
  let oldCount = 0;
  let twoFactor = 0;
  let exposedCount = 0;

  for (const { item, login } of logins) {
    const pw = login.fields.password;
    const strength = passwordStrength(pw);
    const reuseN = passwordCounts.get(pw) ?? 0;
    const breaches = exposed?.get(item.id) ?? 0;
    const ageDays = daysSince(item.updatedAt);
    const issuer = (login.title || "").toLowerCase();
    const has2fa = totpCompanions.has(issuer);
    if (has2fa) twoFactor++;

    let added = false;

    if (strength <= 2) {
      weak++;
      const sev = strength <= 1 ? "high" : "mid";
      const reason =
        strength <= 1
          ? "Weak — crackable in hours"
          : "Fair — could be stronger";
      flagged.push({ id: item.id, title: itemTitle(item), reason, kind: "weak", severity: sev });
      added = true;
    }
    if (reuseN > 1) {
      reused++;
      flagged.push({
        id: item.id,
        title: itemTitle(item),
        reason: `Reused across ${reuseN} ${reuseN === 1 ? "item" : "items"}`,
        kind: "reused",
        severity: "mid",
      });
      added = true;
    }
    if (breaches > 0) {
      exposedCount++;
      flagged.push({
        id: item.id,
        title: itemTitle(item),
        reason: `Found in ${breaches.toLocaleString()} known ${breaches === 1 ? "breach" : "breaches"}`,
        kind: "exposed",
        severity: "high",
      });
      added = true;
    }
    if (ageDays !== null && ageDays >= OLD_DAYS) {
      oldCount++;
      const years = Math.floor(ageDays / 365);
      const reason = years >= 1
        ? `Unchanged for ${years === 1 ? "over a year" : `${years} years`}`
        : `Unchanged for ${Math.floor(ageDays / 30)} months`;
      flagged.push({
        id: item.id,
        title: itemTitle(item),
        reason,
        kind: "old",
        severity: ageDays >= VERY_OLD_DAYS ? "high" : "mid",
      });
      added = true;
    }
    if (!added && strength >= 3 && reuseN <= 1) strong++;
  }

  // Score: 100, minus weight × ratio for each issue category. Breach exposure is the
  // heaviest — a known-breached password is compromised regardless of how strong it looks.
  // Old is the lightest — a 2-year-old strong+unique password isn't broken, just stale.
  const total = logins.length || 1;
  const penalty = Math.min(
    100,
    Math.round(
      (weak / total) * 60 +
        (reused / total) * 30 +
        (exposedCount / total) * 70 +
        (oldCount / total) * 15,
    ),
  );
  const score = Math.max(0, 100 - penalty);

  // Sort: high-severity first, then by issue kind (weak before reused before old), stable.
  const KIND_W: Record<IssueKind, number> = { weak: 0, reused: 1, exposed: 2, old: 3 };
  flagged.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return KIND_W[a.kind] - KIND_W[b.kind];
  });

  return {
    score,
    buckets: { strong, weak, reused, old: oldCount, twoFactor, exposed: exposedCount, total: logins.length },
    flagged,
  };
}
