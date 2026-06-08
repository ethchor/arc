# ADR-007 — Item-level sharing: cryptographic shares via per-item key re-wrap

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** ethchor
- **Depends on:** ADR-002 (PQ-hybrid grants), docs/03 §3.6 (item-key model),
  docs/07 §7 (RBAC + vault-key grants)

## Context

arc today has whole-vault sharing only: a vault has members, each member has a `pqSeal`-wrapped
copy of the vault key (VK), and the VK unwraps every item key (IK) in the vault. There is no
way to share *one item* with a *single user* without also handing them everything else in
the vault.

Bitwarden / 1Password / LastPass all have item-level sharing. The product question on the
open list was *"item-level sharing (one item to one user) — Bitwarden has this; not in our
model yet. Big design call."* This ADR makes that call and builds it.

The constraint is the model we already have: **the server is zero-knowledge, every item has
its own random IK (`wrappedItemKey = aeadSeal(VK, IK, ikAad)`), and crypto identities are
post-quantum hybrid (`pqSeal` to X25519 + ML-KEM-768)**. The design has to compose with all
three, add no new primitive, and not weaken any existing guarantee.

## Decision

**A share is the IK of one item, `pqSeal`-wrapped to the recipient's hybrid identity, plus a
snapshot of that item's ciphertext at share time.** The recipient never receives the VK and
never becomes a vault member — they get cryptographic access to *exactly one item*, *as of the
version that was shared*.

The model is the smallest thing that works and reuses everything we already have:

```
share = pqSeal(IK, recipient.identityHybridPub) || snapshot(ciphertext, version, keyVersion)
```

No new crypto. The IK is just 32 bytes of key material; `pqSeal` doesn't care that it
originally came from a `aeadSeal(VK, IK, ikAad)` envelope — it can wrap it the same way it
wraps a VK in a vault grant (ADR-002).

### v1 scope (deliberate)

1. **View-only.** A share gives the recipient the IK + ciphertext to decrypt. It does *not*
   let them re-encrypt and write back. Edit-shares need a write-authz path that bypasses
   `requireRole`, which is its own design call (recipient writes a new IK + a new
   `wrappedItemKey` for the granter, who then re-wraps for every existing share — a real
   feature, not a follow-on). Out of scope here, called out.
2. **Snapshot semantics, not live tracking.** The share row holds the ciphertext + version
   + key version *at share time*. If the granter edits the item, `upsertItem` rotates the IK
   (every encryption uses `randomBytes(32)`) and the share's `pqSeal`-wrapped old IK no
   longer decrypts the new ciphertext. The share keeps working for the **shared version**;
   to share the new version, the granter shares again, which writes a fresh row. This is the
   honest framing — *"you shared a specific version of this item"* — and it is forward-secret
   on edits (the new IK isn't on disk anywhere wrapped to the recipient).
3. **One row per (item, grantee).** Re-sharing the same item to the same user upserts the row
   to the newest version. The recipient sees the latest share for each item id.
4. **No grant for groups, no per-share TTL.** Future extensions; the column shape leaves room
   (`expiresAt` reserved as nullable from the start).

### Authorization

- **Share** (`POST /vault/shares`): the granter must be a viewer-or-higher member of the
  source vault. The server reads the live item from the vault (`requireRole("viewer")`),
  copies its current ciphertext + version + keyVersion + type, and stores the granter's
  client-side `pqSeal(IK, recipientIdentityPub)` envelope.
- **List incoming** (`GET /vault/shares/incoming`): returns every share where
  `granteeUserId === me`. No vault membership required — that's the whole point.
- **Revoke** (`DELETE /vault/shares/:id`): the granter or the grantee can remove the share
  row. Documented residual: the recipient may have already decrypted and copied the
  plaintext; revoke removes future access, not past memory. Same property as every read
  share everywhere — called out, not hand-waved.

### Server enforcement, not just crypto

A non-member can't share (server checks `requireRole("viewer")` on the source vault). A user
who is shared an item cannot **re-share** it: the server only allows shares from a viewer of
the *source vault*, so a recipient who isn't a member of that vault is refused. (They could
exfiltrate the plaintext by hand, which is true of every read access ever — no design can
prevent that.)

### Why not the alternatives

- **Share by minting a single-item sub-vault.** Heavy: a vault has memberships, grants, an
  audit chain head, a seq counter, key versions. For one item, a row in `vault_item_shares` is
  the same security guarantee with O(1) state.
- **Edit-share at v1 (full Bitwarden parity).** Needs a write-authz path that bypasses
  `requireRole`, plus the granter to re-wrap on every active share whenever the item is
  edited. Real feature; needs its own ADR. v1 ships view-only, honestly labeled.
- **Live-tracking share (no snapshot).** Forces either (a) keeping a stable IK across edits
  (weakens per-version forward secrecy), or (b) the granter's client re-wrapping for every
  share on every edit (operational complexity, needs the granter to know who they shared
  with at the moment they're editing). Snapshot is the honest v1.

## Construction

- `@arc/crypto` exposes the existing `pqSeal` / `pqSealOpen` unchanged. A tiny helper —
  `wrapItemKeyForShare(ikBytes, recipientHybridPub)` — is a one-line wrapper for
  discoverability + so a Rust verifier can mirror the same call. **No new primitive.**
- The recipient's decrypt is `pqSealOpen(wrappedIK, recipient.hybridPriv)` → `aeadOpen(ik,
  ciphertext, itemAad({vaultId,itemId,version,keyVersion}))`. The AAD is the same
  `itemAad` the original item carries — the recipient just needs the IK.

## Data model (additive)

- `vault_item_shares` — `id, vaultId, itemId, granterUserId, granteeUserId, permission
  ("view"), wrappedIK (pqSeal envelope), ciphertext (snapshot), vaultKeyVersion, itemVersion,
  itemType (nullable), createdAt, expiresAt (nullable, reserved for future)`. Unique on
  `(itemId, granteeUserId)` — re-sharing upserts.
- `vault_audit_log` already accepts arbitrary `action` strings + `targetId`. New actions:
  `item_shared`, `item_share_revoked`. No schema change.

## Migration

One additive migration (`1718300000000-item-shares`). No backfill needed.

## Consequences

**Better.** arc gets Bitwarden-parity item sharing, server stays zero-knowledge, no new
crypto primitive, no change to whole-vault sharing or membership, no schema change to
existing tables. Recipients never become vault members; the blast radius of a compromised
recipient is *exactly one item*.

**Cost.** Snapshot semantics mean the granter re-shares to push an update — UI surfaces this.
Edit-shares are deferred. Plaintext-already-seen residual on revoke is documented.

## Test plan

- **e2e (`@arc/server`):** owner enrolls A, recipient enrolls B; A creates a vault + item; A
  shares the item with B; B's `/vault/shares/incoming` returns one row and the SDK
  decrypts the plaintext byte-identically. A edits the item; B's existing share still
  decrypts the *original* version (snapshot). A re-shares; B sees the new version. A
  revokes; B's listing is empty. A non-member cannot share (`requireRole("viewer")` →
  404). A recipient can't re-share (they aren't a member of the source vault → 404).
- **SDK unit:** `shareItem` round-trips through the wire shape; `decryptIncomingShare`
  produces byte-identical plaintext to the original encryptItem input.
