# 10 — Sync, Consistency & Integrity

This doc is the heart of "implementation correctness, sync reliability, state consistency,
and concurrency/conflict handling." It defines how devices converge, how conflicting writes
are resolved without data loss, and how a malicious or buggy server's tampering — forgery,
replay, rollback, omission — is **detected** even though it cannot always be prevented.

## 10.1 Sync model

- Per **vault**, the server maintains a monotonic `seqCounter`. Every mutation (item
  create/update/delete, folder change, membership/grant/rotation event) is assigned the next
  `seq` **inside the same DB transaction** as the write.
- Clients store, per vault, the highest `seq` they have applied (the **cursor**).
- Delta pull: `GET /vaults/:id/items?since=<cursor>` returns all rows (including tombstones)
  with `seq > cursor`, plus the new max `seq`. This is `O(changes)`, backed by the
  `(vaultId, seq)` index (doc 08).

`seq` (server-assigned, gap-free, per vault) is the sync cursor **and** the anti-rollback
anchor. `version` (per item) is the optimistic-concurrency counter. They are different
numbers with different jobs.

## 10.2 Ordering & atomicity

- A mutation's `seq` and the vault's `seqCounter` bump happen in one transaction → no gaps,
  strict per-vault ordering.
- Cross-vault ordering is **not** guaranteed (each vault is its own sequence); clients never
  rely on it.
- Tombstones (`deletedAt`) are first-class mutations with their own `seq`, so deletes
  propagate like any other change and a client can't "miss" a delete by syncing.

## 10.3 Optimistic concurrency & conflict handling

Writes carry `baseVersion` (the `version` the client last saw). On the server:

```
if storedVersion > baseVersion:  → 409 Conflict, return current row (ciphertext + version + seq)
else:                            → apply, version := storedVersion + 1, assign next seq
```

**Conflict resolution policy — conflict-preserving, not blind last-write-wins.** Because the
payload is opaque ciphertext, the server cannot merge. The *client* resolves:

| Item class | Default resolution |
| ---------- | ------------------ |
| Low-stakes (e.g. a note's formatting) | last-write-wins is acceptable; client re-pushes on top of `current` |
| **Secrets / credentials** | **conflict-preserving**: keep BOTH versions — the client creates a `conflict copy` item (a normal item flagged `conflictOf=<id>`) rather than silently overwriting, and surfaces a merge UI. We never destroy a credential because two devices edited it. |

Rationale: silently losing a password to last-write-wins is a worse failure than a duplicate
the user resolves. The client decides class from `type`; when unsure, it preserves.

**Idempotency:** an `Idempotency-Key` on item writes lets a client safely retry after a
network failure without creating duplicates — the server returns the original result for a
repeated key. Essential for sync reliability over flaky links.

## 10.4 Signed mutations (authorship integrity)

When signing is enabled (doc 07 §7.3), each item write is signed by the author's Ed25519
identity/signing key over a **canonical tuple** (serialized per doc 04 §4.5):

```
mutationTuple = {
  "vaultId":   "<uuid>",
  "itemId":    "<uuid>",
  "version":   <int>,
  "keyVersion":<int>,
  "digest":    "<hex SHA-256( ciphertext_envelope || wrappedIK_envelope )>",
  "authorUserId": <int>,
  "ts":        "<RFC3339>"
}
signature = Ed25519_sign(authorSigningPriv, SHA-256(JCS(mutationTuple)))
```

A verifying peer recomputes the digest from the stored envelopes, rebuilds the tuple, and
verifies against the author's published signing key (selected from signing-key history by
`ts`/`seq`, doc 05 §5.5). Result: **a malicious server cannot forge or silently alter an
item attributable to a member**, and a viewer's unauthorized write is detectable because
either the signature is missing or the signer lacks editor+ role.

## 10.5 Signed vault-head (rollback / omission detection)

A server can always *withhold* or *roll back* updates (an availability/equivocation attack
it can attempt regardless of crypto). We make it **detectable**:

- The vault maintains a **hash chain** over its mutations:
  `chainHash_n = SHA-256( chainHash_{n-1} || mutationDigest_n )`, `chainHash_0 = 0`.
- The latest writer (or any client after a successful write) signs the **head**:
  `head = { vaultId, seq, chainHash, ts }`, `headSig = Ed25519_sign(signingPriv, JCS(head))`,
  and uploads it (`GET/PUT /vaults/:id/head`).
- On sync, each client:
  1. **Gap-checks `seq`** — any hole means the server omitted a mutation → raise an integrity
     alarm.
  2. **Recomputes `chainHash`** over the mutations it received and compares to the signed
     head. A mismatch means truncation, reordering, or substitution.
  3. Verifies `headSig` against a member's signing key.
- Because the head is signed by a client key the server doesn't hold, the server cannot
  fabricate a head consistent with a rolled-back history. A server that shows different
  clients different heads (equivocation) is detectable when those clients ever compare heads
  (peer gossip / a later writer's head referencing a `seq` a victim never saw).

**Scope honesty:** this is rollback/omission *detection*, not prevention, and it is not a
full transparency log. It catches the common "server quietly reverted my change" and
"server hid a member's update" cases. Full equivocation-proof guarantees (a la CT/key
transparency) are `[future]` (doc 06 §6.5).

## 10.6 Replay protection

- `version` (per item) is monotonic; signatures bind `version`, so replaying an older signed
  blob is detected by version regression on the client.
- `seq` (per vault) is monotonic and gap-checked (§10.5); a replayed/duplicated mutation
  breaks the chain hash.
- `ts` in the tuple is advisory (clock skew), not a security boundary; ordering security
  comes from `version`/`seq`, not timestamps.

## 10.7 Large operations (rotation, migration)

VK rotation and v1→v2 migration touch many rows. They run as **resumable background jobs**:

- Rotation re-wraps IKs in batches inside a transaction per batch; `currentKeyVersion` flips
  only after all grants for `v+1` are written, so readers never see a half-rotated vault.
- Migration (doc 16) is **idempotent and resumable** per item, with a compatibility read
  path for not-yet-migrated items.
- Progress is surfaced to the user; interruption (device sleep, network) resumes from the
  last committed batch.

## 10.8 Offline & reconnection

- The desktop SQLCipher cache (doc 12) holds the last-synced ciphertext + the client's
  cursor, so the vault is usable offline (read; writes queued).
- On reconnect, queued writes replay with their `Idempotency-Key`s; conflicts resolve per
  §10.3; the client re-verifies the signed head before trusting server state.

## 10.9 Consistency invariants (testable)

- `seq` is gap-free and strictly increasing per vault.
- A delete is observable to every device that syncs past its `seq` (no resurrection of
  deleted items).
- No credential is destroyed by a conflicting concurrent edit (conflict-preserving).
- A retried write with the same `Idempotency-Key` produces exactly one row.
- A tampered, reordered, or omitted mutation history fails chain-hash verification against
  the signed head.
