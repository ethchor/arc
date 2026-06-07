import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  intentArgsDigest,
  randomBytes,
  signDelegation,
  signIntent,
  toB64u,
  verifyDelegation,
  verifyIntent,
} from "../src/index";
import type { DelegationClaims, IntentClaims } from "@arc/types";

function freshDelegation(over: Partial<DelegationClaims> = {}): DelegationClaims {
  return {
    v: 1,
    delegator: "user:7",
    agent: "agent:abc",
    scopes: [{ pathPrefix: "secret/data/app", capabilities: ["read", "update"] }],
    taskId: "11111111-1111-1111-1111-111111111111",
    notBefore: "2026-06-07T00:00:00.000Z",
    notAfter: "2026-06-07T01:00:00.000Z",
    maxCalls: 100,
    elevated: false,
    nonce: toB64u(randomBytes(16)),
    ...over,
  };
}

describe("signDelegation / verifyDelegation", () => {
  it("round-trips under the delegator's signing key", () => {
    const user = generateSigningKeyPair();
    const claims = freshDelegation();
    const sig = signDelegation(user.priv, claims);
    expect(verifyDelegation(user.pub, claims, sig)).toBe(true);
  });

  it("rejects a wrong verifying key", () => {
    const user = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const claims = freshDelegation();
    const sig = signDelegation(user.priv, claims);
    expect(verifyDelegation(other.pub, claims, sig)).toBe(false);
  });

  it("rejects every tampered field (scopes, agent, expiry, taskId, maxCalls, elevated)", () => {
    const user = generateSigningKeyPair();
    const claims = freshDelegation();
    const sig = signDelegation(user.priv, claims);

    const tampers: Array<Partial<DelegationClaims>> = [
      { scopes: [{ pathPrefix: "secret/", capabilities: ["read", "update", "delete"] }] },
      { agent: "agent:evil" },
      { delegator: "user:1" },
      { notAfter: "2026-06-08T01:00:00.000Z" },
      { taskId: "22222222-2222-2222-2222-222222222222" },
      { maxCalls: 999999 },
      { elevated: true },
      { nonce: toB64u(randomBytes(16)) },
    ];
    for (const t of tampers) {
      expect(verifyDelegation(user.pub, { ...claims, ...t }, sig)).toBe(false);
    }
  });
});

describe("signIntent / verifyIntent + intentArgsDigest", () => {
  const intent: IntentClaims = {
    v: 1,
    agent: "agent:abc",
    delegation: "deleg-1",
    taskId: "11111111-1111-1111-1111-111111111111",
    op: "kv.put",
    path: "secret/data/app/db",
    argsDigest: intentArgsDigest({ value: "s3cr3t", b: 2, a: 1 }),
    ts: "2026-06-07T00:30:00.000Z",
    nonce: "nonce-xyz",
  };

  it("round-trips under the agent's signing key", () => {
    const agent = generateSigningKeyPair();
    const sig = signIntent(agent.priv, intent);
    expect(verifyIntent(agent.pub, intent, sig)).toBe(true);
  });

  it("argsDigest is canonical (key order independent) and binds the body", () => {
    // Same logical args, different key order → same digest (JCS sorts keys).
    expect(intentArgsDigest({ a: 1, b: 2, value: "s3cr3t" })).toBe(
      intentArgsDigest({ value: "s3cr3t", b: 2, a: 1 }),
    );
    // Different body → different digest → signature over the intent no longer matches.
    const agent = generateSigningKeyPair();
    const sig = signIntent(agent.priv, intent);
    const swapped: IntentClaims = { ...intent, argsDigest: intentArgsDigest({ value: "different" }) };
    expect(verifyIntent(agent.pub, swapped, sig)).toBe(false);
  });

  it("rejects op/path tamper", () => {
    const agent = generateSigningKeyPair();
    const sig = signIntent(agent.priv, intent);
    expect(verifyIntent(agent.pub, { ...intent, op: "kv.delete" }, sig)).toBe(false);
    expect(verifyIntent(agent.pub, { ...intent, path: "secret/data/other" }, sig)).toBe(false);
  });
});
