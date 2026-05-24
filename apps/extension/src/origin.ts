// Origin binding for autofill (docs/12 §12.4). Autofill must only offer a credential when
// the page's registrable domain (eTLD+1) matches the saved URL's, over HTTPS.
//
// PRODUCTION NOTE: replace MULTI_LABEL_SUFFIXES with the full Public Suffix List. This list
// covers only a handful of common multi-label suffixes and fails closed otherwise.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "com.br",
  "co.in",
]);

/** Best-effort registrable domain (eTLD+1). Returns null for inputs we won't bind to. */
export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || h.includes(" ")) return null;
  // IPv4 / IPv6: the literal address is the registrable unit.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const parts = h.split(".");
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(last2)) {
    return parts.length >= 3 ? parts.slice(-3).join(".") : null;
  }
  return last2;
}

/** True only if the page is HTTPS and shares a registrable domain with the saved URL. */
export function originMatches(pageUrl: string, savedUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const saved = new URL(savedUrl);
    if (page.protocol !== "https:") return false; // never autofill on http
    const pd = registrableDomain(page.hostname);
    const sd = registrableDomain(saved.hostname);
    return pd !== null && pd === sd;
  } catch {
    return false;
  }
}
