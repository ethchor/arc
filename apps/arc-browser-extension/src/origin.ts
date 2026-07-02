// Origin binding for autofill (docs/12 §12.4). Autofill must only offer a credential when
// the page's registrable domain (eTLD+1) matches the saved URL's, over HTTPS.
//
// Uses the real Public Suffix List (via `tldts`) *including the PRIVATE section*, so
// multi-tenant hosts like *.github.io / *.vercel.app / *.pages.dev / *.herokuapp.com
// separate per tenant instead of collapsing to the shared suffix. The old hardcoded
// suffix list fell back to "last two labels" for anything it didn't know, which made
// `attacker.github.io` and `victim.github.io` both reduce to `github.io` — a cross-origin
// credential-disclosure vector. Anything the PSL can't resolve to a registrable unit
// returns null and fails closed.
import { getDomain } from "tldts";

/** Best-effort registrable domain (eTLD+1). Returns null for inputs we won't bind to. */
export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || h.includes(" ")) return null;
  // IPv4 / IPv6: the literal address is the registrable unit (tldts returns null for IPs).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  // `allowPrivateDomains` treats PSL private suffixes (github.io, vercel.app, …) as
  // registrable boundaries — the whole point, so different tenants never share a domain.
  return getDomain(h, { allowPrivateDomains: true });
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
