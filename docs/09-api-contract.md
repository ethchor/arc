# 09 — API Contract

All routes are under `@Controller("vault")` (and `vaults` for vault-scoped resources),
guarded by `JwtAuthGuard` + `@CurrentUser()`. Mutating vault routes additionally enforce the
caller's **role** on the target vault. Every payload carries ciphertext / wrapped keys /
signatures — never plaintext. DTOs are validated by a global
`ValidationPipe({ transform: true, whitelist: true })`.

## 9.1 Conventions

- **Auth:** `Authorization: Bearer <JWT>` (sync authorization only; see doc 06 §6.1).
- **Min role** column = the lowest role permitted; higher roles inherit.
- **Idempotency:** mutating item writes accept an optional `Idempotency-Key` header so a
  retried request after a network blip does not create a duplicate (doc 10 §10.3).
- **Cursors:** delta endpoints take `?since=<seq>` and return a `cursor` (new max `seq`).

## 9.2 Identity & directory

| Method | Path | Min role | Body / notes |
| ------ | ---- | -------- | ------------ |
| POST | `/vault/enroll` | self | full enrollment payload (doc 06 §6.2) → `{ keysetId, vaultId, deviceId }` |
| GET | `/vault/keyset` | self | salts, argonParams, `encIdentityPriv`, `encSigningPriv`, `keyVersion` (identity-key version) |
| PUT | `/vault/keyset` | self | param upgrade / master-pw change: new params, re-wrapped privs, new authHash (doc 05 §5.3) |
| POST | `/vault/unlock` | self | `{ authHash }` → `{ ok }`; rate-limited, lockout on N fails |
| POST | `/vault/identity` | self | publish identity+signing pubkeys + self-attestation; store wrapped privs |
| POST | `/vault/identity/rotate-signing` | self | `{ newSigningPub, encSigningPriv, continuitySig }` (doc 05 §5.5) |
| POST | `/vault/identity/rotate-identity` | self | `{ newIdentityPub, encIdentityPriv, encIdentityPrivRecovery, regrants[] }` (doc 05 §5.6) |
| POST | `/vault/recover` | self | recovery-key path: proves recovery possession, returns keyset for re-derivation (doc 06 §6.4) |
| GET | `/vault/users/:id/identity-key` | member-able | fetch a user's identity pubkey + fingerprint to wrap a VK |
| GET | `/vault/users?email=` | auth | directory lookup for inviting (rate-limited, audited) |

## 9.3 Vaults & membership

| Method | Path | Min role | Body / notes |
| ------ | ---- | -------- | ------------ |
| POST | `/vaults` | — | create `{ type, encName, nameNonce, ownerGrant }` |
| GET | `/vaults` | member | vaults the caller belongs to + their grant |
| GET | `/vaults/:id` | viewer | vault metadata + caller's grant |
| PATCH | `/vaults/:id` | owner | rename (`encName`) |
| DELETE | `/vaults/:id` | owner | soft-delete |
| GET | `/vaults/:id/members` | viewer | membership list (no key material) |
| POST | `/vaults/:id/members` | admin | `{ userId, role, keyVersion, wrappedVaultKey, signature? }` |
| PATCH | `/vaults/:id/members/:userId` | admin | change role |
| DELETE | `/vaults/:id/members/:userId` | admin | revoke (pair with rotate-key) |
| POST | `/vaults/:id/rotate-key` | admin | `{ newKeyVersion, grants[], rewrappedItemKeys[] }` (atomic, doc 07 §7.5) |
| POST | `/vaults/:id/invites` | admin | `{ email, role, expiresAt }` (doc 06 §6.6) |

## 9.4 Items, folders, sync

| Method | Path | Min role | Body / notes |
| ------ | ---- | -------- | ------------ |
| GET | `/vaults/:id/items?since=<seq>` | viewer | delta pull: changed + tombstoned rows + `cursor` |
| POST | `/vaults/:id/items` | editor | `{ id?, ciphertext, nonce, wrappedItemKey, vaultKeyVersion, baseVersion, signature? }` → `{ id, version, seq, updatedAt }` |
| DELETE | `/vaults/:id/items/:itemId` | editor | soft-delete tombstone (signed; doc 10) |
| POST | `/vaults/:id/items/:itemId/share` | editor | re-wrap one IK to a target vault/user (doc 07 §7.6) |
| GET/POST/DELETE | `/vaults/:id/folders` | viewer/editor | encrypted folder names, mirror of items |
| GET | `/vaults/:id/head` | viewer | signed vault-head: `{ seq, chainHash, sig, signerKid }` (doc 10 §10.5) |

## 9.5 Devices

| Method | Path | Min role | Body / notes |
| ------ | ---- | -------- | ------------ |
| POST | `/vault/devices` | self | `{ pubkey, name }` → `{ id, approved:false }` |
| GET | `/vault/devices?pending=true` | self | pending devices + SAS (doc 06 §6.3) |
| POST | `/vault/devices/:id/approve` | self (trusted device) | `{ grants[] }` |
| GET | `/vault/devices/me/keyset` | self | this device's grants |
| DELETE | `/vault/devices/:id` | self | revoke |

## 9.6 Developer-platform surface (doc 14)

| Method | Path | Min role | Body / notes |
| ------ | ---- | -------- | ------------ |
| POST | `/vaults/:id/service-accounts` | admin | create machine identity + grant (doc 14 §14.2) |
| POST | `/vaults/:id/tokens` | admin | mint a scoped API token for a service account |
| DELETE | `/vaults/:id/tokens/:tid` | admin | revoke a token |
| POST | `/vaults/:id/delegations` | admin | time-boxed grant `{ granteeUserId, role, expiresAt, wrappedVaultKey }` (doc 14 §14.4) |
| GET | `/vaults/:id/audit?since=<seq>` | admin | metadata-only audit feed (doc 11) |

### 9.6.1 Engine-C agent surface (ADR-005)

Engine-C exposes a parallel `/vault/agents/*` surface for AI agents. The JWT issued by
`/vault/agents/:id/auth/token` carries `agentId` and the RFC 8693 `act` claim and is
gated by `@AgentTokenAllowed()` — it can ONLY reach `submitIntent`, never the human API
(audit CRIT-1).

| Method | Path | Auth | Body / notes |
| ------ | ---- | ---- | ------------ |
| POST | `/vault/agents` | owner | register an agent (`displayName`, public keys, optional attestation) |
| GET | `/vault/agents` | owner | list agents the caller owns |
| PATCH | `/vault/agents/:id` | owner | toggle autonomy / suspend / retire |
| POST | `/vault/agents/:id/delegations` | owner | record a signed delegation (decision = intersection of delegated ∩ delegator-policy ∩ agent-policy) |
| POST | `/vault/agents/:id/auth/challenge` | open | mint a nonce the agent signs with its Ed25519 key |
| POST | `/vault/agents/:id/auth/token` | open | exchange the signed challenge for a 10-minute JWT carrying `agentTokenEpoch` (HIGH-C) |
| POST | `/vault/agents/:id/tasks` | owner | open a task (`delegationId`, optional budget) |
| POST | `/vault/agents/:id/intents` | **agent token only** | submit a signed `SignedIntent` — see §9.6.2 |
| GET  | `/vault/agents/:id/tasks/:taskId?verify=true` | owner | recompute the per-task chain head |
| POST | `/vault/agents/:id/tasks/:taskId/close` | owner | cascades revoke (delegations + leases) **and bumps the agent's `tokenEpoch`, invalidating every outstanding agent JWT** (HIGH-C) |
| GET  | `/vault/approvals` | owner | list pending CIBA approvals |
| POST | `/vault/approvals/:id/challenge` | owner | begin the WebAuthn ceremony — the challenge is `base64url(SHA-256("arc-approval/v1\n" \|\| intentDigest))` so the assertion can't be redirected to a different intent (MED-F) |
| POST | `/vault/approvals/:id/approve` | owner | grant the approval by submitting a WebAuthn assertion |
| POST | `/vault/approvals/:id/deny` | owner | deny outright |

### 9.6.2 `IntentClaims` wire shape (`/vault/agents/:id/intents`)

The agent signs a flat JSON `IntentClaims` object whose fields the server canonicalises
via RFC 8785 JCS before hashing / verifying. Every field is required.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `v` | `1` | wire version |
| `agent` | string | `agent:<id>` subject |
| `delegation` | string \| null | delegation id this intent is exercised under; `null` for autonomous mode |
| `taskId` | string | the task being acted on |
| `op` | string | logical operation, e.g. `kv.put`, `transit.encrypt` |
| `path` | string | engine path |
| `argsDigest` | string | `sha256(JCS(args))` hex — binds the request body |
| `ts` | string | ISO-8601 timestamp |
| `nonce` | string | b64url, ≥16 bytes |
| `prevChainHead` | string | hex sha-256, `ZERO_CHAIN` for the first intent on a task (audit MED-E — binds the signature to a specific chain position so the server can't accept the intent at a different position) |

The server's rejection order is: signature → `argsDigest` recheck → capability map →
task open / expired / budget → **intent_replay** (same digest already on the task) →
**intent_chain_mismatch** (`claims.prevChainHead !== task.chainHead`) → authorize →
elevated/approval-required.

## 9.7 Error & status model

| Status | When | Body |
| ------ | ---- | ---- |
| `400` | DTO validation failure (whitelist/transform) | `{ error, details }` |
| `400` | malformed Engine-A path (`..` segments, double-encoded traversal) | `{ error:"invalid_engine_path" }` (audit HIGH-A) |
| `400` | argonParams below the configured floor on enroll/recover | `{ error:"argon_below_floor", floor, observed }` (audit LOW-B) |
| `401` | missing/invalid JWT | — |
| `401` | agent token presents an `agentTokenEpoch` that no longer matches the agent's row | `{ error:"agent_token_revoked", reason:"epoch_mismatch" \| "agent_inactive" }` (audit HIGH-C) |
| `403` | role check failed on the target vault | `{ error:"forbidden", requiredRole }` |
| `403` | agent token off the intent path | `{ error:"agent_token_off_intent_path" }` (audit CRIT-1) |
| `403` | `/auth/dev-login` invoked without `ARC_ENABLE_DEV_LOGIN=true` | `{ error:"dev_login_disabled" }` (audit MED-C) |
| `404` | resource not found / not visible to caller | — (404 not 403 for resources the caller can't see, to avoid leaking existence) |
| `409` | optimistic-concurrency conflict on item write | `{ error:"conflict", current:{ ciphertext, nonce, wrappedItemKey, version, seq } }` (doc 10 §10.3) |
| `409` | the same signed intent submitted twice | `{ error:"intent_replay" }` (audit HIGH-D) |
| `409` | agent's `claims.prevChainHead` doesn't match the task's current head | `{ error:"intent_chain_mismatch", expected, observed }` (audit MED-E) |
| `423` | vault/account locked out (too many unlock failures) | `{ error:"locked", retryAfter }` |
| `429` | rate-limited (unlock, directory lookups) | `{ retryAfter }` |
| `410` | client envelope version below minimum supported (doc 04 §4.8) | `{ error:"upgrade_required", minVersion }` |

## 9.8 Validation rules (selected)

- All `enc*`/`wrapped*`/`ciphertext` fields validated as base64url-or-JSON-envelope of
  bounded size; the server does not parse their semantics.
- `keyVersion`/`vaultKeyVersion` must reference an existing VK version for the vault.
- A member write whose `signature` fails server-side **format** checks is rejected at the
  boundary; cryptographic authorship verification is done by **peers** (the server can't
  verify it can't forge, but it stores and relays the signature). The server *can* cheaply
  reject signatures whose `signerKid` is not a known key for `authorUserId`.
- `baseVersion` is required on item updates; absence → treated as create (or `409` if the id
  exists).
