import type { PulledItem } from "@arc/sdk";
import { asLogin, asTotp, itemTitle } from "./items";

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
    total: number;
  };
  flagged: FlaggedItem[];
}

const SECRET_LIKE = new Set([
  "password",
  "p@ssword",
  "qwerty",
  "letmein",
  "secret",
  "admin",
  "welcome",
  "iloveyou",
  "abc123",
  "monkey",
  "dragon",
]);

/**
 * Shannon-entropy estimate on the password's character set + length. Cheap, not perfect —
 * it's the same family of heuristic zxcvbn uses for its `guesses_log10` lower bound. We
 * combine it with a length floor and a small "looks like a common word" check.
 */
function passwordStrength(pw: string): number {
  if (pw.length === 0) return 0;
  const lower = pw.toLowerCase();
  if (SECRET_LIKE.has(lower)) return 1;

  let space = 0;
  if (/[a-z]/.test(pw)) space += 26;
  if (/[A-Z]/.test(pw)) space += 26;
  if (/[0-9]/.test(pw)) space += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) space += 33;
  const entropyBits = pw.length * Math.log2(Math.max(space, 1));

  // 0..4 scale: <32b weak, 32-44b fair, 44-60b strong, >=60b excellent.
  if (entropyBits < 28) return 1;
  if (entropyBits < 40) return 2;
  if (entropyBits < 56) return 3;
  return 4;
}

/**
 * Analyse the user's items. Pure function over already-decrypted state — the caller hands
 * us the items it already has in memory; we never re-fetch or send anything.
 *
 * Note on "old": the wire-level `PulledItem` doesn't carry an updatedAt timestamp (only a
 * monotonic `seq`), so we can't honestly tell how long ago a password was last rotated.
 * Rather than fake it, we leave the `old` bucket at 0 and surface only weak + reused; the
 * shape is in place to light up the moment the SDK carries a real timestamp.
 */
export function analyseSecurity(items: readonly PulledItem[]): SecurityReport {
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
  let twoFactor = 0;

  for (const { item, login } of logins) {
    const pw = login.fields.password;
    const strength = passwordStrength(pw);
    const reuseN = passwordCounts.get(pw) ?? 0;
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
    if (!added && strength >= 3 && reuseN <= 1) strong++;
  }

  // Score: 100, minus weight × ratio for each issue category.
  const total = logins.length || 1;
  const penalty = Math.min(100, Math.round((weak / total) * 60 + (reused / total) * 30));
  const score = Math.max(0, 100 - penalty);

  // Sort: high-severity first, then by issue kind (weak before reused before old), stable.
  const KIND_W: Record<IssueKind, number> = { weak: 0, reused: 1, exposed: 2, old: 3 };
  flagged.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return KIND_W[a.kind] - KIND_W[b.kind];
  });

  return {
    score,
    buckets: { strong, weak, reused, old: 0, twoFactor, total: logins.length },
    flagged,
  };
}
