import {
  TERMINAL_ACTIONS,
  type Condition,
  type EvaluationContext,
  type EvaluationDecision,
  type TerminalActionKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types";

/**
 * Pure evaluator. Walks the validated DAG from its trigger, evaluating conditions and
 * collecting `notify` side-effects along the way, until it hits exactly one terminal
 * action (`auto_approve`, `require_approval`, or `deny`).
 *
 * Determinism: at every step the evaluator follows the lowest-id edge first, so the
 * trace is reproducible. Validation has already guaranteed the structural properties
 * (one trigger, no cycles, every path terminates), so this can be a straight walk
 * with no graph-search heuristics.
 *
 * Important: this MUST be called on a workflow already returned successfully from
 * `parseAndValidate`. Passing a structurally broken workflow may throw.
 */
export function evaluate(def: WorkflowDefinition, ctx: EvaluationContext): EvaluationDecision {
  const byId = new Map<string, WorkflowNode>(def.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const e of def.edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }
  // Deterministic edge order — lowest id first; ensures traces are stable across runs.
  for (const list of outgoing.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const trigger = def.nodes.find((n) => n.kind === "trigger");
  if (!trigger) {
    return {
      terminal: "deny",
      reason: "workflow has no trigger",
      notifications: [],
      trace: [],
    };
  }

  const notifications: string[] = [];
  const trace: string[] = [];
  let cursor: string | null = trigger.id;
  // Hard cap. Validation prevents cycles, but defence-in-depth lets the evaluator never
  // accidentally loop on a malformed payload that someone wrote to the DB by hand.
  let steps = 0;

  while (cursor !== null) {
    if (steps++ > def.nodes.length + 4) {
      return {
        terminal: "deny",
        reason: "workflow exceeded traversal cap; likely malformed",
        notifications,
        trace,
      };
    }
    trace.push(cursor);
    const node = byId.get(cursor)!;

    if (node.kind === "action") {
      if (node.action.kind === "notify") {
        notifications.push(node.action.message);
        cursor = followFirst(outgoing.get(node.id));
        continue;
      }
      // Terminal action — we're done.
      const terminal = node.action.kind as TerminalActionKind;
      const reason = reasonFor(node.action, terminal);
      return { terminal, reason, notifications, trace };
    }

    if (node.kind === "trigger") {
      cursor = followFirst(outgoing.get(node.id));
      continue;
    }

    // Condition node: evaluate, then follow the matching branch.
    const passed = evaluateCondition(node.condition, ctx);
    const branch = passed ? "true" : "false";
    const edges = (outgoing.get(node.id) ?? []).filter((e) => e.branch === branch);
    cursor = edges[0]?.to ?? null;
    // No edge for this branch -> implicit deny. The validator marks this as a warning
    // (condition_dead_end); the runtime needs to do *something* sensible.
    if (cursor === null) {
      return {
        terminal: "deny",
        reason: `condition ${node.id} has no ${branch}-branch wired`,
        notifications,
        trace,
      };
    }
  }

  return {
    terminal: "deny",
    reason: "workflow reached an open path with no terminal action",
    notifications,
    trace,
  };
}

function followFirst(edges: WorkflowEdge[] | undefined): string | null {
  return edges && edges.length > 0 ? edges[0]!.to : null;
}

function reasonFor(
  action: { kind: TerminalActionKind | "notify"; reason?: string; message?: string },
  terminal: TerminalActionKind,
): string {
  if (terminal === "deny") return action.reason ?? "denied by workflow";
  if (terminal === "auto_approve") return action.reason ?? "auto-approved by workflow";
  return "approval required by workflow";
}

function evaluateCondition(c: Condition, ctx: EvaluationContext): boolean {
  switch (c.kind) {
    case "requester_role":
      return ctx.requesterRole !== null && c.anyOf.includes(ctx.requesterRole);

    case "requester_group":
      if (c.anyOf.length === 0) return false;
      return c.anyOf.some((g) => ctx.requesterGroups.includes(g));

    case "mount_path_matches": {
      const matches = globMatch(c.pattern, ctx.mountPath);
      return c.not ? !matches : matches;
    }

    case "time_window": {
      const { hour, weekday } = nowInTimezone(ctx.now, c.timezone ?? "UTC");
      if (c.weekdays && !c.weekdays.includes(weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7)) return false;
      if (c.startHour <= c.endHour) {
        return hour >= c.startHour && hour <= c.endHour;
      }
      // Wraps midnight: e.g. 22 -> 4
      return hour >= c.startHour || hour <= c.endHour;
    }

    case "requires_mfa_within":
      return ctx.mfaAgeSeconds !== null && ctx.mfaAgeSeconds <= c.maxAgeSeconds;
  }
}

/**
 * Simple glob: `*` matches a single path segment, `**` matches one or more segments.
 * Adequate for mount-path matching (`secret/prod/*`, `transit/**`). No anchors,
 * no character classes — kept narrow on purpose so the regex it compiles to is safe.
 */
function globMatch(pattern: string, value: string): boolean {
  // Escape regex metas other than `*`.
  const reSrc = pattern
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".+";
      if (part === "*") return "[^/]+";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${reSrc}$`).test(value);
}

/**
 * Compute hour + ISO-weekday in a target timezone. Uses Intl when available; falls back
 * to UTC if the runtime doesn't support the requested timezone (shouldn't happen on
 * modern Node, but keeps the evaluator robust).
 */
function nowInTimezone(now: Date, timezone: string): { hour: number; weekday: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayName) + 1;
    return { hour: hour === 24 ? 0 : hour, weekday: weekday > 0 ? weekday : 1 };
  } catch {
    return { hour: now.getUTCHours(), weekday: ((now.getUTCDay() + 6) % 7) + 1 };
  }
}

export const _internal = { globMatch };
