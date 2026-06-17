/**
 * Have-I-Been-Pwned breach check using the k-anonymity model (the same design 1Password and
 * Bitwarden use). The password is SHA-1'd *on this device*; only the first 5 hex characters
 * of that hash ever leave the browser. api.pwnedpasswords.com replies with every breached
 * hash suffix that shares those 5 characters — hundreds of them — each with an occurrence
 * count; we match the remaining 35 characters locally. The password, and even its full
 * hash, never leave the device, and the server can't tell which (if any) of the ~800
 * candidates was yours.
 *
 * This is the one place in the app that talks to a third party, so it is strictly opt-in:
 * the Security screen calls it only after the user presses "Check for breaches", and the
 * consent copy spells out exactly what's transmitted.
 */

const HIBP_RANGE = "https://api.pwnedpasswords.com/range/";

/** Uppercase hex SHA-1 via Web Crypto — runs entirely on-device. */
async function sha1HexUpper(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

// Memoise by full hash so reused passwords (and re-runs) don't refetch the same range.
const countByHash = new Map<string, number>();

/**
 * How many times `password` appears in known breaches (0 = not found). Throws on
 * network/HTTP failure so the caller can surface "couldn't reach the breach service"
 * instead of a false "safe".
 */
export async function pwnedCount(password: string, signal?: AbortSignal): Promise<number> {
  if (!password) return 0;
  const hash = await sha1HexUpper(password);
  const cached = countByHash.get(hash);
  if (cached !== undefined) return cached;

  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(`${HIBP_RANGE}${prefix}`, {
    // Add-Padding mixes in extra zero-count suffixes so even the *number* of real matches
    // for our prefix is hidden from a network observer.
    headers: { "Add-Padding": "true" },
    signal,
  });
  if (!res.ok) throw new Error(`Breach service returned ${res.status}`);
  const body = await res.text();

  let count = 0;
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toUpperCase() === suffix) {
      count = Number.parseInt(line.slice(idx + 1).trim(), 10) || 0;
      break;
    }
  }
  countByHash.set(hash, count);
  return count;
}
