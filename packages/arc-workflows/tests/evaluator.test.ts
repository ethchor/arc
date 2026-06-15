import { describe, expect, it } from "vitest";
import { evaluate, parseAndValidate, type EvaluationContext } from "../src";

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    trigger: { kind: "request_access" },
    mountPath: "secret/dev/db",
    capability: "read",
    requesterRole: "admin",
    requesterGroups: [],
    mfaAgeSeconds: 30,
    now: new Date("2026-06-15T10:00:00Z"),
    ...over,
  };
}

describe("evaluate", () => {
  it("walks trigger -> auto_approve", () => {
    const { workflow } = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
      ],
      edges: [{ id: "e", from: "t", to: "ok" }],
    });
    const d = evaluate(workflow!, ctx());
    expect(d.terminal).toBe("auto_approve");
    expect(d.trace).toEqual(["t", "ok"]);
  });

  it("branches on role condition", () => {
    const def = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "c", kind: "condition", condition: { kind: "requester_role", anyOf: ["owner"] } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
        { id: "deny", kind: "action", action: { kind: "deny", reason: "not owner" } },
      ],
      edges: [
        { id: "e0", from: "t", to: "c" },
        { id: "e1", from: "c", to: "ok", branch: "true" },
        { id: "e2", from: "c", to: "deny", branch: "false" },
      ],
    }).workflow!;
    expect(evaluate(def, ctx({ requesterRole: "owner" })).terminal).toBe("auto_approve");
    expect(evaluate(def, ctx({ requesterRole: "admin" })).terminal).toBe("deny");
  });

  it("collects notify side-effects on the chosen path only", () => {
    const def = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "c", kind: "condition", condition: { kind: "requester_role", anyOf: ["owner"] } },
        { id: "n-yes", kind: "action", action: { kind: "notify", message: "owner path" } },
        { id: "n-no", kind: "action", action: { kind: "notify", message: "non-owner path" } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
        { id: "req", kind: "action", action: { kind: "require_approval" } },
      ],
      edges: [
        { id: "e0", from: "t", to: "c" },
        { id: "e1", from: "c", to: "n-yes", branch: "true" },
        { id: "e2", from: "n-yes", to: "ok" },
        { id: "e3", from: "c", to: "n-no", branch: "false" },
        { id: "e4", from: "n-no", to: "req" },
      ],
    }).workflow!;
    const ownerDecision = evaluate(def, ctx({ requesterRole: "owner" }));
    expect(ownerDecision.terminal).toBe("auto_approve");
    expect(ownerDecision.notifications).toEqual(["owner path"]);

    const guestDecision = evaluate(def, ctx({ requesterRole: "viewer" }));
    expect(guestDecision.terminal).toBe("require_approval");
    expect(guestDecision.notifications).toEqual(["non-owner path"]);
  });

  it("matches mount_path_matches with glob", () => {
    const def = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "c", kind: "condition", condition: { kind: "mount_path_matches", pattern: "secret/prod/*" } },
        { id: "req", kind: "action", action: { kind: "require_approval" } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
      ],
      edges: [
        { id: "e0", from: "t", to: "c" },
        { id: "e1", from: "c", to: "req", branch: "true" },
        { id: "e2", from: "c", to: "ok", branch: "false" },
      ],
    }).workflow!;
    expect(evaluate(def, ctx({ mountPath: "secret/prod/db" })).terminal).toBe("require_approval");
    expect(evaluate(def, ctx({ mountPath: "secret/dev/db" })).terminal).toBe("auto_approve");
    expect(evaluate(def, ctx({ mountPath: "secret/prod/db/sub" })).terminal).toBe("auto_approve");
  });

  it("checks requires_mfa_within", () => {
    const def = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "c", kind: "condition", condition: { kind: "requires_mfa_within", maxAgeSeconds: 300 } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
        { id: "req", kind: "action", action: { kind: "require_approval" } },
      ],
      edges: [
        { id: "e0", from: "t", to: "c" },
        { id: "e1", from: "c", to: "ok", branch: "true" },
        { id: "e2", from: "c", to: "req", branch: "false" },
      ],
    }).workflow!;
    expect(evaluate(def, ctx({ mfaAgeSeconds: 60 })).terminal).toBe("auto_approve");
    expect(evaluate(def, ctx({ mfaAgeSeconds: 3600 })).terminal).toBe("require_approval");
    expect(evaluate(def, ctx({ mfaAgeSeconds: null })).terminal).toBe("require_approval");
  });

  it("returns a deny when a condition branch is unwired", () => {
    const def = parseAndValidate({
      version: 1,
      nodes: [
        { id: "t", kind: "trigger", trigger: { kind: "request_access" } },
        { id: "c", kind: "condition", condition: { kind: "requester_role", anyOf: ["owner"] } },
        { id: "ok", kind: "action", action: { kind: "auto_approve" } },
      ],
      edges: [
        { id: "e0", from: "t", to: "c" },
        { id: "e1", from: "c", to: "ok", branch: "true" },
      ],
    }).workflow!;
    const decision = evaluate(def, ctx({ requesterRole: "viewer" }));
    expect(decision.terminal).toBe("deny");
    expect(decision.reason).toContain("false-branch");
  });
});
