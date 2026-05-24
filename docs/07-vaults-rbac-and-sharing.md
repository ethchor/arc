# 07 — Vaults, RBAC & Sharing

## 7.1 The vault as the unit of ownership

Items are owned by a **vault**, not by a user. Users gain access through a
`vault_membership` plus a key `grant` (the VK wrapped to their identity key). A **personal
vault** is a `type=personal` vault with exactly one `owner` member — the same code path as a
team vault, so there is no separate personal/shared logic to maintain.

```
vault ──┬── memberships (who, what role, status)
        ├── grants       (VK_v wrapped to each member's identity pubkey, per key version)
        ├── items        (each: ciphertext + wrappedIK under VK_v)
        └── folders      (encrypted names under VK_v)
```

## 7.2 Roles

Roles live on `vault_memberships`:

| Role | Capabilities |
| ---- | ------------ |
| **owner** | Everything admin can do + delete the vault + transfer ownership. |
| **admin** | Manage members and grants; rotate keys; change roles (not owner). |
| **editor** | Read + create/update/delete items. |
| **viewer** | Read items only. |

## 7.3 What is cryptographically enforced vs server-enforced (honest boundary)

This is the same tradeoff 1Password and Bitwarden make, and we state it plainly rather than
overclaiming:

- **Read access is cryptographically enforced.** Only a member holding a VK grant can
  decrypt. Removing the grant **and rotating the VK** cryptographically denies *future*
  reads (§7.5).
- **viewer-vs-editor is server-enforced, not cryptographic.** A viewer still possesses the
  VK and *could* technically craft valid ciphertext. The server rejects a viewer's writes
  via the JWT guard + role check, and **signed mutations** (doc 10) let other clients
  *detect* a write not authored by an authorized member. We do **not** claim a viewer is
  cryptographically prevented from encrypting.
- **admin/owner actions** (add member, rotate key, change role) are server-enforced and, with
  Ed25519 signing enabled, **signed**, so peers can verify the grant chain and detect a
  server that invents memberships.
- **A vault admin can read everything in the vault** (they hold the VK) and can grant access
  to colluders. This is inherent to shared encryption, not a server-trust gap. Mitigate
  operationally (few admins, audit, alerting on grant changes — doc 11).

## 7.4 Granting access to a member

```
1. Admin fetches the invitee's identity pubkey (GET /vault/users/:id/identity-key) and
   verifies its fingerprint (doc 06 §6.5).
2. Admin (holds VK_current locally) computes:
     wrappedVaultKey = seal(inviteeIdentityPub, VK_current)        // confidentiality
     signature        = Ed25519_sign(adminSigningPriv, grantTuple)  // authenticity (doc 10)
3. POST /vaults/:id/members { userId, role, keyVersion, wrappedVaultKey, signature }.
   Server stores the membership + a vault_key_grant row (ciphertext + signature only).
4. Invitee, on next unlock: GET /vaults → sees the vault → fetches its grant → unwraps
   VK with identity_priv → unwraps IKs → decrypts items. Invitee verifies signature against
   the admin's published signing key.
```

## 7.5 Revoking a member + rotating the VK (the secure path)

Removing a membership alone does not deny reads — the ex-member may have cached the VK. The
secure revocation is a **VK rotation**:

```
1. Admin generates VK_{v+1} (random) and bumps vaults.currentKeyVersion.
2. Admin unwraps all current IKs with VK_v, re-wraps each under VK_{v+1}
   (rewrappedItemKeys[]). Item PAYLOADS are untouched — only the small wrapped-IK blobs
   change. This is why the IK layer exists.
3. Admin wraps VK_{v+1} to every REMAINING member's identity pubkey (grants[]); the revoked
   member gets NO grant for v+1.
4. POST /vaults/:id/rotate-key { newKeyVersion, grants[], rewrappedItemKeys[] } — server
   applies atomically (single transaction), deletes the revoked membership + its old grants.
```

**Forward-secrecy caveat (stated in the UI):** rotation blocks *future* reads (new IKs are
wrapped under `VK_{v+1}`), but the revoked member may have already decrypted and cached items
they had access to. Rotation cannot retroactively erase what they saw. For maximum hygiene,
also rotate the IKs and re-encrypt the most sensitive items, and **treat any secret the
ex-member could read as compromised** — prompt the user to rotate those real credentials
(rotate the actual API key/password, not just the wrapping).

## 7.6 Sharing a single item

Granular sharing leverages the IK layer (doc 03 §3.2): re-wrap just one item's IK.

```
POST /vaults/:id/items/:itemId/share { targetVaultId | targetUserIdentityPub }
  → the holder unwraps IK with the source VK, re-wraps IK under the target vault's VK
    (move/copy) or seals IK to a user's identity key (one-off share), uploads the new
    wrappedIK. The rest of the source vault is never exposed.
```

Move vs copy and whether the source retains access are product choices surfaced in the UI;
cryptographically both are "re-wrap this one IK."

## 7.7 Folders & collections

Folders are vault-scoped; `encName` is encrypted under the vault VK (AAD binds
`vaultId|folderId|"name"|keyVersion`). The folder *tree* (parent links) is metadata
(doc 02 §2.5). **Collection keys** — a sub-key wrapping a subset of IKs to share *part* of a
vault — are `[future]` and fit cleanly above the IK layer without protocol change.

## 7.8 Scaling notes

- Grants are `O(members × live key-versions)`. **Prune superseded grant versions** after a
  rotation completes (keep only what's needed to read still-referenced key versions).
- Rotation cost is `O(items)` in **small wrapped-IK blobs**, not full payloads; batch it and
  run large-vault rotations as a resumable background job with progress (doc 10 §10.7).
- Org vaults nest via `vaults.orgId`; an org-admin can manage child-vault *memberships*
  without holding each child VK unless explicitly granted (doc 14).
