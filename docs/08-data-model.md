# 08 — Data Model

TypeORM entities for `apps/arc-server`. All `enc*` / `wrapped*` / `ciphertext` columns store
**envelope JSON** (doc 04) as `text` — the server never parses them as anything but opaque
bytes. Postgres is the target; entities are registered centrally and changes ship as
migrations.

Conventions:

- Vault-scoped rows use `@PrimaryGeneratedColumn("uuid")` (UUID PKs avoid leaking ordinal
  counts). `users` keeps an int PK (account table, owned by the host app's auth).
- Every FK to a vault/user uses `onDelete: "CASCADE"` unless noted.
- Soft-delete via `deletedAt` tombstones (needed for sync; doc 10).
- `enc*` columns are nullable only where the absence is meaningful (e.g. a device awaiting
  approval has no grant yet).

## 8.1 `vault_user_keys` (one per user)

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | int PK | |
| `userId` | int FK→users, unique, CASCADE | one keyset per user |
| `saltMk` | varchar | Argon2id salt for MK |
| `saltAuth` | varchar | Argon2id salt for authHash |
| `argonParams` | jsonb | `{ profile, m, t, p, version }` |
| `authHashStored` | varchar | server-side **re-stretched** authHash (never the raw client value) |
| `identityPublicKey` | varchar | X25519, base64url |
| `signingPublicKey` | varchar | Ed25519, base64url |
| `identitySelfAttestation` | text | Ed25519 sig over `{userId,identityPub,signingPub,ts}` (doc 06 §6.5) |
| `encIdentityPrivKey` | text | envelope, under WK |
| `encSigningPrivKey` | text | envelope, under WK |
| `encIdentityPrivKeyRecovery` | text | envelope, under recovery key |
| `keyVersion` | int | identity-key version (doc 05) |
| `createdAt` / `updatedAt` | timestamp | |

> **Wire vs column naming:** the API payloads (docs 06, 09) use the shorter forms
> `encIdentityPriv` / `encSigningPriv` / `encIdentityPrivRecovery`; these map 1:1 to the
> columns above (`…PrivKey` / `…PrivKeyRecovery`). The wire names drop the `Key` suffix.

Plus a **signing-key history** sub-table `vault_user_signing_keys`
(`id, userId, signingPublicKey, validFrom, retiredAt, continuitySig, resetFlag bool`) so
peers can verify historical signatures across rotations (doc 05 §5.5).

## 8.2 `vaults`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `type` | enum(`personal`,`team`,`org`) | personal = single-owner vault |
| `orgId` | uuid FK→vaults, nullable | org hierarchy |
| `ownerUserId` | int FK→users | |
| `encName` | text | vault name, envelope under VK |
| `nameNonce` | varchar | (or carried inside the envelope) |
| `currentKeyVersion` | int default 1 | |
| `seqCounter` | bigint default 0 | per-vault monotonic mutation counter (doc 10) |
| `createdAt`/`updatedAt`/`deletedAt` | timestamp | |

## 8.3 `vault_memberships`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `vaultId` | uuid FK, CASCADE, indexed | |
| `userId` | int FK, indexed | |
| `role` | enum(`owner`,`admin`,`editor`,`viewer`) | |
| `status` | enum(`invited`,`active`,`revoked`) | |
| `addedByUserId` | int FK | |
| `createdAt`/`updatedAt` | timestamp | |

Unique `(vaultId, userId)`; index `(vaultId, role)`.

## 8.4 `vault_key_grants`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `vaultId` | uuid FK, indexed | |
| `keyVersion` | int | which VK version this grant carries |
| `granteeUserId` | int FK, nullable | null when the grantee is a device |
| `granteeDeviceId` | uuid FK→vault_devices, nullable | device grant |
| `wrappedVaultKey` | text | envelope: `seal(granteePub, VK)` |
| `wrappedByUserId` | int FK | the granting admin |
| `signature` | text nullable | Ed25519 grant signature (doc 10) |
| `createdAt` | timestamp | |

Unique `(vaultId, keyVersion, granteeUserId)` (and a parallel uniqueness for device grants).

## 8.5 `vault_items`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `vaultId` | uuid FK, indexed, CASCADE | |
| `folderId` | uuid FK→vault_folders, nullable | |
| `type` | varchar nullable | optional; null reduces category leakage (doc 02 §2.5) |
| `ciphertext` | text | item payload envelope (under IK) |
| `nonce` | varchar | (or inside envelope) |
| `wrappedItemKey` | text | IK envelope (under VK) |
| `vaultKeyVersion` | int | which VK version wrapped the IK |
| `version` | int | optimistic-concurrency counter |
| `seq` | bigint, indexed | per-vault monotonic (doc 10) |
| `authorUserId` | int FK | |
| `authorDeviceId` | uuid nullable | |
| `signature` | text nullable | Ed25519 mutation signature (doc 10) |
| `payloadLenClass` | smallint nullable | length bucket actually used (doc 02 §2.5) |
| `deletedAt` | timestamp nullable | tombstone |
| `createdAt`/`updatedAt` | timestamp | |

Composite indexes `(vaultId, seq)` and `(vaultId, updatedAt)`.

## 8.6 `vault_folders`

`id` uuid PK; `vaultId` FK; `encName` text (under VK) + `nonce`; `parentId` uuid nullable;
`seq` bigint; `updatedAt`/`deletedAt`.

## 8.7 `vault_devices`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `userId` | int FK, indexed, CASCADE | |
| `name` | varchar | |
| `publicKey` | varchar | X25519, base64url |
| `trusted` | bool default false | bootstrap device only |
| `approved` | bool default false | |
| `lastSeenAt` | timestamp nullable | |
| `createdAt` | timestamp | |

Index `(userId, approved)`. Device VK grants live in `vault_key_grants` via
`granteeDeviceId`.

## 8.8 `vault_invites` (pre-enrollment invites)

`id` uuid PK; `vaultId` FK; `email` varchar; `role` enum; `invitedByUserId` int FK;
`status` enum(`pending`,`accepted`,`expired`,`revoked`); `expiresAt` timestamp;
`createdAt`. No key material — a real grant is created only after identity-key verification
(doc 06 §6.6).

## 8.9 `vault_audit_log`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `vaultId` | uuid FK, indexed, nullable | null for account-level events |
| `actorUserId` | int FK, nullable | null for system/service-account where applicable |
| `actorDeviceId` | uuid nullable | |
| `action` | enum | see doc 11 §11.1 |
| `targetId` | varchar nullable | item/member/device id |
| `seq` | bigint | per-vault audit sequence |
| `ipTrunc` | varchar nullable | truncated/coarsened IP (doc 11) |
| `createdAt` | timestamp | coarsened per retention policy (doc 11) |

**Metadata only — never item content.** Retention + minimization rules in doc 11.

## 8.10 Indexing & migration notes

- Sync hot paths: `(vaultId, seq)` for delta pulls, `(vaultId, updatedAt)` for conflict
  detection. Both are composite and cover the common `WHERE vaultId=? AND seq>?` query.
- Grant lookup: `(vaultId, keyVersion, granteeUserId)` unique doubles as the read index.
- All schema changes ship as TypeORM migrations under `apps/arc-server/src/migrations/`; no
  `synchronize:true` in any environment (it would risk dropping ciphertext columns).
- `seqCounter` on `vaults` is incremented inside the same transaction as the mutation it
  numbers (doc 10 §10.2) to keep `seq` gap-free and monotonic.
