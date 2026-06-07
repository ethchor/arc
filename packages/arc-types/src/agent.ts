/**
 * Engine-C — agentic identity wire shapes (ADR-005). These are the canonical, transport-
 * level objects for AI agents acting against arc: the principal, the signed delegation a
 * human grants it, and (pinned here for the next phase) the signed intent + task envelopes.
 *
 * Design rules:
 *  - **Dependency-free.** `@arc/types` is the source of truth and imports nothing. The
 *    scope/capability vocabulary is mirrored here as plain strings and validated against
 *    `@arc/grants`'s canonical `Capability` set at the server trust boundary (a permissive
 *    wire type narrowed to a strict domain type — never the reverse).
 *  - **Signable objects are flat JSON.** Every `*Claims` object is exactly what gets
 *    canonicalised (RFC 8785 JCS) and Ed25519-signed by `@arc/crypto`. Field order is
 *    irrelevant (JCS sorts keys); presence and type are the contract. Keep them flat so a
 *    Rust verifier can reproduce the bytes (the cross-platform signing contract, docs/04).
 */

import type { SignatureEnvelope } from "./envelope";

/** Lifecycle of an agent principal. Only `active` agents can authenticate or act. */
export type AgentStatus = "active" | "suspended" | "retired";

/**
 * How an agent is acting on a given request:
 *  - `delegated` — on behalf of a human, who signed a {@link DelegationClaims} for it.
 *  - `autonomous` — under its own authority, no human in the loop. Deny-by-default: an
 *    agent may only act autonomously when an admin set `autonomousAllowed` on it (ADR-005
 *    decision: autonomous is the highest-blast-radius principal, so it is opt-in).
 */
export type AgentMode = "delegated" | "autonomous";

/**
 * One path-prefix + capability grant, as it travels on the wire inside a delegation. The
 * shape is structurally identical to `@arc/grants`'s `Scope`; `capabilities` is loose
 * `string[]` here and validated against the canonical `Capability` union server-side
 * (unknown verbs → 400). Mirrors Vault's fixed verb set: create/read/update/delete/list/sudo.
 */
export interface DelegationScope {
  pathPrefix: string;
  capabilities: string[];
}

/**
 * The agent principal as exposed on the wire (public half only — no private keys ever
 * leave the agent). Mirrors the user/device identity shape (ADR-002/003): an Ed25519
 * signing key plus an X25519 + ML-KEM-768 hybrid identity so VK grants and dynamic creds
 * can be `pqSeal`-wrapped to the agent.
 */
export interface AgentIdentity {
  id: string;
  /** The user id that owns/answers for this agent. */
  ownerUserId: number;
  displayName: string;
  /** Ed25519 verifying key (b64url) — verifies intents the agent signs. */
  signingPublicKey: string;
  /** X25519 identity public key (b64url) — classical half of the hybrid seal. */
  identityPublicKey: string;
  /** ML-KEM-768 identity public key (b64url) — PQ half (ADR-002). */
  identityPublicKeyMlkem: string;
  /** Opaque, verifier-specific attestation (e.g. a SPIFFE SVID). `null` when none. */
  attestation: AgentAttestation | null;
  /** Deny-by-default: false unless an admin explicitly enabled autonomous operation. */
  autonomousAllowed: boolean;
  status: AgentStatus;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * Opaque attestation envelope recorded at enrollment. `kind` selects the verifier; `doc`
 * is the verifier-specific payload (a SPIFFE SVID string, a sigstore bundle, a TPM quote).
 * v1 (ADR-005 Phase 5) records + surfaces it; enforcement is a later pass.
 */
export interface AgentAttestation {
  kind: "spiffe" | "sigstore" | "tpm" | "none";
  doc: string;
  /** Recorded trust anchor (e.g. the SPIFFE trust domain) for display/audit. */
  trustAnchor?: string;
  /** Set when the server has verified the attestation at enrollment (ADR-005 Phase 5a). */
  verified?: boolean;
  /** Resolved workload subject (e.g. the full SPIFFE id) when `verified`. */
  subject?: string;
  /** ISO timestamp of the verification. */
  verifiedAt?: string;
}

/**
 * The signable body of a delegation: *user `delegator` lends scopes to agent `agent`,
 * bound to task `taskId`, valid `[notBefore, notAfter]`, capped at `maxCalls`.* The
 * delegating user signs this with their identity Ed25519 key; the server verifies against
 * their published `signingPublicKey`. Effective authority is the **intersection** of these
 * scopes with the delegator's own policy and the agent's own policy — a delegation can
 * only ever narrow (ADR-005).
 */
export interface DelegationClaims {
  /** Wire version of this claim shape. */
  v: 1;
  /** Delegator subject, always `user:<id>`. */
  delegator: string;
  /** Delegatee subject, always `agent:<id>`. */
  agent: string;
  scopes: DelegationScope[];
  /** Binds the delegation to one task unit (Phase 3). A fresh uuid per delegation. */
  taskId: string;
  notBefore: string;
  notAfter: string;
  /** Optional hard call budget. `null` = unlimited within the time window. */
  maxCalls: number | null;
  /** When true, each use requires out-of-band human approval (push-consent, Phase 4). */
  elevated: boolean;
  /** Anti-replay nonce (b64url, ≥ 16 bytes). */
  nonce: string;
}

/** A delegation as stored/transmitted: the claims plus the delegator's signature over them. */
export interface SignedDelegation {
  claims: DelegationClaims;
  signature: SignatureEnvelope;
}

// --- Phase 3 wire types: pinned now so signed-intent + task enforcement is additive ---

/**
 * The signable body of a single agent action. The agent signs this *before* the server
 * executes anything; the guard checks the signature, then that `op`/`path`/`argsDigest`
 * match the actual request, then the delegation + effective scope. Policy and audit thus
 * act on a declared, signed intent — separating "what the human approved" from "what the
 * agent decided". (ADR-005 Phase 3 — types pinned in v1, enforcement next.)
 */
export interface IntentClaims {
  v: 1;
  agent: string;
  /** The delegation this action is exercised under, or `null` for autonomous mode. */
  delegation: string | null;
  taskId: string;
  /** Logical operation, e.g. `kv.put`, `vault.item.update`, `transit.encrypt`. */
  op: string;
  /** Engine path the action targets, e.g. `secret/data/app/db`. */
  path: string;
  /** `sha256(JCS(args))` hex — binds the request body without the server logging it. */
  argsDigest: string;
  ts: string;
  nonce: string;
}

/** An intent as transmitted: the claims plus the agent's signature over them. */
export interface SignedIntent {
  claims: IntentClaims;
  signature: SignatureEnvelope;
}

/** Budget that bounds a task; exhausting any dimension closes the task and cascades revoke. */
export interface AgentTaskBudget {
  wallClockMs: number;
  maxCalls: number;
  maxSecretsUnsealed: number;
}

/** Lifecycle of a task unit. */
export type AgentTaskStatus = "open" | "closed" | "expired" | "exhausted";

/**
 * A task: the revocable unit tying an agent's delegation, leases, and signed-intent chain
 * together. `chainHead` is the running per-task hash chain (`chainNext`) head; `headSig` is
 * the agent's signature over it. (ADR-005 Phase 3 — pinned now.)
 */
export interface AgentTask {
  taskId: string;
  agentId: string;
  delegationId: string | null;
  ownerUserId: number;
  budget: AgentTaskBudget;
  chainHead: string;
  status: AgentTaskStatus;
  openedAt: string;
  closedAt: string | null;
}

// --- helpers ---

/** The `@arc/grants` subject handle for an agent. Subjects are opaque strings to the engine. */
export function agentSubject(agentId: string): string {
  return `agent:${agentId}`;
}

/** The subject handle for a user (the delegator side of a delegation). */
export function userSubject(userId: number | string): string {
  return `user:${userId}`;
}

/** True if `s` is a well-formed `agent:<id>` subject. */
export function isAgentSubject(s: string): boolean {
  return s.startsWith("agent:") && s.length > "agent:".length;
}
