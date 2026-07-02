# 10 — Engine-A through the operator UI

> **Prereqs.** Same as [`04-engine-a-openbao.md`](04-engine-a-openbao.md): OpenBao on
> `:8200`, `BAO_ADDR` set on the server, `ARC_ENABLE_DEV_LOGIN=true`. The CLI/HTTP
> walkthrough in `04-` covers the same engines through `curl`; this doc is for the new
> operator UI screens (PRs #108–#112). Sign in on `http://localhost:3002`, then click
> **Operator** in the persona switcher.

Every screen in this doc shares the same chrome contract:
- **Header** (eyebrow + display title + max-w-prose description + mount selector + primary action).
- **State machine**: `loading → no-mount / error / ready`. Honest empty state when the
  mount type isn't registered (e.g. `BAO_ADDR` unset).
- All HTTP goes through the SDK; no view speaks `fetch` directly.

## A. KV browser (`/v1/secret/*`)

PR #108. UI lives at `apps/arc-vault-web/src/components/vault/kv-view.tsx`.

1. Click **KV secrets** in the operator nav.
2. **Mount selector** shows `secret/` with the `kv-v2` chip. The path tree is built by
   recursively walking `kvList` from the root.
3. **Write secret** (header) opens the create dialog: pick a path (e.g. `app/prod/db`),
   add key/value rows (`POSTGRES_URL` = `postgres://…`, `RW_PASSWORD` = …), save.
4. The path appears in the tree under `app/ → prod/`. Click it — the detail pane fetches
   `kvMetadata` + every version's data via `Promise.all`.
5. Three tabs: **Current** (key/value with masked values + reveal), **Versions** (per-row
   View / Soft-delete / Undelete / Destroy + a per-version diff against the previous), and
   **Metadata** (`max_versions`, `cas_required`, `custom_metadata`, created/updated).
6. Re-write the same path with one key changed → version increments; **Versions** tab now
   shows v1 + v2 with a **Diff** button between them.
7. **Soft-delete** on v1 → row badge flips to `soft-deleted`; **Undelete** restores it.
8. **Destroy** → confirm → row badge flips to `destroyed` (irreversible, only metadata
   survives). Re-fetch confirms via `kvMetadata`.

> **Honest "no mount" check.** Restart arc-server without `BAO_ADDR`. KV view shows the
> **"No KV mount configured"** empty state with a **Retry** button — not faked data.

## B. Transit (`/v1/transit/*`)

PR #109. `transit-view.tsx`.

1. **Transit** in the operator nav.
2. **New key** (header) → name `payments`, algorithm AES-256-GCM-96, exportable off
   (default; recommended). Key appears in the rail.
3. Click the key → info card shows `latestVersion: 1`, algorithm, `min_decryption_version`,
   `min_encryption_version`, deletion/exportable flags, per-version creation times.
4. **Playground** below the info card:
   - Encrypt: type `card-number=4111…` → click **Encrypt** → opaque
     `vault:v1:<base64>` appears, copyable.
   - Decrypt: paste the ciphertext into the Decrypt input → click **Decrypt** → original
     UTF-8 plaintext renders. Binary payloads fall back to `(N bytes; not valid UTF-8)`.
5. **Rotate** in the hero → toast `Rotated payments → v2`, `latestVersion` bumps in the
   info card. **Old ciphertext (v1) still decrypts** — verify by pasting the v1
   ciphertext back; it returns the same plaintext.
6. Pasting a v2 ciphertext into the **wrong key's** decrypt input fires a toast with the
   engine's "mismatched key" / 400 error.

> **Key material check.** Open DevTools → Network. No request body or response ever
> carries the raw key — only `vault:v<N>:…` ciphertext and base64'd plaintext.

## C. PKI (`/v1/pki/*`)

PR #110. `pki-view.tsx`.

OpenBao dev mode **doesn't auto-mount a CA**. Bootstrap once via the CLI before exercising
the UI (same dance as [`04-engine-a-openbao.md`](04-engine-a-openbao.md) §D):

```bash
curl -X POST http://localhost:3001/v1/pki/root/generate/internal \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"common_name":"arc-manual-root","ttl":"87600h"}'
curl -X POST http://localhost:3001/v1/pki/roles/leaf \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allowed_domains":"arc.test","allow_subdomains":true,"max_ttl":"72h"}'
```

1. **PKI** in the operator nav. Three tabs: **Roles**, **Issued certs**, **CA chain**.
2. **Roles** tab: `leaf` appears in the left list. Selecting it shows TTL ceilings,
   allowed domains, key type/bits. Backend-specific extras (`signature_bits`, `key_usage`,
   …) collapse into a **All fields (raw)** `<details>` block — not a contract change per
   OpenBao knob.
3. **Issue certificate** (header dialog): role = `leaf`, common name = `svc.arc.test`,
   TTL `1h`, optional alt DNS / IP SANs. Submit.
4. Cert ceremony renders: **prominent amber warning** "the private key is the only copy
   the engine will ever surface — copy it now"; PEM blocks for the private key, the cert,
   the chain. Each block is copyable.
5. **Issued certs** tab: the new serial appears; status badge initially `loading…` then
   `active`. Per-row **PEM** opens the leaf in a viewer dialog; **Revoke** flips it to
   `revoked · 3s ago` (relative; ticks).
6. **CA chain** tab: PEM-encoded issuer + chain, both copyable.

> **"Only copy" check.** After dismissing the issue dialog, the cert's private key is
> **gone** — `pkiReadCertificate` never returns it. Confirm: re-open the cert via the PEM
> viewer and only the public cert is shown.

## D. Dynamic credentials (`/v1/<mount>/creds/<role>`)

PR #111. `creds-view.tsx`. Surfaces every dynamic-secrets mount — `database/` always,
plus any plugin-backed cloud/SCM/db mount.

OpenBao needs a Postgres backend + a configured role; one-time setup is in OpenBao's docs
(`POST /v1/database/config/<name>` then `POST /v1/database/roles/<role>`).

1. **Dynamic creds** in the operator nav.
2. **Mount selector** lists everything that isn't `kv-v2`/`transit`/`pki`. Pick `database/`.
3. Left rail: searchable role list (`credsListRoles`). Per-row **Issue** opens the
   ceremony dialog.
4. Ceremony returns `{ username, password }` + an arc-internal lease id. Password is
   masked via `MaskedField`; clickable reveal + copy. Username plain-text + copy.
5. The lease pushes into the **right pane** session tracker with a **1s countdown**.
6. **Renew** extends the countdown (server returns new `lease_duration`); **Revoke**
   flips the badge to `revoked` and clears the data; **Peek** re-opens the credential
   dialog while the lease is still active.
7. Issuing a second credential under the same role mints a separate lease — same
   username pattern, different generated password.

> **Session-scoped tracker.** The Creds screen tracks just the leases **you** minted in
> **this session**. For the global server-wide view, switch to **Leases** (next section).

## E. Leases (server-wide, `GET /v1/sys/leases`)

PR #112. `leases-view.tsx`. The cross-cutting view of every lease the arc `LeaseManager`
is tracking — minted by humans, plugins, or agent tasks.

1. **Leases** in the operator nav. Filter chips: **All / Active / Expired / Revoked**
   with counts; search across id / mount / engineType / backendLeaseId.
2. Active leases first (sorted by soonest-expiry), then expired (most recent), then
   revoked — this is the server-side sort in `EnginesService.listLeases`.
3. Each row: short lease id (hover → full uuid via the IconTip), engine type chip,
   mount, countdown / age, **renewable** chip, optional **Bot · task** badge for
   agent-issued leases (ADR-005's `taskId`).
4. **Renew** / **Revoke** per active row — same SDK calls as Creds, just routed
   server-wide instead of session-scoped.
5. **Refresh** re-fetches; the 1s ticker is only mounted while at least one active
   lease is on screen (no idle re-renders).

> **Resolved (#113).** The lease registry is persisted in Postgres, so this list
> survives a server restart and is shared across replicas — renew/revoke take a
> `SELECT … FOR UPDATE` row lock. Point every replica at the same `DATABASE_URL`.

## F. Operator surface: state matrix

A quick "what should be real" snapshot — every operator-nav row is wired:

| Section | Backed by | Doc |
|---|---|---|
| KV secrets | OpenBao KV v2 (`secret/`) | §A above |
| Dynamic credentials | `database/` + any plugin dynamic mount | §D above |
| Transit | OpenBao transit (`transit/`) | §B above |
| PKI | OpenBao PKI (`pki/`) | §C above |
| Policies | arc-grants (in-process) | [`06-grants-acl.md`](06-grants-acl.md) |
| Workflows | TypeORM-backed (`workflows` table) | UI walk-through pending |
| Leases | arc `LeaseManager` (in-memory) | §E above |
| Audit log | TypeORM-backed (`audit_events`) | [`02-engine-b-vault.md`](02-engine-b-vault.md) §I |
| Agents · MCP | TypeORM-backed (`agents`) | ADR-005 / Engine-C |
| Tools | Client-side only (pw / random / SHA-256) | self-evident |
