# 11 — Audit, Privacy & Telemetry

Audit is essential for the developer/team surface (who did what, when) but is itself a
privacy and metadata-leakage risk (doc 02 §2.5). This doc defines a metadata-only audit
model with **minimization** and **retention controls** baked in, and a strictly **opt-in**
telemetry posture.

## 11.1 Audit event catalog (metadata only — never content)

Stored in `vault_audit_log` (doc 08 §8.9). Every event is metadata about an action; no event
ever carries item plaintext, key material, or anything decryptable.

| Action | Carries | Notes |
| ------ | ------- | ----- |
| `vault_created` | actor, vaultId | |
| `member_added` / `member_removed` | actor, target userId, role | |
| `permission_changed` | actor, target, old→new role | |
| `vault_key_rotated` | actor, newKeyVersion | revocation signal |
| `device_added` / `device_approved` / `device_revoked` | actor, deviceId | |
| `signing_key_rotated` / `signing_key_reset` | actor | `_reset` = no continuity proof (doc 05 §5.5.1) |
| `identity_key_rotated` | actor | |
| `item_created` / `item_updated` / `item_deleted` | actor, itemId | **id only**, never content |
| `item_shared` | actor, itemId, target vault/user | |
| `service_account_created` / `token_minted` / `token_revoked` | actor, saId/tokenId | doc 14 |
| `delegation_granted` / `delegation_expired` | actor, target, expiresAt | doc 14 §14.4 |
| `unlock_failed` / `account_locked` | actor (account), count | security signal |
| `item_viewed` | actor, itemId | **client-reported, advisory only** — see §11.4 |

## 11.2 Metadata minimization

The audit log follows the same "store the minimum that makes the feature work" rule as the
rest of the system:

- **No content, ever** — only ids, roles, versions, actor/device references.
- **Coarsened IP** — store a truncated/hashed IP (`ipTrunc`), not the full address, unless an
  org explicitly enables full-IP capture for compliance (then it's surfaced to members).
- **Coarsened timestamps at rest** — exact times are needed live but can be rounded (e.g. to
  the minute) after a short window, reducing fine-grained activity fingerprinting.
- **No item titles or types in audit** — `item_updated` references `itemId`, not "updated
  'AWS prod root key'." (The item's `type` may exist on the item row per doc 02 §2.5, but it
  is not copied into audit events.)
- **Actor minimization for personal vaults** — a single-member personal vault gains little
  from a verbose audit trail; personal vaults default to a minimal audit set (security events
  only) and can disable item-level audit entirely.

## 11.3 Retention controls

Retention is **configurable per vault/org**, with privacy-preserving defaults:

| Setting | Default | Range |
| ------- | ------- | ----- |
| Security events (`unlock_failed`, `*_revoked`, `*_reset`, `*_rotated`) | 1 year | 90 days – indefinite |
| Membership/permission events | 1 year | 90 days – indefinite |
| Item-level events (`item_created/updated/deleted/shared`) | 90 days | off – 1 year |
| `item_viewed` (if enabled) | 30 days | off – 90 days |
| Coarsen timestamps after | 7 days | off – 90 days |
| Full IP capture | **off** | off / on (org policy, surfaced) |

- A background job prunes events past their retention window and coarsens timestamps past the
  coarsening window.
- Org admins can **export** the audit feed (`GET /vaults/:id/audit?since=`) for SIEM
  ingestion; export is itself an audited action.
- Retention changes are audited (`permission_changed`-class) so a sudden "shorten retention
  to hide activity" is itself visible.

## 11.4 `item_viewed` is advisory telemetry, not a security control

The server **cannot observe a decryption it cannot perform.** Therefore `item_viewed` is:

- **Client-reported** — the client voluntarily posts it after decrypting an item.
- **Opt-in** — off by default; an org/user must enable "view auditing," and members are told
  it's on.
- **Never authoritative** — a malicious or offline client can omit or fabricate it. It is
  useful telemetry ("this break-glass account read these 3 secrets during the incident
  window") but must not be treated as proof.
- **Never carries content** — `itemId` only.

## 11.5 Telemetry & analytics posture

Beyond the audit log, product telemetry (crash reports, feature usage) is:

- **Opt-in and off by default.** No telemetry is sent before the user consents.
- **Content-free and key-free.** Telemetry payloads are scrubbed; vault data, ids that map
  to content, and any key material are never included. A allowlist (not denylist) of
  permitted fields governs what may be sent.
- **Separable from sync.** Disabling telemetry never degrades sync or unlock.
- **Locally inspectable.** The client can show exactly what a telemetry event contains before
  it's sent (supports the doc 12 §12.4 extension's "no surprise exfiltration" stance).

## 11.6 Privacy invariants

- No audit or telemetry event contains item plaintext, titles, key material, or anything
  decryptable.
- `item_viewed` and all analytics are opt-in and off by default.
- Retention shortening and full-IP capture are themselves audited and surfaced to members.
- Disabling telemetry has zero effect on core functionality.
