# 02 — Engine-B (E2E vault) — full flow

> **Set `ARC_ENABLE_DEV_LOGIN=true` once in your shell** — every dev-login step below
> depends on the MED-C opt-in (`export ARC_ENABLE_DEV_LOGIN=true && pnpm --filter
> @arc/server start`).

The consumer-vault path: enroll → unlock → items → folders → sharing → rotation →
device approval → recovery → audit log. Server is blind throughout — verify with the
"server-side check" boxes.

## A. Enrollment (first sign-in)

1. Open `http://localhost:3002`.
2. Enter `you@example.com` (any email — `/auth/dev-login` mints a token for any string
   in dev mode). Click **Continue**.
3. You land on the **Unlock your vault** screen. Type a master password (≥ 8 chars) and
   click **Create a new vault**.
4. Expected: vault opens, **Recovery Key Card** appears with a `XXXX-XXXX-...`
   recovery key. Copy it somewhere safe — you'll use it in section H.

> **Server-side check.** In Terminal A you should see request lines for
> `POST /vault/enroll` and `POST /vault/unlock`. No body data is logged (pino's req
> serializer strips it).

## B. Items (the four types)

Each item is created via the **+** button in the list. The dialog discriminates by type;
the same back-end shape supports all four.

### B1. Login

1. **+** → **Login**.
2. Title: `GitHub`, URL: `https://github.com`, username: `you`, password: anything.
3. Save. Item appears in the list with a globe icon.
4. Click it → the active panel shows masked password + Copy buttons. Click the eye
   icon to reveal, then Copy to clipboard.

### B2. TOTP

1. **+** → **TOTP**.
2. Paste a real `otpauth://totp/...` URI from any authenticator app (Google Authenticator
   exports these). The dialog auto-fills key + issuer + account + algorithm + digits +
   period.
3. Save. The `TotpCard` shows the rotating 6-digit code with a per-second progress bar.
4. Verify the same code matches your phone's authenticator app for the next 30 seconds.

### B3. Secure note

1. **+** → **Note** → title + body.
2. Save. The active panel renders the body verbatim (newlines preserved, no rich text).

### B4. Generic secret (key/value)

1. **+** → **Secret** → key `API_KEY`, value `sk-test-...`.
2. Save. Copy field present in the active panel.

## C. Search + filter

The search box across the top filters by item title / username / key. Type a substring
and watch the list narrow. The discriminated union handles all four item types in the
filter (`vault-app.tsx`).

## D. Folders

1. Click **+ Folder** in the left rail.
2. Name it (the name is encrypted with the VK, see `encryptFolderName`).
3. Drag an item into the folder — the item's `folderId` is set server-side, the
   plaintext name was never sent.

## E. Sharing (multi-user vaults)

Need a second account:

1. New incognito window → `http://localhost:3002` → sign in as `bob@example.com`.
2. Enroll Bob into a new master password. Bob is now in the system with an identity
   public key.
3. Back in Alice's window: the **Share** button is in two places — the **Secrets**
   header (next to *Add login / TOTP / note / secret*) and under **Access**. Either
   opens the same dialog.
4. Enter `bob@example.com` (the email Bob signed in with) and click **Look up**. The web
   fetches Bob's public key via `GET /vault/users/by-email/:email`, resolves to a userId,
   and seals the VK to Bob's hybrid (X25519 + ML-KEM) public key. The fingerprint is
   surfaced for out-of-band verification.
5. Alice picks a role and clicks **Grant access**. Bob's view auto-refreshes — the shared
   vault appears in his list.

> **PQ-hybrid check.** The seal uses `sealHybrid` (X25519 + ML-KEM-768 + HKDF +
> XChaCha20-Poly1305) for every new enrollment per ADR-002. The server never sees the VK.

## F. Vault-key rotation

1. From Alice's vault: **Settings** → **Rotate key**.
2. Confirm. The web client:
   - mints a new VK (`createVaultKey`),
   - re-wraps the IK for every active member (`rotateForAllMembers`),
   - bumps `currentKeyVersion` on the vault row.
3. Items remain readable for both Alice + Bob — the item *payloads* are NOT
   re-encrypted; only the IK changed (see ADR + `rewrapItemKey`).
4. A revoked / unshared member would no longer have a grant at the new key version, so
   they'd lose access on next listVaults.

## G. Devices (multi-device approval)

1. Open a third browser profile / private window → sign in as Alice again
   (`alice@example.com`).
2. On the unlock screen click **Set up as a new device**.
3. A 6-digit verification code appears with a "device pending" banner.
4. Switch to Alice's first window → **Devices** dialog → you'll see the pending device
   with the matching code. Approve it (the approval call sends a sealed VK grant to the
   new device's public key).
5. The new browser auto-detects approval (poll loop) and unlocks read-only (it has VKs
   for the vaults Alice approved it for).

## H. Recovery (lost master password)

1. New incognito → sign in as Alice → click **Forgot your master password?** in the
   Recovery Key Card.
2. Paste the recovery key from step A.4.
3. Set a new master password.
4. Verify: the vault unlocks under the new password; existing items + folders intact.

## I. Audit log

1. From an unlocked vault: navigate to the **Audit** section.
2. Expect newest-first entries: `vault_created`, `member_added`, `item_created`, …
3. Destructive events render with a warn-tone badge: `unlock_failed`, `item_deleted`,
   `device_revoked`, `vault_key_rotated`.

> **Audit invariant check.** Open `apps/arc-server/test/vault.e2e-spec.ts` — the test
> asserts that no `ct`/`tag`/`n` ciphertext substring and no plaintext key/value appears
> in the audit metadata. This invariant is enforced programmatically, not by convention.

## J. Auto-lock + never-persist-keys

1. With the vault unlocked: leave the browser idle for the configured idle timeout
   (default 5 min in the web app).
2. The vault locks automatically — you're back at the unlock screen.
3. Close the tab → re-open → still locked. Keys are *never* written to `localStorage` /
   `sessionStorage` / IndexedDB.

> **Storage check.** Open DevTools → Application → Local Storage / Session Storage /
> IndexedDB. You'll see auth-token metadata + UI prefs only. No master key, no identity
> priv, no VK.

## K. CLI smoke (optional)

Same flow from the command line:

```bash
node apps/arc-cli/dist/bin.js --base-url http://localhost:3001 \
  login --email cli@example.com
node apps/arc-cli/dist/bin.js enroll --password 'super-secret-12345'
node apps/arc-cli/dist/bin.js create-vault --name 'cli-test'
node apps/arc-cli/dist/bin.js set --vault cli-test --key DATABASE_URL --value postgres://...
node apps/arc-cli/dist/bin.js get --vault cli-test --key DATABASE_URL
```

Full CLI surface: [`07-cli.md`](07-cli.md).
