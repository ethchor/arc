import { describe, expect, it } from "vitest";
import { parseAndValidate, type WorkflowDefinition } from "../src";

const trigger = { id: "t1", kind: "trigger" as const, trigger: { kind: "request_access" as const } };
const denyAction = {
  id: "deny",
  kind: "action" as const,
  action: { kind: "deny" as const, reason: "no" },
};
const autoApproveAction = {
  id: "ok",
  kind: "action" as const,
  action: { kind: "auto_approve" as const },
};
const roleCondition = {
  id: "is-admin",
  kind: "condition" as const,
  condition: { kind: "requester_role" as const, anyOf: ["owner", "admin"] as const },
};

describe("parseAndValidate", () => {
  it("accepts the minimal trigger -> action workflow", () => {
    const def = {
      version: 1,
      nodes: [trigger, autoApproveAction],
      edges: [{ id: "e1", from: "t1", to: "ok" }],
    };
    const { workflow, result } = parseAndValidate(def);
    expect(result.ok).toBe(true);
    expect(workflow).not.toBeNull();
  });

  it("rejects unknown version", () => {
    const { result } = parseAndValidate({ version: 99, nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("version");
  });

  it("rejects missing trigger", () => {
    const { result } = parseAndValidate({ version: 1, nodes: [autoApproveAction], edges: [] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "no_trigger")).toBe(true);
  });

  it("rejects multiple triggers", () => {
    const t2 = { ...trigger, id: "t2" };
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, t2, autoApproveAction],
      edges: [{ id: "e1", from: "t1", to: "ok" }, { id: "e2", from: "t2", to: "ok" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "multiple_triggers")).toBe(true);
  });

  it("rejects an unknown action kind", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [
        trigger,
        { id: "bad", kind: "action", action: { kind: "nuke_from_orbit" } },
      ],
      edges: [{ id: "e1", from: "t1", to: "bad" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "unknown_action")).toBe(true);
  });

  it("rejects edges from a terminal action", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, denyAction, autoApproveAction],
      edges: [
        { id: "e1", from: "t1", to: "deny" },
        { id: "e2", from: "deny", to: "ok" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "edge_after_terminal")).toBe(true);
  });

  it("rejects condition edges without branches", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, roleCondition, autoApproveAction],
      edges: [
        { id: "e1", from: "t1", to: "is-admin" },
        { id: "e2", from: "is-admin", to: "ok" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing_branch")).toBe(true);
  });

  it("rejects branches on non-condition edges", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, autoApproveAction],
      edges: [{ id: "e1", from: "t1", to: "ok", branch: "true" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "unexpected_branch")).toBe(true);
  });

  it("rejects cycles", () => {
    const cond2 = { ...roleCondition, id: "is-admin-2" };
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, roleCondition, cond2, autoApproveAction],
      edges: [
        { id: "e0", from: "t1", to: "is-admin" },
        { id: "e1", from: "is-admin", to: "is-admin-2", branch: "true" },
        { id: "e2", from: "is-admin-2", to: "is-admin", branch: "true" },
        { id: "e3", from: "is-admin", to: "ok", branch: "false" },
        { id: "e4", from: "is-admin-2", to: "ok", branch: "false" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "cycle")).toBe(true);
  });

  it("rejects paths that do not terminate", () => {
    // Condition with only a true-branch wired and the false-side empty *is* allowed
    // but warns; a non-condition node with no outgoing edges errors.
    const { result } = parseAndValidate({
      version: 1,
      nodes: [trigger, autoApproveAction, { id: "stray", kind: "action", action: { kind: "notify", message: "hi" } }],
      edges: [
        { id: "e1", from: "t1", to: "stray" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "path_no_terminal")).toBe(true);
  });

  it("flags unreachable nodes as warnings, not errors", () => {
    const { result, workflow } = parseAndValidate({
      version: 1,
      nodes: [trigger, autoApproveAction, denyAction],
      edges: [{ id: "e1", from: "t1", to: "ok" }],
    });
    expect(result.ok).toBe(true);
    expect(workflow).not.toBeNull();
    expect(result.issues.some((i) => i.code === "unreachable" && i.level === "warning")).toBe(true);
  });

  it("accepts a full condition-with-both-branches workflow", () => {
    const def = {
      version: 1,
      nodes: [trigger, roleCondition, autoApproveAction, denyAction],
      edges: [
        { id: "e0", from: "t1", to: "is-admin" },
        { id: "e1", from: "is-admin", to: "ok", branch: "true" },
        { id: "e2", from: "is-admin", to: "deny", branch: "false" },
      ],
    };
    const { workflow, result } = parseAndValidate(def);
    expect(result.ok).toBe(true);
    expect(workflow?.nodes).toHaveLength(4);
    expect(workflow?.edges).toHaveLength(3);
  });

  it("rejects require_approval with approverKind other than owner", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [
        trigger,
        { id: "req", kind: "action", action: { kind: "require_approval", approverKind: "group" } },
      ],
      edges: [{ id: "e1", from: "t1", to: "req" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects time_window with invalid hour ranges", () => {
    const { result } = parseAndValidate({
      version: 1,
      nodes: [
        trigger,
        { id: "tw", kind: "condition", condition: { kind: "time_window", startHour: 25, endHour: 1 } },
        autoApproveAction,
      ],
      edges: [{ id: "e1", from: "t1", to: "tw" }, { id: "e2", from: "tw", to: "ok", branch: "true" }],
    });
    expect(result.ok).toBe(false);
  });
});
