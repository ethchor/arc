# arc-plugin-spiffe — agent context

**Scope.** SPIFFE auth method — the **SVID→token exchange**. A workload that already holds a
SPIFFE identity (SPIRE or any SPIFFE-conformant workload API) presents its **JWT-SVID**; the
plugin verifies it against the trust domain bundle and maps the SPIFFE ID to arc policies, so
the workload reaches arc without a second, separately managed credential. Implements
`@arc/plugin-sdk`'s `AuthPlugin` (`configure` + `login`). Mounted by arc-server's
`AuthMethodsService`; `POST /v1/auth/<mount>/login` runs `login()`, accepting the SVID under
either `svid` or `jwt`.

**X.509-SVIDs are out of scope.** They are presented over mTLS and verified at the TLS
terminator, not in an HTTP login body. Don't add them here.

**Deps rule.** Workspace deps are `@arc/plugin-sdk` + `@arc/types` only. The default verifier
(`@arc/plugin-spiffe/node`) uses Node built-ins only — `fetch` for bundle retrieval,
`node:crypto` for RS/ES verification. Tests inject a fake `JwtSvidVerifier`.

**Security invariants.**
- The injected verifier is the only thing that touches signatures and bundles; nothing trusts
  an unverified payload. `alg: none` is refused, and `exp` is **required** — the JWT-SVID spec
  mandates it, and its absence would mean a bearer token that never expires.
- **Trust domain is checked before role matching.** A signature the bundle happens to accept
  is not enough: the `sub`'s trust domain must equal the configured one, so a bundle
  misconfiguration can't authenticate a foreign workload. Covered by an e2e case.
- Policies come from the operator-configured **role**, never from the SVID. A role must bind
  at least one SPIFFE ID or path prefix — `configure()` rejects an unbound role, which would
  otherwise accept every workload in the trust domain.
- `bundleEndpoint` must be `https://`. A bundle fetched in plaintext is attacker-replaceable,
  which would let anyone mint an accepted SVID.

**SPIFFE IDs are rejected, never normalized.** `parseSpiffeId` refuses anything non-canonical:
a wrong scheme, userinfo, a port, a query/fragment, percent-encoding, empty or dot segments,
an uppercase trust domain, or a bare trust-domain id with no workload path. Note two parser
traps the code guards explicitly, both verified by tests:
- WHATWG `URL` **resolves dot segments** (`/ns/../admin` → `/admin`), so validation runs against
  the raw text and requires it to equal `url.pathname`.
- `spiffe:` is a non-special scheme, so `URL` treats the host as **opaque and does not
  lowercase it** — the lowercase check is explicit.

Prefix binding matches on a **segment boundary** (`matchesPathPrefix`), so `/ns/prod` accepts
`/ns/prod/sa/api` but never `/ns/production/sa/api`. A raw `startsWith` here would be a
privilege-escalation bug.
