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

## Passkey unlock (server + SDK shipped)

See [`03-passkey-unlock.md`](03-passkey-unlock.md).

- [ ] SDK `registerPasskey` against running server with the fake authenticator
- [ ] SDK `unlockWithPasskey` produces a full session (read + write)
- [ ] `listPasskeys` shows the registered credential
- [ ] `removePasskey` deletes it; subsequent unlock 404s
- [ ] Anti-clone: counter-rewind unlock attempt 401s
- [ ] (UI) Web button to add a passkey — _pending, not yet shipped_

## Phase 3 — Engine-A (OpenBao-backed)

See [`04-engine-a-openbao.md`](04-engine-a-openbao.md). Requires `BAO_ADDR`.

- [ ] `/v1/sys/mounts` lists secret/, transit/, pki/, database/
- [ ] KV v2 put → get → list → soft-delete cycle
- [ ] Transit: create key → encrypt → decrypt → rotate → decrypt old
- [ ] PKI: issue cert → read by serial → revoke → re-read shows revocation_time
- [ ] Database creds: issue → renew → revoke
- [ ] `arc` lease ids are arc-uuids, not OpenBao backend ids
- [ ] Without BAO_ADDR: `/v1/sys/seal-status` 503; `/v1/secret/*` 404; `/v1/sys/mounts` 200

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
- [ ] Migrations: `pnpm --filter @arc/server migration:show` lists all three (init,
      grants, passkey)
