import {
  TERMINAL_ACTIONS,
  type Action,
  type Condition,
  type EvaluationContext,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowIssue,
  type WorkflowNode,
} from "./types";

/**
 * Parse + validate a workflow definition. Pure: no side effects, no I/O. Returns the
 * narrowed `WorkflowDefinition` on success, or `null` with a populated issue list.
 *
 * Refuses, with errors:
 *  - unknown `version` or shape that doesn't carry an array of nodes + edges
 *  - more than one trigger, or zero triggers
 *  - any node kind / action / condition outside the fixed vocabulary
 *  - duplicate node ids or duplicate edge ids
 *  - dangling edges (referencing unknown node ids)
 *  - edges leaving an action node (actions are terminal in the topology)
 *  - branch labels on edges leaving a non-condition node
 *  - missing `true` / `false` branch on an edge leaving a condition node
 *  - cycles
 *  - any path from the trigger that does not terminate in a terminal action
 *
 * Returns warnings (not errors) for:
 *  - condition node with no outgoing `true` and no outgoing `false` edges (dead end)
 *  - unreachable nodes (graph node not reachable from the trigger)
 */
export function parseAndValidate(input: unknown): {
  workflow: WorkflowDefinition | null;
  result: ValidationResult;
} {
  const issues: WorkflowIssue[] = [];

  if (!isObject(input)) {
    issues.push({ level: "error", code: "shape", message: "definition is not an object" });
    return { workflow: null, result: { ok: false, issues } };
  }
  if ((input as Record<string, unknown>).version !== 1) {
    issues.push({
      level: "error",
      code: "version",
      message: `unsupported workflow version: ${(input as { version?: unknown }).version}`,
    });
    return { workflow: null, result: { ok: false, issues } };
  }

  const rec = input as Record<string, unknown>;
  const nodesIn = rec.nodes;
  const edgesIn = rec.edges;

  if (!Array.isArray(nodesIn)) {
    issues.push({ level: "error", code: "shape", message: "`nodes` must be an array" });
  }
  if (!Array.isArray(edgesIn)) {
    issues.push({ level: "error", code: "shape", message: "`edges` must be an array" });
  }
  if (issues.length > 0) return { workflow: null, result: { ok: false, issues } };

  const nodes: WorkflowNode[] = [];
  const nodeIds = new Set<string>();

  for (let i = 0; i < (nodesIn as unknown[]).length; i++) {
    const raw = (nodesIn as unknown[])[i];
    const parsed = parseNode(raw, i, issues);
    if (!parsed) continue;
    if (nodeIds.has(parsed.id)) {
      issues.push({
        level: "error",
        code: "duplicate_node_id",
        nodeId: parsed.id,
        message: `duplicate node id: ${parsed.id}`,
      });
      continue;
    }
    nodeIds.add(parsed.id);
    nodes.push(parsed);
  }

  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (let i = 0; i < (edgesIn as unknown[]).length; i++) {
    const raw = (edgesIn as unknown[])[i];
    const parsed = parseEdge(raw, i, issues);
    if (!parsed) continue;
    if (edgeIds.has(parsed.id)) {
      issues.push({
        level: "error",
        code: "duplicate_edge_id",
        edgeId: parsed.id,
        message: `duplicate edge id: ${parsed.id}`,
      });
      continue;
    }
    edgeIds.add(parsed.id);
    edges.push(parsed);
  }

  if (issues.some((i) => i.level === "error")) {
    return { workflow: null, result: { ok: false, issues } };
  }

  const triggers = nodes.filter((n) => n.kind === "trigger");
  if (triggers.length === 0) {
    issues.push({ level: "error", code: "no_trigger", message: "workflow has no trigger node" });
  } else if (triggers.length > 1) {
    issues.push({
      level: "error",
      code: "multiple_triggers",
      message: "workflow has more than one trigger node",
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    if (!byId.has(e.from)) {
      issues.push({
        level: "error",
        code: "dangling_edge_from",
        edgeId: e.id,
        message: `edge ${e.id} starts from unknown node ${e.from}`,
      });
      continue;
    }
    if (!byId.has(e.to)) {
      issues.push({
        level: "error",
        code: "dangling_edge_to",
        edgeId: e.id,
        message: `edge ${e.id} ends at unknown node ${e.to}`,
      });
      continue;
    }
    const fromNode = byId.get(e.from)!;
    if (fromNode.kind === "action" && isTerminalAction(fromNode.action)) {
      issues.push({
        level: "error",
        code: "edge_after_terminal",
        edgeId: e.id,
        nodeId: fromNode.id,
        message: `terminal action ${fromNode.id} cannot have outgoing edges`,
      });
      continue;
    }
    if (fromNode.kind === "condition") {
      if (e.branch !== "true" && e.branch !== "false") {
        issues.push({
          level: "error",
          code: "missing_branch",
          edgeId: e.id,
          nodeId: fromNode.id,
          message: `edge from condition ${fromNode.id} must specify branch: "true" | "false"`,
        });
        continue;
      }
    } else if (e.branch !== undefined) {
      issues.push({
        level: "error",
        code: "unexpected_branch",
        edgeId: e.id,
        nodeId: fromNode.id,
        message: `edge from non-condition node ${fromNode.id} must not specify a branch`,
      });
      continue;
    }
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  if (issues.some((i) => i.level === "error")) {
    return { workflow: null, result: { ok: false, issues } };
  }

  // Cycle + termination check via DFS from the trigger.
  if (triggers.length === 1) {
    const trigger = triggers[0]!;
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (id: string): void => {
      if (visiting.has(id)) {
        issues.push({
          level: "error",
          code: "cycle",
          nodeId: id,
          message: `cycle detected at node ${id}`,
        });
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);

      const node = byId.get(id)!;
      const next = outgoing.get(id) ?? [];

      if (node.kind === "action" && isTerminalAction(node.action)) {
        // Terminal — no outgoing checks needed.
      } else if (node.kind === "condition") {
        const hasTrue = next.some((e) => e.branch === "true");
        const hasFalse = next.some((e) => e.branch === "false");
        if (!hasTrue && !hasFalse) {
          issues.push({
            level: "warning",
            code: "condition_dead_end",
            nodeId: id,
            message: `condition node ${id} has no outgoing branches and will never resolve to a terminal action`,
          });
        }
      } else if (next.length === 0) {
        issues.push({
          level: "error",
          code: "path_no_terminal",
          nodeId: id,
          message: `node ${id} has no outgoing edges and is not a terminal action`,
        });
      }

      for (const e of next) dfs(e.to);

      visiting.delete(id);
      visited.add(id);
    };

    dfs(trigger.id);

    // Unreachable warnings (kept as warnings so users can save partial works-in-progress
    // while the executor still refuses to use them — the server caller fails the save
    // on any `error` level entry, but warnings round-trip fine).
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        issues.push({
          level: "warning",
          code: "unreachable",
          nodeId: n.id,
          message: `node ${n.id} is unreachable from the trigger`,
        });
      }
    }
  }

  const hasError = issues.some((i) => i.level === "error");
  if (hasError) {
    return { workflow: null, result: { ok: false, issues } };
  }
  const wf: WorkflowDefinition = {
    version: 1,
    ...(typeof rec.name === "string" ? { name: rec.name } : {}),
    nodes,
    edges,
  };
  return { workflow: wf, result: { ok: true, issues } };
}

/** Minimal runtime guard for an evaluation context. Avoids surprising the evaluator. */
export function validateContext(ctx: EvaluationContext): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (ctx.trigger.kind !== "request_access") {
    issues.push({
      level: "error",
      code: "unknown_trigger",
      message: `unknown trigger kind: ${String(ctx.trigger.kind)}`,
    });
  }
  if (typeof ctx.mountPath !== "string" || ctx.mountPath.length === 0) {
    issues.push({ level: "error", code: "shape", message: "context.mountPath is required" });
  }
  return issues;
}

// -- helpers ------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTerminalAction(a: Action): boolean {
  return TERMINAL_ACTIONS.has(a.kind as never);
}

function parseNode(raw: unknown, index: number, issues: WorkflowIssue[]): WorkflowNode | null {
  if (!isObject(raw)) {
    issues.push({ level: "error", code: "shape", message: `nodes[${index}] is not an object` });
    return null;
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    issues.push({ level: "error", code: "shape", message: `nodes[${index}].id must be a non-empty string` });
    return null;
  }
  switch (raw.kind) {
    case "trigger": {
      const t = (raw as { trigger?: unknown }).trigger;
      if (!isObject(t) || (t as { kind?: unknown }).kind !== "request_access") {
        issues.push({
          level: "error",
          code: "unknown_trigger",
          nodeId: raw.id,
          message: `trigger node ${raw.id} carries unknown trigger kind`,
        });
        return null;
      }
      return { id: raw.id, kind: "trigger", trigger: { kind: "request_access" } };
    }
    case "condition": {
      const c = (raw as { condition?: unknown }).condition;
      const parsed = parseCondition(c, raw.id, issues);
      if (!parsed) return null;
      return { id: raw.id, kind: "condition", condition: parsed };
    }
    case "action": {
      const a = (raw as { action?: unknown }).action;
      const parsed = parseAction(a, raw.id, issues);
      if (!parsed) return null;
      return { id: raw.id, kind: "action", action: parsed };
    }
    default:
      issues.push({
        level: "error",
        code: "unknown_node_kind",
        nodeId: raw.id,
        message: `node ${raw.id} has unknown kind: ${String(raw.kind)}`,
      });
      return null;
  }
}

function parseCondition(raw: unknown, nodeId: string, issues: WorkflowIssue[]): Condition | null {
  if (!isObject(raw)) {
    issues.push({ level: "error", code: "shape", nodeId, message: `condition on ${nodeId} is not an object` });
    return null;
  }
  switch (raw.kind) {
    case "requester_role": {
      const anyOf = raw.anyOf;
      if (!Array.isArray(anyOf) || !anyOf.every((r) => r === "owner" || r === "admin" || r === "editor" || r === "viewer")) {
        issues.push({ level: "error", code: "shape", nodeId, message: `requester_role on ${nodeId} requires anyOf: array of owner/admin/editor/viewer` });
        return null;
      }
      return { kind: "requester_role", anyOf: anyOf as ReadonlyArray<"owner" | "admin" | "editor" | "viewer"> };
    }
    case "requester_group": {
      if (!Array.isArray(raw.anyOf) || !raw.anyOf.every((g) => typeof g === "string")) {
        issues.push({ level: "error", code: "shape", nodeId, message: `requester_group on ${nodeId} requires anyOf: string[]` });
        return null;
      }
      return { kind: "requester_group", anyOf: raw.anyOf as readonly string[] };
    }
    case "mount_path_matches": {
      if (typeof raw.pattern !== "string" || raw.pattern.length === 0) {
        issues.push({ level: "error", code: "shape", nodeId, message: `mount_path_matches on ${nodeId} requires a non-empty pattern` });
        return null;
      }
      return {
        kind: "mount_path_matches",
        pattern: raw.pattern,
        ...(raw.not === true ? { not: true } : {}),
      };
    }
    case "time_window": {
      const startHour = (raw as { startHour?: unknown }).startHour;
      const endHour = (raw as { endHour?: unknown }).endHour;
      if (!isHour(startHour) || !isHour(endHour)) {
        issues.push({ level: "error", code: "shape", nodeId, message: `time_window on ${nodeId} needs startHour/endHour in 0..23` });
        return null;
      }
      const weekdays = (raw as { weekdays?: unknown }).weekdays;
      if (weekdays !== undefined) {
        if (!Array.isArray(weekdays) || !weekdays.every((w) => typeof w === "number" && w >= 1 && w <= 7)) {
          issues.push({ level: "error", code: "shape", nodeId, message: `time_window weekdays on ${nodeId} must be ISO weekday numbers 1..7` });
          return null;
        }
      }
      const timezone = (raw as { timezone?: unknown }).timezone;
      if (timezone !== undefined && typeof timezone !== "string") {
        issues.push({ level: "error", code: "shape", nodeId, message: `time_window timezone on ${nodeId} must be a string` });
        return null;
      }
      return {
        kind: "time_window",
        startHour,
        endHour,
        ...(weekdays !== undefined ? { weekdays: weekdays as readonly (1|2|3|4|5|6|7)[] } : {}),
        ...(typeof timezone === "string" ? { timezone } : {}),
      };
    }
    case "requires_mfa_within": {
      const m = (raw as { maxAgeSeconds?: unknown }).maxAgeSeconds;
      if (typeof m !== "number" || m <= 0 || !Number.isFinite(m)) {
        issues.push({ level: "error", code: "shape", nodeId, message: `requires_mfa_within on ${nodeId} needs maxAgeSeconds > 0` });
        return null;
      }
      return { kind: "requires_mfa_within", maxAgeSeconds: m };
    }
    default:
      issues.push({
        level: "error",
        code: "unknown_condition",
        nodeId,
        message: `condition kind not in vocabulary: ${String(raw.kind)}`,
      });
      return null;
  }
}

function parseAction(raw: unknown, nodeId: string, issues: WorkflowIssue[]): Action | null {
  if (!isObject(raw)) {
    issues.push({ level: "error", code: "shape", nodeId, message: `action on ${nodeId} is not an object` });
    return null;
  }
  switch (raw.kind) {
    case "auto_approve":
      return {
        kind: "auto_approve",
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      };
    case "require_approval": {
      const approverKind = (raw as { approverKind?: unknown }).approverKind;
      if (approverKind !== undefined && approverKind !== "owner") {
        issues.push({ level: "error", code: "shape", nodeId, message: `require_approval on ${nodeId} only supports approverKind: "owner" in Phase 1` });
        return null;
      }
      return { kind: "require_approval", ...(approverKind === "owner" ? { approverKind: "owner" as const } : {}) };
    }
    case "deny": {
      if (typeof raw.reason !== "string" || raw.reason.length === 0) {
        issues.push({ level: "error", code: "shape", nodeId, message: `deny on ${nodeId} requires a non-empty reason` });
        return null;
      }
      return { kind: "deny", reason: raw.reason };
    }
    case "notify": {
      if (typeof raw.message !== "string" || raw.message.length === 0) {
        issues.push({ level: "error", code: "shape", nodeId, message: `notify on ${nodeId} requires a non-empty message` });
        return null;
      }
      return { kind: "notify", message: raw.message };
    }
    default:
      issues.push({
        level: "error",
        code: "unknown_action",
        nodeId,
        message: `action kind not in vocabulary: ${String(raw.kind)}`,
      });
      return null;
  }
}

function parseEdge(raw: unknown, index: number, issues: WorkflowIssue[]): WorkflowEdge | null {
  if (!isObject(raw)) {
    issues.push({ level: "error", code: "shape", message: `edges[${index}] is not an object` });
    return null;
  }
  if (typeof raw.id !== "string" || typeof raw.from !== "string" || typeof raw.to !== "string") {
    issues.push({ level: "error", code: "shape", message: `edges[${index}] requires string id/from/to` });
    return null;
  }
  if (raw.branch !== undefined && raw.branch !== "true" && raw.branch !== "false") {
    issues.push({ level: "error", code: "shape", edgeId: raw.id, message: `edge ${raw.id} branch must be "true" | "false" when present` });
    return null;
  }
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    ...(raw.branch === "true" || raw.branch === "false" ? { branch: raw.branch } : {}),
  };
}

function isHour(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
}
