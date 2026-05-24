# 01 — Overview & Goals

## 1.1 Vision

arc-vault is a zero-knowledge encrypted vault. The defining constraint is that the server
is a **blind ciphertext store**: it stores salts, wrapped keys, ciphertext, and non-content
metadata, and it can never decrypt anything. All key material is derived and used
client-side only.

The product ambition is to serve two surfaces from **one protocol and one data model**, so
that we never maintain two divergent crypto stacks:

- **Consumer password manager** — a person stores logins, cards, notes, TOTP seeds; unlocks
  with a master password or passkey; autofills in the browser and on mobile; recovers with
  a one-time recovery key.
- **Developer / team secrets infrastructure** — teams store API keys, certificates,
  environment secrets; share via role-based vaults; grant CI/CD pipelines and service
  accounts scoped, revocable access; and need audit and org governance.

## 1.2 One protocol, two personas

The unifying idea (formalized in doc 03): **a personal vault is just a vault with one
`owner` member.** Everything — personal logins and a team's production secrets — is a
`vault` containing `vault_items`, accessed through `vault_memberships` and key `grants`.
There is exactly one read/write/sync/rotate code path.

| Concern | Consumer expression | Developer expression |
| ------- | ------------------- | -------------------- |
| Identity | one person, one master password | humans + **service accounts** (machine identities) |
| Sharing | "share this login with my spouse" | role-based team/org vaults |
| Access automation | autofill, passkeys | CI/CD secret injection, scoped API tokens |
| Recovery | one-time recovery key | recovery key + optional **org escrow** (explicit ZK tradeoff) |
| Trust questions | "can the company read my passwords?" (no) | "can a revoked engineer still read prod?" (rotate; doc 07) |
| Surface | browser extension, mobile, desktop | API, SDK, CLI, audit feed |

Where the two personas pull in different directions, the doc says so explicitly rather than
pretending one design fits perfectly.

## 1.3 Locked product decisions

These are settled and shape everything downstream:

1. **Independent master password.** Vault unlock is decoupled from account login. Account
   login (e.g. OAuth) authorizes *sync* — it answers "who owns these encrypted blobs" — and
   never unlocks the vault. The master password and everything derived from it never reach
   the server.
2. **Cloud sync from day one.** The server stores ciphertext and syncs it across devices
   over an authenticated transport, including a device-approval flow.
3. **Recovery-key-only recovery.** A one-time, high-entropy recovery key is generated at
   setup and shown once. There is no server-side reset and no escrow in the base product.
   Losing the master password **and** the recovery key means permanent, unrecoverable data
   loss. (Enterprise opt-in escrow in doc 14 is a deliberate, surfaced exception for
   org-managed vaults only.)

## 1.4 Design tenets

- **Zero server trust for confidentiality.** The server is assumed hostile for reads. We
  never hold a server-side decryption key. (Contrast: a "server-held encryption key with a
  fallback default" pattern is explicitly forbidden — see doc 15 §15.4.)
- **Honest about what crypto can't do.** Read access is cryptographically enforced; some
  controls (viewer-vs-editor, delegated-access expiry) are server-enforced. We document the
  boundary instead of overclaiming (doc 07 §7.3).
- **Client compromise is a real, bounded threat.** While a client is unlocked, code running
  in it can read decrypted data. We minimize the unlock window and the unlocked surface; we
  do not pretend a tamperproof client is achievable (doc 02 §2.4).
- **Crypto agility without crypto churn.** Every ciphertext and signature is wrapped in a
  versioned envelope (doc 04) so algorithms and parameters can roll forward. The *current*
  algorithm set is fixed and not up for redesign.
- **Metadata is a leak, and we measure it.** We enumerate what the server can infer and what
  we do about it (doc 02 §2.5) instead of waving it away.
- **Specify for interop.** TS and Rust clients must produce identical bytes for the same
  inputs; serialization and signing are pinned to the byte level (doc 04).

## 1.5 Non-goals (base product)

- Server-side search over plaintext (search is client-side over decrypted items).
- Server-side password reset / account-recovery escrow (except opt-in org escrow, doc 14).
- Defending a *running, unlocked, compromised* client from itself.
- Hiding coarse metadata (counts, sizes, timing) from a malicious server beyond the
  mitigations in doc 02 §2.5.
- A formal transparency log; we provide signed-vault-head rollback *detection* (doc 10),
  not a full append-only transparency guarantee.

## 1.6 How the rest of the docs fit together

Crypto foundation (03, 04) → identity & rotation (05) → how users get in and add devices
(06) → how vaults/roles/sharing work (07) → how it's stored and exposed (08, 09) → how it
stays consistent and tamper-evident across devices (10) → privacy/audit (11) → the clients
(12, 13) → the developer surface (14) → how we test, review, and operate it (15) → the
sequencing (16). The threat model (02) is the lens for all of it.
