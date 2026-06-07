/**
 * Engine-C — agentic identity crypto helpers (ADR-005). These are thin, typed wrappers
 * over the *existing* signing primitives (`signObject` / `verifyObject` = Ed25519 over
 * `SHA-256(JCS(object))`). No new algorithm is introduced — the point of centralising them
 * here is to pin the exact canonical byte layout in one place so a Rust verifier
 * (`vault-crypto-rs`) can reproduce it for cross-platform delegation/intent verification
 * (the signing contract in docs/04).
 *
 * `DelegationClaims` and `IntentClaims` are the source-of-truth shapes from `@arc/types`;
 * here they are treated as `JsonValue` for canonicalisation. The `as unknown as JsonValue`
 * casts are safe because both are flat JSON-only objects by construction.
 */

import type { DelegationClaims, IntentClaims } from "@arc/types";
import { sha256 } from "./primitives";
import { toHex, utf8 } from "./bytes";
import { jcs } from "./jcs";
import { signObject, verifyObject } from "./sign";
import { chainNext } from "./sign";
import type { SignatureEnvelope } from "./envelope";
import type { JsonValue } from "./types";

/**
 * `argsDigest = SHA-256( JCS(args) )`, hex. Binds a request body into a `SignedIntent`
 * without the server ever logging or needing the plaintext args — it recomputes this
 * digest over the received body and checks equality.
 */
export function intentArgsDigest(args: JsonValue): string {
  return toHex(sha256(utf8(jcs(args))));
}

/** Sign a delegation with the delegating **user's** identity Ed25519 key. */
export function signDelegation(
  userSigningPriv: Uint8Array,
  claims: DelegationClaims,
  kid?: string,
): SignatureEnvelope {
  return signObject(userSigningPriv, claims as unknown as JsonValue, kid);
}

/** Verify a delegation against the delegating user's published Ed25519 verifying key. */
export function verifyDelegation(
  userSigningPub: Uint8Array,
  claims: DelegationClaims,
  sig: SignatureEnvelope,
): boolean {
  return verifyObject(userSigningPub, claims as unknown as JsonValue, sig);
}

/** Sign an intent with the **agent's** identity Ed25519 key. */
export function signIntent(
  agentSigningPriv: Uint8Array,
  claims: IntentClaims,
  kid?: string,
): SignatureEnvelope {
  return signObject(agentSigningPriv, claims as unknown as JsonValue, kid);
}

/** Verify an intent against the agent's published Ed25519 verifying key. */
export function verifyIntent(
  agentSigningPub: Uint8Array,
  claims: IntentClaims,
  sig: SignatureEnvelope,
): boolean {
  return verifyObject(agentSigningPub, claims as unknown as JsonValue, sig);
}

/**
 * Per-intent chain digest: `SHA-256( JCS(intentClaims) )`, hex. This is the value folded
 * into the per-task hash chain (`chainNext`), giving a tamper-evident, replay/gap-detectable
 * ordering of every action in a task — the same construction docs/10 uses for vault
 * mutations, applied to agent intents (ADR-005 Phase 3).
 */
export function intentDigest(claims: IntentClaims): string {
  return toHex(sha256(utf8(jcs(claims as unknown as JsonValue))));
}

/**
 * Advance a task's intent chain by one signed intent: `chainNext(prev, intentDigest(claims))`.
 * Re-exported convenience so server + SDK + a Rust verifier all fold the chain identically.
 */
export function intentChainNext(prevChainHex: string, claims: IntentClaims): string {
  return chainNext(prevChainHex, intentDigest(claims));
}
