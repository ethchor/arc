# 14 — Developer / Team Secrets Platform

This is the second persona (doc 01 §1.2): developer and team secrets infrastructure, built on
the **same** protocol as the consumer password manager. A service account is just a
non-human **identity** (doc 05); a CI pipeline is just a client that unlocks with an injected
key; an org is a `type=org` vault hierarchy. No new cryptography — new *identity types* and
*governance* on top of the existing layers.

## 14.1 Design principle: machines are identities

Everything that needs vault access has an **identity keypair** (X25519) and optionally a
**signing keypair** (Ed25519). Humans unlock theirs with a master password/passkey; machines
have theirs **injected** from a trusted secrets source. A grant is a grant regardless of
whether the grantee is a person or a pipeline — so RBAC, rotation, revocation, and audit all
work uniformly.

## 14.2 Service accounts (machine identities)

A service account is a non-human member of one or more vaults.

```
create:
  1. Admin POST /vaults/:id/service-accounts { name, role } (role typically viewer/editor).
  2. The SA gets an identity keypair. Its PRIVATE key is NOT wrapped under a master password
     (there is none); instead it is delivered once to the operator to place in a secrets
     manager / CI secret store, OR generated client-side and only its public key registered
     (preferred — the private key never transits the server).
  3. Admin wraps VK to the SA's identity pubkey → a vault_key_grant (granteeUserId = SA).
```

Properties:

- **Scoped:** an SA is granted only the specific vault(s) it needs (e.g. a `prod-db` vault),
  least privilege by construction.
- **Revocable like any member:** delete its grant + rotate the VK (doc 07 §7.5).
- **Auditable:** every use that hits the API is attributable to the SA (doc 11).
- **No master password / no recovery key:** an SA's access is its injected identity key; if
  that key is lost, the SA is simply re-created and re-granted (it owns no unique data — the
  vault data belongs to the vault).
- **Never in the repo:** the SA private key lives in a secrets manager / CI secret, injected
  at runtime via env, never committed (doc 15 §15.4).

## 14.3 CI/CD integration & scoped API tokens

Two access modes for automation:

1. **Identity-key injection (strongest):** the pipeline holds the SA's identity private key
   (from the CI secret store), unwraps the VK grant directly, decrypts the needed secrets
   client-side. The server still only relays ciphertext.
2. **Scoped API token (convenience):** a bearer token that authorizes *sync* for a specific
   SA + vault scope (mints via `POST /vaults/:id/tokens`). The token authorizes fetching the
   SA's wrapped grant + ciphertext; **decryption still requires the SA's identity key** — the
   token alone yields only ciphertext. Tokens are:
   - **scoped** (vault + capability),
   - **short-lived by default** with optional rotation,
   - **revocable** (`DELETE /vaults/:id/tokens/:tid`), and
   - **audited** at mint/use/revoke.

A typical CI flow: the runner has the SA identity key in its secret store **and** a scoped
token (or uses OIDC federation `[future]` to obtain a short-lived token), pulls the
ciphertext, decrypts in the runner's memory, injects secrets into the build env, and the
runner is ephemeral so nothing persists.

### CLI / SDK

A CLI and language SDKs wrap mode (1): `arc-vault read prod-db/DATABASE_URL` resolves the
SA's grant, decrypts locally, prints to stdout / exports to env. The SDK bundles
`packages/vault-crypto` so decryption is identical to every other client (doc 04 KATs apply).

## 14.4 Delegated / break-glass access

Time-boxed access for incident response or contractor work:

```
POST /vaults/:id/delegations { granteeUserId, role, expiresAt, wrappedVaultKey }
  → admin wraps the current VK to the delegate's identity key, with a server-recorded expiresAt.
```

- **Server-enforced expiry:** after `expiresAt` the server stops serving the grant and the
  delegation is audit-logged as `delegation_expired`. **Honesty:** this expiry is
  *server-enforced, not cryptographic* (doc 02 §2.6) — a hostile server could ignore it, and
  a delegate who copied secrets during the window keeps them. For true post-incident hygiene,
  **rotate the VK** (and the underlying real secrets) after a break-glass episode.
- **Audited end-to-end:** grant, (advisory) `item_viewed`, and expiry are all logged
  (doc 11), giving an incident timeline.

## 14.5 Org governance

`type=org` vaults sit above team vaults via `vaults.orgId` (doc 08 §8.2):

- **Org-admin** can manage child-vault *memberships and policy* without holding each child
  VK — membership/role management is server-enforced and signed (doc 10), and does not
  require decrypting the child vault. Reading a child vault's *contents* still requires an
  explicit grant (an org-admin is not automatically a reader of every team's secrets).
- **Policy controls (server-enforced):** minimum role for sharing, mandatory device approval,
  required passkey/2FA for unlock, audit retention (doc 11 §11.3), allowed delegation
  windows. These are governance, layered on the crypto — not a weakening of it.
- **Provisioning:** org admins can pre-create vaults and invite members (doc 06 §6.6); SCIM /
  directory sync for member lifecycle is `[future]`.

## 14.6 Enterprise recovery / escrow (opt-in, explicit ZK tradeoff)

Some orgs require recoverability of orphaned data (employee leaves, loses keys). Optional,
per-org, and **surfaced to members**:

- An **org recovery key** (held per org governance, ideally split via threshold sharing
  `[future]`) wraps a copy of each *managed* vault's VK → `encVaultKeyOrgEscrow`.
- This **deliberately weakens** pure zero-knowledge for escrowed vaults: the org (whoever
  holds the org recovery key) can decrypt them. That is the explicit tradeoff of escrow.
- **Scope is limited and visible:** only org-managed vaults flagged for escrow are covered;
  personal and non-escrowed vaults remain pure ZK. Members see an "org can recover this
  vault" indicator. Enabling/using escrow is heavily audited.

This is the one place the base product's "no escrow" rule (doc 01 §1.3) is relaxed, and only
behind an explicit, disclosed, per-org switch.

## 14.7 Threat notes (cross-ref doc 02 §2.6)

- A stolen SA key = exactly that SA's granted access until revoked; scope + rotation contain
  it.
- Over-broad grants are a policy failure; least-privilege vaults per environment are the
  mitigation.
- Delegated-access expiry is server-enforced; rotate after break-glass for real hygiene.
- A malicious org-admin can change policy and memberships but cannot read a child vault's
  contents without a grant; grant changes are signed and audited.

## 14.8 Invariants

- Machines are identities; one grant/rotation/revocation/audit path serves humans and
  machines alike.
- An API token alone yields only ciphertext; decryption always requires an identity key held
  by the client.
- Service-account private keys are injected from a secrets source, never committed to a repo.
- Escrow is opt-in, per-org, scoped to flagged vaults, surfaced to members, and audited.
