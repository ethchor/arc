# arc-plugin-oidc — agent context

**Scope.** OIDC / JWT auth method. Verifies a caller-presented JWT (OIDC ID token, CI OIDC
token, OIDC-enabled SA token, …) against the issuer's JWKS and maps it to arc policies.
Implements `@arc/plugin-sdk`'s `AuthPlugin` (`configure` + `login`). Mounted by arc-server's
`AuthMethodsService`; `POST /v1/auth/<mount>/login` runs `login()`. Not the interactive
auth-code flow — the caller brings a token it already obtained.

**Deps rule.** Workspace deps are `@arc/plugin-sdk` + `@arc/types` only. The default verifier
(`@arc/plugin-oidc/node`) uses **Node built-ins only** — `fetch` (OIDC discovery + JWKS) +
`node:crypto` (RS256/384/512, ES256/384/512). No external runtime deps. Tests inject a fake
`JwtVerifier`; browsers/Deno should write a WebCrypto verifier and inject it.

**Security invariants.**
- Verification is fail-closed and the *only* thing that touches signatures/JWKS. `boundClaims`
  are checked only after the verifier returns a trusted payload.
- Policies come from the operator-configured **role**, never from the token — a token can't grant
  itself extra policies by adding a claim.
- ECDSA JWT signatures are raw r‖s (IEEE-P1363); the verifier sets `dsaEncoding: "ieee-p1363"`.
  A token with no `kid` is only accepted when the JWKS has exactly one key.
