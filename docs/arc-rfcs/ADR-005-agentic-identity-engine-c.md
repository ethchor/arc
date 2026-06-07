# ADR-005 — Engine-C: agentic identity, signed delegation, and continuous trust

- **Status:** Accepted — v1 (Phases 1+2) implemented; Phases 3–5 queued
- **Date:** 2026-06-07
- **Deciders:** ethchor
- **Depends on:** ADR-002 (PQ-hybrid grants), ADR-003 (hybrid device keys),
  ADR-004 (out-of-process / WASM plugin host)
- **Touches:** `@arc/types`, `@arc/crypto` (reuse only), `@arc/grants`,
  `@arc/leasing`, `arc-server`, `@arc/sdk`, `docs/02`, `docs/07`, `docs/10`,
  `docs/11`, `docs/13`, `docs/14`

## Context

Three things are now true at once:

1. AI agents are first-class callers of arc. `infra/arc-mcp-server` already
   exposes arc to MCP clients; the WASM/OOP plugin host (ADR-004) runs
   third-party tool code; the planned `apps/arc-agent` will auto-auth and
   template secrets into workloads.
2. An agent is **not** a service account with a nicer name. It chains tool
   calls, adapts its plan mid-task, and acts in stretches the human behind it
   never watches step-by-step.
3. The industry framing (HashiCorp's "continuous trust" / "shape of trust"
   posts, Gartner's 45:1 machine-to-human identity ratio) converges on a
   model arc only *partially* implements today.

That model, distilled to its load-bearing claims:

- **Every agent has its own verifiable, cryptographically bound identity** —
  no shared keys, no borrowed human role.
- **Two access modes:** *delegated* (acts on-behalf-of a user) and
  *autonomous* (its own authority, no human in the loop).
- **Credentials are JIT and task-scoped** — issued at the moment of action,
  revoked when the task ends, never left "warm".
- **Authorization happens at the point of action, continuously** — not once
  at provisioning, not once at login.
- **Every action is an attributable decision:** *which identity authorized
  this, under what scope, on whose behalf, when.*

### Where arc already meets it

| Requirement | arc today |
| --- | --- |
| JIT dynamic credentials | `@arc/leasing` + Engine-A (OpenBao adapter): KV / transit / PKI / DB creds |
| Path + capability ACL, deny-by-default | `@arc/grants` (`Scope`, `Capability`, persistent store, policy cache) |
| Tool-code isolation | ADR-004 OOP/WASM host, deny-by-default WASI profile |
| PQ-resistant cryptographic identity | ADR-002 (user identity), ADR-003 (device) |
| Metadata-only, integrity-chained audit | `vault_audit_log` + signed vault-head (docs/10, docs/11) |
| Service accounts / machine identities | docs/14 |

### The gap this ADR closes

What arc is **missing** is the layer *above* credentials: the agent as a
principal, and the cryptographic chain that ties a human's approval to an
agent's action.

- Agents are invisible. They authenticate either as a service-account user or
  inside a human's JWT session. There is no `AgentIdentity` to scope, attribute,
  rate-limit, or retire on its own.
- Delegation is a bearer token. An agent acting "for" a user carries that
  user's JWT verbatim. Nothing records *user X delegated scope Y to agent Z for
  task T, until time U* — so the attribution chain HashiCorp leads with cannot
  be reconstructed, and a delegated agent can wander to anything the user can
  reach (context drift), not just what it was sent to do.
- Authorization sees observed actions, not declared intent. The capability
  guard checks the request that arrived; there is no signed statement of what
  the agent *meant* to do, so "what the human approved" and "what the agent
  decided on its own" can't be separated.
- There is no task boundary. Nothing groups an agent's credentials, leases, and
  tool calls under one revocable unit, so access opened during a task doesn't
  close cleanly when the task ends.
- Elevation has no human-in-the-loop gate. arc ships passkeys (docs/13) but
  never wires them as an out-of-band approval for a privileged agent op.

Notably, the HashiCorp posts **state the principles but decline to specify the
wire shapes** — they explicitly do not define attestation formats, signed-intent
schemas, or revocation protocols. That gap is arc's opening: we specify them,
and we make them *cryptographic* rather than "centrally logged, trust us".

## Decisions resolved

Three open questions were settled before implementation; recorded here so the rationale
travels with the design.

1. **v1 scope = Phases 1+2 (principal + delegation + intersection + attribution), with the
   Phase-3 wire types pinned now.** Delegation-with-intersection is independently safe — it
   can only *narrow* authority and is server-enforced, scoped, expiring, and attributable —
   and shipping a tested, coherent cut beats a rushed mega-PR. Pinning `SignedIntent` /
   `AgentTask` in `@arc/types` in v1 keeps the cryptographic action chain (Phase 3) purely
   additive. **Honest framing of the progression:** v1 is *server-enforced* delegation;
   Phase 3 upgrades it to *cryptographically-bound* intent. v1 deliberately ships **no
   bearer-token agent credential** — an agent's authenticated action path arrives with
   signed intent in Phase 3, so we never ship the bearer weakness this ADR critiques.

2. **Autonomous agents are deny-by-default; explicit per-agent `autonomousAllowed` opt-in.**
   Autonomous mode is the highest-blast-radius principal (own authority, no human, outside
   any user's scope), so secure-by-default + least-privilege demand it be off until an admin
   deliberately enables it — mirroring `@arc/grants` deny-by-default and ADR-004's
   deny-by-default WASI. Delegated mode works freely; autonomous remains bounded by the
   agent's own policy ceiling even once enabled.

3. **Attestation: SPIFFE/SPIRE first (X.509-SVID + JWT-SVID), behind a pluggable
   `AttestationVerifier` interface.** arc's K8s/operator direction plus SPIFFE being the
   CNCF workload-identity standard the reference posts name first makes it the right concrete
   anchor; the *interface* is the real decision so sigstore/TPM/cloud-IID slot in later. v1
   records the attestation blob (the `vault_agents.attestation` column + the wire type);
   enforcement is Phase 5.

## Decision

Introduce **Engine-C — agentic identity** as a distinct principal type and a
small set of signed envelopes that compose with the engines already shipped.
Engine-C owns *who an agent is and on whose authority it acts*; Engine-A still
issues the credentials, Engine-B still owns the E2E vault, `@arc/grants` still
owns policy. Engine-C adds the principal and the proof chain between them.

Five primitives, each reusing existing crypto — **no new algorithm**
(CLAUDE.md rule 5):

### 1. `AgentIdentity` — a first-class principal

An agent is its own principal, not a user and not a service account. It carries
the same key shapes ADR-002/003 already define so every existing grant path
works unchanged:

- an **Ed25519 signing keypair** (signs delegations it receives and intents it
  emits — verified against its published `signingPublicKey`);
- a **hybrid identity keypair** (X25519 + ML-KEM-768) so VK grants and dynamic
  creds can be sealed *to the agent* with `pqSeal` (ADR-002), HNDL-resistant;
- an **owner** (a user id, or an org/group handle) — the authority the agent
  ultimately answers to;
- an optional **attestation** blob (see §5);
- `status` (`active` | `suspended` | `retired`) and `lastSeenAt`.

Agents attach to `@arc/grants` policies through a new opaque subject handle
`agent:<agentId>` — the policy engine already treats subjects as opaque strings
(`PolicyStore.getPoliciesForSubject`), so agents get policies, groups, and the
capability guard with zero engine changes. An agent's **own** policy is its
*ceiling*: it can never act beyond it, delegated or not.

### 2. `DelegationGrant` — signed, scoped, time-boxed on-behalf-of

When a user puts an agent to work on their behalf, the user **signs** a
delegation with their identity signing key (`signObject`, the Ed25519-over-
JCS-SHA-256 primitive already used for mutations and vault-heads):

```
DelegationGrant = sign_user_signingPriv({
  v:         1,
  delegator: "user:<id>",            // who is lending authority
  agent:     "agent:<id>",           // to whom
  scopes:    Scope[],                // @arc/grants Scope: { pathPrefix, capabilities }
  taskId:    "<uuid>",               // binds this delegation to one task (§4)
  notBefore: "<iso>",
  notAfter:  "<iso>",                // hard server-enforced expiry
  maxCalls:  <int | null>,           // optional call budget
  elevated:  false,                  // true ⇒ each use needs push-consent (§4 of docs/13 reuse)
  nonce:     "<b64u>"
})
```

The server verifies the signature against the delegator's **published**
`signingPublicKey` (already stored in `vault_user_keys`), then records the
grant. This is the attribution chain HashiCorp asks for — *who approved, on
whose behalf, for what scope, for how long* — as a verifiable artifact, not a
log line.

**Effective scope is an intersection, never a union.** For a delegated request
on `path` needing `capability`:

```
allow ⇔ scopeAllows(delegation.scopes, path, cap)      // what was delegated
      ∧ effectivePolicyAllows(delegator, path, cap)     // delegator's own ceiling
      ∧ effectivePolicyAllows(agent, path, cap)         // agent's own ceiling
      ∧ now ∈ [notBefore, notAfter] ∧ callsUsed < maxCalls
```

A delegation can only ever **narrow**. A user cannot delegate authority they
lack (no escalation), and an agent cannot exceed its own policy even if
over-delegated (no accumulation). Autonomous mode is the same rule with the
delegation clause dropped and the agent's own policy as the sole ceiling.

### 3. `SignedIntent` — authorize the declared action, not just the observed one

Every state-changing agent call carries an intent the agent signs **before** the
server executes anything:

```
SignedIntent = sign_agent_signingPriv({
  v:          1,
  agent:      "agent:<id>",
  delegation: "<delegationId | null>",   // null ⇒ autonomous
  taskId:     "<uuid>",
  op:         "kv.put" | "vault.item.update" | "transit.encrypt" | ...,
  path:       "secret/data/app/db",
  argsDigest: "<sha256 hex of JCS(args)>",   // binds the body without logging it
  ts:         "<iso>",
  nonce:      "<b64u>"
})
```

The guard verifies: agent signature valid → intent's `op`/`path`/`argsDigest`
match the actual request → delegation valid → effective scope allows → budget
not exhausted → **then** execute. Policy and audit now operate on a *declared,
signed* intent, cleanly separating "what the human approved" from "what the
agent decided on its own". Replay is blocked by `nonce` + task-chain position
(§4); the server never has to trust the body it can't see, because `argsDigest`
binds it.

### 4. Task boundary — one revocable unit, one tamper-evident chain

A `vault_agent_tasks` row is the unit of blast-radius control:

```
Task = { taskId, agentId, delegationId|null, ownerUserId,
         budget: { wallClockMs, maxCalls, maxSecretsUnsealed },
         chainHead, headSig, status, openedAt, closedAt }
```

- **Cascading revoke.** Every credential lease (`@arc/leasing`), issued JWT, and
  delegated VK grant created during the task is tagged with `taskId`.
  `task.close()` — explicit, budget-exhausted, or `notAfter` reached — revokes
  all of them in one shot via the leasing manager's existing revoke path.
  Access opened during the task closes when the task does.
- **Per-task action chain.** Each `SignedIntent` extends a hash chain with the
  existing `chainNext(prev, sha256(JCS(intent)))` primitive; the agent signs the
  resulting `chainHead` (`signHead`-shaped). This yields a tamper-evident,
  replay-resistant, gap-detectable ordering of *everything the agent did in the
  task* — the same integrity guarantee docs/10 gives vault mutations, now applied
  to agent actions. This is the part that goes **beyond** the reference model: a
  verifiable cryptographic action log, not centralized logging you have to trust.

### 5. Continuous trust: push-consent, attestation, attribution

- **Push-consent (arc's CIBA, built on our own passkeys).** A delegation or
  scope marked `elevated`, or any `sudo` capability, requires out-of-band human
  approval per use. The server returns `403 { approvalId, expiresAt }` and writes
  a `vault_pending_approvals` row; the owning user approves with a **WebAuthn
  assertion** (docs/13) on a trusted device — proof of control, not a tappable
  "yes"; the agent re-runs the identical signed intent. No third-party IdP: the
  approval primitive is the passkey stack arc already ships.
- **Attestation hook (optional, pluggable).** At enrollment an agent may present
  a SPIFFE SVID, a sigstore bundle, or a TPM quote, recorded as the opaque
  `attestation` blob behind a verifier interface. v1 records + surfaces it; v2
  lets org policy *require* a valid attestation to enroll or to receive
  `elevated` delegations — turning "I'm `arc-mcp-server@x.y`" from a claim into a
  checkable fact. SPIFFE/sigstore are *inputs*, never required runtime deps.
- **Attribution columns (additive, no migration risk).** `vault_audit_log` gains
  nullable `actorKind` (`user` | `agent` | `service` | `device`), `agentId`,
  `delegationId`, `taskId`, and an optional `toolCall` JSON
  (`{ mountPath, op, durationMs, status }`). The existing audit query API
  (docs/11) then answers "every agent-driven write on vault X, under which
  delegation, in which task" with no new endpoint.
- **RFC 8693 `act` claim.** An agent's JWT carries `act: { sub: "agent:<id>" }`
  over the user `sub`, so the on-behalf-of relationship is legible to standard
  OAuth tooling too, not only to arc-native verifiers.

## Construction

Nothing here is a new cryptographic primitive. Every signature is
`signObject` / `verifyObject` (Ed25519 over `SHA-256(JCS(object))`, ALG pinned
in the envelope). Every seal-to-agent is `pqSeal` / `pqSealOpen` from ADR-002.
Every chain step is `chainNext`; every head signature is `signHead`-shaped. The
delegator's verifying key is the `signingPublicKey` already published at
enrollment. The only genuinely new code is *entities, a guard composition, and
the SDK/HTTP surface* — the crypto is load-bearing reuse, which is the point:
agentic identity should not need a new algorithm, only a new principal and a
proof chain over primitives we already test for TS↔Rust parity.

## Data model (additive)

- `vault_agents` — `id, ownerUserId, displayName, signingPublicKey,
  identityPublicKey, identityPublicKeyMlkem, attestation (nullable json),
  status, createdAt, lastSeenAt`.
- `vault_delegations` — the verified `DelegationGrant` + `delegatorUserId,
  agentId, taskId, notBefore, notAfter, maxCalls, callsUsed, elevated,
  signature, revokedAt`.
- `vault_agent_tasks` — `taskId, agentId, delegationId, ownerUserId, budget
  (json), chainHead, headSig, status, openedAt, closedAt`.
- `vault_pending_approvals` — `id, agentId, taskId, intentDigest, requestedScope,
  expiresAt, resolvedAt, decision`.
- `vault_audit_log` — **+** nullable `actorKind, agentId, delegationId, taskId,
  toolCall (json)`. All nullable ⇒ old rows and old clients are unaffected.

Leases (`@arc/leasing`) gain an optional `taskId` tag so close-cascades can find
them. No Engine-A/OpenBao change — the tag lives in arc's lease metadata.

## Engine boundaries (unchanged invariants)

- **Engine-B master key stays unreachable.** An agent never receives the E2E
  master key (CLAUDE.md rule 6). The most a delegated agent gets is a VK grant
  scoped to specific vault/items, `pqSeal`-wrapped to the agent's hybrid
  identity and carrying the delegation's `notAfter`. Revoking the task revokes
  the grant.
- **Engine-A still issues creds.** Task budget drives lease TTL and the
  cascading revoke through the existing leasing manager; arc does not
  reimplement OpenBao leasing (CLAUDE.md rule 2).
- **`@arc/grants` still owns policy.** Engine-C *composes* with it via scope
  intersection; it does not replace the capability guard.

## Phasing

Mirrors ADR-002's incremental shape so each phase ships green on its own.

1. **Principal + attribution.** `vault_agents` + registration + signing-key
   publish + the additive audit columns. Agents become visible and attributable.
   → `feat/agent-identity-and-delegation` (part 1).
2. **Delegation + intersection.** `DelegationGrant`, verification, effective-scope
   intersection wired into the capability guard. → same branch (part 2).
3. **Signed intent + task chain + budget + cascading revoke.**
   → `feat/signed-intent-and-task-budget`.
4. **Push-consent CIBA via passkeys.** → `feat/push-consent-ciba`.
5. **Attestation enforcement + plugin-manifest provenance** (signed manifest,
   per-plugin `sha256`, mount refused on hash mismatch — extends ADR-004).
   → `feat/attestation-and-plugin-manifest`.

Quick wins that can land alongside: RFC 8693 `act` claim (SDK one-liner + guard
check); an NHI inventory view in `arc-vault-web` (agents + service accounts +
last-seen + scope summary + retire).

## What this is NOT

- **Not a new crypto primitive.** Reuses `signObject`/`verifyObject`, `pqSeal`,
  `chainNext`, `signHead`. No hand-rolled algorithms.
- **Not a replacement for `@arc/grants`.** Delegation *narrows* via intersection;
  the policy engine remains the authority on an agent's ceiling.
- **Not master-key access for agents.** Ever. Delegated vault access is a scoped,
  expiring, task-bound VK grant — never the MK.
- **Not a third-party IdP dependency.** Push-consent is arc's own passkeys.
  SPIFFE / sigstore / TPM are optional attestation *inputs* behind a verifier
  interface, not required runtime deps.
- **Not a reimplementation of OpenBao leasing.** Task budgets drive the existing
  `@arc/leasing` revoke; Engine-A is unchanged.

## Licensing

The HashiCorp posts are read for *target behavior* only (CLAUDE.md rule 4); no
Vault BSL source is copied. The mechanisms here are arc-original (signed
delegation envelope, per-task signed-intent chain, passkey push-consent) or
built on open standards (OAuth 2.0 Token Exchange RFC 8693, WebAuthn, SPIFFE).
No license-boundary risk; this ADR records the decision per CLAUDE.md.

## Consequences

**Better.** Agents become first-class, attributable, revocable principals. The
human→agent→action path is a verifiable cryptographic chain (delegation → intent
→ task chain → audit row), not a stack of bearer JWTs. Delegation can only narrow,
killing both privilege escalation and accumulation. Task close gives one-shot
blast-radius containment. arc ends up *ahead* of the reference model precisely
where that model is silent: the wire shapes are specified and the trust is
cryptographic.

**Cost.** New entities, a guard composition, and per-op signing on the agent
side (one Ed25519 sign + a digest — cheap). Agent SDKs must sign intents and
manage a task lifecycle; the human-driven web/CLI paths are untouched (no
delegation ⇒ no intent ⇒ existing flow). Push-consent adds an out-of-band round
trip on elevated ops by design. Storage grows by O(agents × tasks × intents),
bounded by task-close retention (docs/11 windows apply).

**No worse for existing flows.** Every column is nullable; every signed envelope
is required *only* for agent-kind callers. A human with a passkey, a service
account with a static token, and a device grant all behave exactly as before.

## Test plan (for the implementing branches)

- **Unit (`@arc/types`/`@arc/crypto` reuse):** delegation sign/verify round-trip;
  tampered scope/agent/taskId/expiry each rejected; effective-scope intersection
  truth-table (delegated⊇/⊌ delegator⊇/⊌ agent); intent `argsDigest` mismatch
  rejected; task-chain `chainNext` ordering + gap detection.
- **e2e (`arc-server`):** register agent → user signs delegation → agent runs a
  signed intent through `/v1/*` and the vault API → audit row carries
  `actorKind=agent, agentId, delegationId, taskId` and leaks no plaintext;
  over-delegation beyond the delegator's policy is denied; `notAfter` denies;
  `task.close()` revokes every tagged lease + grant in one call; `elevated`
  op returns `403 { approvalId }`, a passkey assertion resolves it, the re-run
  succeeds.
- **Negative:** autonomous agent beyond its own policy denied; replayed intent
  (same nonce / stale chain head) denied; suspended/retired agent denied.
