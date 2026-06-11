import { createHash } from "node:crypto";
import { approvalChallengeForIntent } from "./approvals.service";

/**
 * MED-F regression (supply-chain audit). The CIBA / push-consent WebAuthn challenge used
 * to be server-random and persisted on the approval row, then read back at `approve` time.
 * A server (or an admin with DB access) that swapped `a.challenge` to the bytes for a
 * *different* pending intent could redirect a freshly-signed user assertion to authorise
 * the substituted intent — the authenticator's signature only proves "the user signed
 * these bytes," not "the user agreed to *this* intent."
 *
 * The new contract derives the challenge **deterministically from the intent digest**:
 *
 *   challenge = base64url(SHA-256("arc-approval/v1\n" || intentDigest))
 *
 * The expected challenge is recomputed at `approve` time from the persisted
 * `intentDigest`, so a tampered `a.challenge` column doesn't change which intent the
 * assertion ultimately authorises. The function is pure + total + non-allocating, so the
 * cheap structural pin below is enough to guarantee the wire shape stays.
 */
describe("approvalChallengeForIntent — MED-F binding", () => {
  it("is deterministic: same intent digest → same challenge", () => {
    const d = "a".repeat(64);
    expect(approvalChallengeForIntent(d)).toBe(approvalChallengeForIntent(d));
  });

  it("differs across intent digests (no collision in the trivial case)", () => {
    expect(approvalChallengeForIntent("aa")).not.toBe(approvalChallengeForIntent("ab"));
  });

  it("uses the documented arc-approval/v1 domain separation prefix", () => {
    const d = "deadbeef".repeat(8);
    const expected = createHash("sha256").update(`arc-approval/v1\n${d}`, "utf8").digest("base64url");
    expect(approvalChallengeForIntent(d)).toBe(expected);
  });

  it("base64url-encoded (no '+', '/', or '=' that WebAuthn challenges reject)", () => {
    const out = approvalChallengeForIntent("any-digest-string");
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("pinned KAT: stable across refactors so a regression doesn't silently rotate challenges", () => {
    // Known-answer for "" — the prefix is the only material the hasher sees, so the
    // value is a hard invariant: any change to the prefix or hash function trips this.
    const expectedForEmpty = createHash("sha256")
      .update("arc-approval/v1\n", "utf8")
      .digest("base64url");
    expect(approvalChallengeForIntent("")).toBe(expectedForEmpty);
  });
});
