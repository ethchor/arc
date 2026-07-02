# Release validation checklist

A tickable per-feature checklist that mirrors the live `docs/STATUS.md`. Print this
before a release tag and run through it. Each line links to the section of this guide
that covers it.

## Phase 0 — Foundation

- [ ] `pnpm install && pnpm -r build` clean (no warnings worth fixing)
- [ ] `pnpm -r test` — 300 tests pass (10 skipped without live OpenBao is fine)
- [ ] `pnpm -r typecheck` — clean
- [ ] arc-server `pnpm --filter @arc/server build` — production tsc clean

## Phase 1 — Engine-B (E2E vault)

See [`02-engine-b-vault.md`](02-engine-b-vault.md).

- [ ] Enrollment flow + Recovery Key Card visible
- [ ] Login item: create, view, copy, edit, delete
- [ ] TOTP item: create from `otpauth://` URI, code matches phone
- [ ] Note item: multi-line plaintext preserved
- [ ] Secret item: key/value round-trip
- [ ] Search filters across all four types
- [ ] Folders: create, drag/drop, rename (name encrypted)
- [ ] Share to a second user — they see the vault, decrypt items
- [ ] Vault-key rotation — old member loses access; current members keep it
- [ ] Device approval flow — pending device receives sealed VK
- [ ] Recovery — paste recovery key, reset password, items intact
- [ ] Audit log shows correct actions + warn-tone badges
- [ ] Auto-lock after idle timeout
- [ ] Keys never in `localStorage` / `sessionStorage` / IndexedDB

## Phase 1 — Security overhaul (PRs #98–#105, #107)

See [`02-engine-b-vault.md`](02-engine-b-vault.md) §J–M.

- [ ] Dialog scrim is a blurred glass plate, not opaque black (#98)
- [ ] Password classifier: `vimu@123` / `Summer2024` / `P@ssw0rd!` / `letmein!` all
      flag as weak; a generated strong password reads strong (#99 — regression watch)
- [ ] shadcn tooltips: hovering any icon button shows a styled label + description,
      not the OS native bubble (#100)
- [ ] My vault is full-bleed + full-height; rail + detail scroll independently;
      switcher is a plain select with "New vault" sticky in the dropdown footer (#101, #103)
- [ ] **Security dashboard**: weak / reused / **old** (≥1y) / **exposed** buckets
      populate; score drops; per-row "Fix" + header "Fix all" (#99, #107)
- [ ] **Breach exposure**: opt-in only — the only request is `range/XXXXX` (5 hex chars);
      response folds into the score + flags (#102)
- [ ] **Fix-weak wizard**: walks the queue, rotates via the existing save path; per-row
      Fix runs one item (#105)
- [ ] **Home device posture**: live `listDevices()` + `listPasskeys()` counts; 40d
      inactivity nudge on untrusted devices (#104)
- [ ] **Password age signal**: items unchanged ≥1y appear in the `old` bucket; the
      detail hero subtitle reads `Login · updated <X> ago` (#107)
- [ ] Web dev port defaults to **`:3002`** (#106) — `pnpm --filter @arc/vault-web dev`,
      CORS allowlist, Tauri `devUrl`, passkey RP-origin

## Passkey unlock (server + SDK shipped)

See [`03-passkey-unlock.md`](03-passkey-unlock.md).

- [ ] SDK `registerPasskey` against running server with the fake authenticator
- [ ] SDK `unlockWithPasskey` produces a full session (read + write)
- [ ] `listPasskeys` shows the registered credential
- [ ] `removePasskey` deletes it; subsequent unlock 404s
- [ ] Anti-clone: counter-rewind unlock attempt 401s
- [x] (UI) Web button to add a passkey — `PasskeysSection` in the Settings dialog + "Use a passkey" on the unlock screen

## Phase 3 — Engine-A (OpenBao-backed)

See [`04-engine-a-openbao.md`](04-engine-a-openbao.md). Requires `BAO_ADDR`.

- [ ] `/v1/sys/mounts` lists secret/, transit/, pki/, database/
- [ ] KV v2 put → get → list → soft-delete cycle
- [ ] Transit: create key → encrypt → decrypt → rotate → decrypt old
- [ ] PKI: issue cert → read by serial → revoke → re-read shows revocation_time
- [ ] Database creds: issue → renew → revoke
- [ ] `arc` lease ids are arc-uuids, not OpenBao backend ids
- [ ] Without BAO_ADDR: `/v1/sys/seal-status` 503; `/v1/secret/*` 404; `/v1/sys/mounts` 200

## Phase 3 — Engine-A through the operator UI (PRs #108–#112, #114)

See [`10-operator-engines.md`](10-operator-engines.md).

- [ ] **KV browser** (#108): write → version → soft-delete → undelete → destroy round-trip;
      diff between two live versions; "No KV mount configured" empty state when `BAO_ADDR` unset
- [ ] **Transit** (#109): create key → encrypt → decrypt → rotate → old ciphertext still
      decrypts under v1; key material never crosses the wire
- [ ] **PKI** (#110): issue ceremony shows the private key **once** with the amber
      copy-or-lose warning; revoke flips the badge; CA tab shows issuer + chain PEM
- [ ] **Dynamic credentials** (#111): role list populates; issue mints a credential and
      pushes the lease into the session tracker with a 1s countdown; renew + revoke + peek
- [ ] **Leases** (#112): server-wide table; filter chips (All / Active / Expired /
      Revoked); per-row renew + revoke; **Bot · task** badge for agent-issued leases
- [ ] Operator screens share the same chrome (eyebrow + display title + mount selector +
      state-machine empty states); govern views (Audit, Policies) use the same eyebrow
      pattern (#114)
- [ ] No native `title=` tooltips left on operator surfaces — truncated IDs / serials
      use the shadcn `IconTip` (#114)

## Phase 3 — Plugin host

See [`05-plugin-host.md`](05-plugin-host.md).

- [ ] AWS plugin mounted via `manual-main.ts` — `/v1/aws/creds/<role>` works
- [ ] GCP plugin mounted — `/v1/gcp/creds/<role>` works
- [ ] GitHub plugin mounted — `/v1/github/creds/<role>` works
- [ ] All three appear in `/v1/sys/plugins`
- [ ] `renew` on any plugin lease → 400 not_renewable
- [ ] `revoke` no-ops at vendor but updates LeaseManager
- [ ] Invalid plugin config → 400 + plugin stays unregistered

## Phase 3 — Per-mount ACL

See [`06-grants-acl.md`](06-grants-acl.md).

- [ ] `ARC_DEFAULT_POLICY=deny` + `ARC_ROOT_USERS=1` bootstraps a sudo root
- [ ] Non-root user gets 403 on `/v1/*` paths
- [ ] Admin creates a policy, attaches to user, only covered path/cap passes
- [ ] `?list=true` requires `list` capability
- [ ] Non-root can't create policies (ACL protects itself)
- [ ] Detach + delete idempotent
- [ ] Engine-B (`/vaults`) unaffected by deny mode

## CLI

See [`07-cli.md`](07-cli.md).

- [ ] `login` + `enroll` + `unlock` + `whoami`
- [ ] `create-vault` + `set` + `get`
- [ ] `totp-add` from URI + `totp` prints code
- [ ] `~/.arc-vault/session.json` is the only persisted state

## Cross-engine flows

See [`08-e2e-scripts.md`](08-e2e-scripts.md).

- [ ] Flow 1: operator onboards a developer (vault + AWS grant)
- [ ] Flow 2: store API key in Engine-B, share via Engine-B membership
- [ ] Flow 3: cert + DB cred from Engine-A for a deploy
- [ ] Flow 4: lost-laptop recovery via Recovery Key
- [ ] Flow 5: CI mints a GitHub token via plugin

## Observability

- [ ] Pino logs every request once with the correlation id (`x-request-id`)
- [ ] No ciphertext or plaintext appears in audit metadata (e2e asserts this)
- [ ] Pretty-print in dev / JSON in prod
- [ ] Migrations: `pnpm --filter @arc/server migration:show` lists every migration up
      to and including `1718600000000-agent-token-epoch`

## Audit remediation regression (24/24 findings)

The June 2026 audit + remediation arc landed 24 changes; the full list lives in
`docs/STATUS.md`'s "Security audit remediation" section. Per-release sanity:

- [ ] `/auth/dev-login` 403s without `ARC_ENABLE_DEV_LOGIN=true` (MED-C)
- [ ] `ARC_DEFAULT_POLICY` defaults to `deny` under `NODE_ENV=production` (CRIT-B)
- [ ] `ARC_PLUGIN_MANIFEST` defaults to `required` under `NODE_ENV=production` (MED-D)
- [ ] `/vault/enroll` 400s on argonParams below the floor (LOW-B)
- [ ] `/v1/*` rejects `..` and double-encoded traversal with `invalid_engine_path` (HIGH-A)
- [ ] Agent JWT can ONLY reach `submitIntent` (CRIT-1)
- [ ] Closing a task bumps `tokenEpoch` and outstanding agent JWTs 401 with `agent_token_revoked` (HIGH-C)
- [ ] Re-submitting the same signed intent 409s `intent_replay` (HIGH-D)
- [ ] An intent with stale `prevChainHead` 409s `intent_chain_mismatch` (MED-E)
- [ ] Approval challenge is `SHA-256("arc-approval/v1\n" || intentDigest)` (MED-F)
- [ ] Device verification code binds both halves of the hybrid pair (LOW-D)
- [ ] `sys/plugins/` admin endpoints refuse `create+delete`-only policies (LOW-E)
- [ ] Helm chart refuses to render without `arcServer.secret.jwtSecret` set (MED-B)
- [ ] OpenBao pinned to `2.3.1` everywhere (CI, compose, helm chart) (MED-I)
