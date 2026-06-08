# ADR-006 — Master-password recovery: a dedicated break-glass flow

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** ethchor
- **Depends on:** ADR-002 (PQ-hybrid identity), the docs/06 enrollment model

## Context

Two things were open here. The visible one was a **product/UX call** — the STATUS.md open
question *"should the master-password recovery flow live in the unlock screen or as a
separate route?"* The less visible one: **there was no recovery flow at all**. `@arc/crypto`
had `recoverIdentityPriv` (unwrap the identity key with the recovery key), but no
re-enrollment, no server endpoint to replace a keyset, and no UI past the one-time
"save your recovery key" card shown at enrollment. So "deciding placement" meant building
the flow and placing it.

A second gap surfaced while designing it: enrollment recovery-wraps the **identity** keys
(X25519 + ML-KEM-768) but **not the signing** key. That makes a *clean* recovery impossible —
you could restore the keys that decrypt the vault but not the Ed25519 key that signs
mutations, heads, attestations, and (now) Engine-C delegations. Recovery would be forced to
*rotate* the signing key (changing `signingPublicKey`), which ripples into every signature
verifier and complicates the anti-takeover story.

## Decision

### 1. Placement — a dedicated screen, reached from the unlock screen

Recovery lives on its own **`RecoverScreen`**, entered via a low-emphasis
*"Forgot your master password?"* link on the **unlock screen**. It is **not** inline in the
unlock screen and **not** buried in `RecoveryKeyCard`.

Rationale:

- **Recovery is rare, high-stakes, and multi-step** (enter recovery key → choose a new master
  password → re-wrap keys → receive a *new* recovery key). The unlock screen is the per-session
  hot path; cramming a break-glass flow into it clutters the common case and invites misfires.
- **Discoverability is solved by convention.** Every user knows to look for "forgot password?"
  on the sign-in/unlock screen. One link there is the right entry point — no more, no less.
- **The flow needs room to be careful.** A dedicated screen can present the new recovery key
  prominently and force acknowledgement before the user leaves — awkward to do inline.
- **`RecoveryKeyCard` stays single-purpose:** "here is a recovery key, save it" — shown after
  enrollment *and* after a successful recovery. It never hosts the flow itself.

### 2. Recovery is a pure re-wrap — no public key ever changes

To make recovery surgical, enrollment now **also recovery-wraps the signing key**
(`encSigningPrivRecovery`), additive and nullable for back-compat. Recovery then:

1. unwraps identity-X25519 + identity-ML-KEM + signing private keys with the recovery key;
2. derives a fresh work key from the **new** master password (fresh salts / Argon2 params);
3. re-wraps all three private keys under the new WK;
4. generates a **new** recovery key and re-wraps the recovery envelopes under it;
5. recomputes the server auth hash; regenerates the self-attestation (same pubs, new `ts`,
   signed by the recovered signing key);
6. keeps **every public key and the key version identical**.

Because the identity *and* signing public keys are unchanged, **every existing VK grant,
device grant, membership, and signature stays valid** — recovery restores access without
touching the cryptographic identity at all.

### 3. Server authorization — anti-takeover by pinning every public key

The new `POST /vault/keyset/recover` endpoint (authenticated with the account session)
replaces only the *wrapping* layer of an existing keyset. It **refuses (400) if any of the
three public keys differ from what is stored.** This is the anti-takeover guarantee: a party
with a session but without the recovery key cannot swap in their own identity, because the
account's public identity is immutable through this path — so they can never make the vault
decrypt under their keys.

**Residual risk (documented, not hand-waved).** A party who already holds a valid session but
*not* the recovery key could upload wrapping envelopes that don't actually unwrap the real
private keys — locking the legitimate user out (a **denial-of-service / lockout**, never a
takeover, since the pubs are pinned and the vault still only decrypts under the real keys).
This self-heals: the real user re-runs recovery with their recovery key and overwrites the
garbage. The session is the account-ownership anchor (OAuth in production), so an attacker who
holds it has bigger leverage than recovery-lockout, and still cannot read the vault. A future
hardening pass can require a server-issued challenge signed by the recovered signing key to
*prove* recovery-key possession before accepting the reset; the interface leaves room for it.

## Construction

No new crypto primitive — recovery reuses `aeadSeal` / `aeadOpen`, `deriveMasterKey` /
`splitMasterKey`, `deriveRecoveryWrapKey`, and `signObject` exactly as enrollment does. The
only new code is the `recover()` orchestration in `@arc/crypto`, one additive recovery
envelope, the keyset-replace endpoint with its pin check, the SDK `recoverWithKey`, and the
`RecoverScreen` + the unlock-screen entry point.

## Migration

- **Schema:** migration adds the nullable `vault_user_keys.encSigningPrivRecovery` column.
- **`EnrollDto`:** gains an optional `encSigningPrivRecovery` (older clients omit it).
- **Data:** none. Keysets enrolled before this change have a null column; recovery requires
  the recovery-wrapped signing key, so it is available only to keysets enrolled with it. Given
  the project is pre-production, no production users are affected; older test keysets simply
  don't exercise the recovery path.

## Consequences

**Better.** Recovery exists, is reachable from exactly where users look for it, restores
access with zero public-key churn, and can never be turned into account takeover. The recovery
key rotates on use (single-use in spirit — the old one no longer matches the re-wrapped
envelopes).

**Cost.** One extra recovery-wrapped envelope per enrollment (~1.4 KB), a nullable column, and
the documented lockout residual until the optional challenge-proof hardening lands.

## Test plan

- **Crypto:** enroll now emits `encSigningPrivRecovery`; `recover()` round-trip restores
  identity + signing from the recovery key, re-wraps under a new password, `unlock(newPw)`
  yields byte-identical pubs; old password fails; the new recovery key recovers a second time;
  the old recovery key no longer matches.
- **e2e:** enroll → recover (new password) → unlock with the new password; a recover whose
  identity pub differs is rejected 400; audit emits `keyset_recovered`.
