/**
 * Workflow types — fixed vocabulary for a constrained DAG.
 *
 * Adding any new node kind or terminal action here is the only way to widen what
 * workflows can express. That is the security claim: a workflow defined entirely
 * in this vocabulary, validated by `validateDag`, can only do things the codebase
 * already knows how to audit.
 */

// -- Trigger ------------------------------------------------------------------

/** Phase 1 has exactly one trigger kind: an elevated access intent from an agent. */
export type TriggerKind = "request_access";

export interface RequestAccessTrigger {
  kind: "request_access";
}

export type Trigger = RequestAccessTrigger;

// -- Conditions ---------------------------------------------------------------

export type ConditionKind =
  | "requester_role"
  | "requester_group"
  | "mount_path_matches"
  | "time_window"
  | "requires_mfa_within";

export interface RequesterRoleCondition {
  kind: "requester_role";
  /** Allowed roles. The condition passes if the requester's vault role is in this set. */
  anyOf: ReadonlyArray<"owner" | "admin" | "editor" | "viewer">;
}

export interface RequesterGroupCondition {
  kind: "requester_group";
  /** The condition passes if the requester belongs to any of these arc-grants groups. */
  anyOf: ReadonlyArray<string>;
}

export interface MountPathMatchesCondition {
  kind: "mount_path_matches";
  /** Glob. `secret/prod/*` matches `secret/prod/db`; `*` matches any single segment. */
  pattern: string;
  /** Inverts the match. Default false. */
  not?: boolean;
}

export interface TimeWindowCondition {
  kind: "time_window";
  /** 24-hour clock; both inclusive. Wraps midnight when `endHour < startHour`. */
  startHour: number;
  endHour: number;
  /** ISO weekday numbers (1 = Monday ... 7 = Sunday). When omitted, all days match. */
  weekdays?: ReadonlyArray<1 | 2 | 3 | 4 | 5 | 6 | 7>;
  /** IANA tz name (e.g. `Asia/Kolkata`). Defaults to UTC for portability. */
  timezone?: string;
}

export interface RequiresMfaWithinCondition {
  kind: "requires_mfa_within";
  /** Maximum seconds since the requester last passed an MFA assertion. */
  maxAgeSeconds: number;
}

export type Condition =
  | RequesterRoleCondition
  | RequesterGroupCondition
  | MountPathMatchesCondition
  | TimeWindowCondition
  | RequiresMfaWithinCondition;

// -- Actions ------------------------------------------------------------------

/**
 * Phase 1 actions. Two are *terminal* (`auto_approve`, `require_approval`, `deny`) — every path
 * through the DAG must end in one. `notify` is a *side effect* that runs alongside the
 * terminal hit but does not change the decision.
 */
export type ActionKind =
  | "auto_approve"
  | "require_approval"
  | "deny"
  | "notify";

export type TerminalActionKind = "auto_approve" | "require_approval" | "deny";

export const TERMINAL_ACTIONS: ReadonlySet<TerminalActionKind> = new Set([
  "auto_approve",
  "require_approval",
  "deny",
]);

export interface AutoApproveAction {
  kind: "auto_approve";
  /** Optional plain-text reason audit-logged with the auto-approval. */
  reason?: string;
}

export interface RequireApprovalAction {
  kind: "require_approval";
  /**
   * Approver routing. Phase 1 only supports `owner` (the agent's owning user).
   * Reserving the field shape so Phase 2 can add `group` / `userIds` without a migration.
   */
  approverKind?: "owner";
}

export interface DenyAction {
  kind: "deny";
  /** Plain-text reason returned to the caller + audit-logged. Required to keep denials greppable. */
  reason: string;
}

export interface NotifyAction {
  kind: "notify";
  /** Free-text message stored in the audit log. */
  message: string;
}

export type Action = AutoApproveAction | RequireApprovalAction | DenyAction | NotifyAction;

// -- Graph --------------------------------------------------------------------

export type NodeKind = "trigger" | "condition" | "action";

export interface TriggerNode {
  id: string;
  kind: "trigger";
  trigger: Trigger;
}

export interface ConditionNode {
  id: string;
  kind: "condition";
  condition: Condition;
}

export interface ActionNode {
  id: string;
  kind: "action";
  action: Action;
}

export type WorkflowNode = TriggerNode | ConditionNode | ActionNode;

/**
 * Directed edge. Condition nodes are evaluated, and the branch taken depends on `branch`:
 *  - `true`  — followed when the condition holds
 *  - `false` — followed when it does not
 *  - undefined — only valid leaving a trigger node or feeding into another condition / action
 *
 * The same edge structure works for action-following-action (sequential side-effects) so the
 * frontend doesn't have to invent a different edge type per source kind.
 */
export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  branch?: "true" | "false";
}

export interface WorkflowDefinition {
  /** Bumped when the canonical shape itself changes. Validator refuses unknown versions. */
  version: 1;
  /** Optional human-readable display name. Stored on the row separately too; kept in the JSON for self-describing exports. */
  name?: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}

// -- Validation result --------------------------------------------------------

export type WorkflowIssueLevel = "error" | "warning";

export interface WorkflowIssue {
  level: WorkflowIssueLevel;
  /** Machine-stable identifier so the UI can map issues to inspector hints. */
  code: string;
  message: string;
  /** Node id when the issue is local to one node, otherwise omitted. */
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: readonly WorkflowIssue[];
}

// -- Evaluation context + decision -------------------------------------------

/**
 * Read-only inputs the evaluator needs. The caller fills these from concrete services
 * (vault membership, grants groups, MFA timestamps) so the evaluator stays pure and
 * trivially unit-testable.
 */
export interface EvaluationContext {
  trigger: { kind: TriggerKind };
  /** Mount path that the request targets (e.g. `secret/prod/db`). */
  mountPath: string;
  /** Capability requested. Carried through audit but not currently consulted by the vocabulary. */
  capability: string;
  /** Requester role in the vault, or `null` when the requester is not a member. */
  requesterRole: "owner" | "admin" | "editor" | "viewer" | null;
  /** Group memberships of the requester, via arc-grants. */
  requesterGroups: readonly string[];
  /** Seconds since the requester last passed an MFA assertion, or null when never. */
  mfaAgeSeconds: number | null;
  /** Current time. Injected so tests pin the clock. */
  now: Date;
}

export interface EvaluationDecision {
  /** Terminal decision the workflow reached. */
  terminal: TerminalActionKind;
  /** Plain-text reason. Always set so audits never read "no reason given". */
  reason: string;
  /** Notify side-effects collected along the path. */
  notifications: readonly string[];
  /** Path of node ids traversed, in order. Useful for an audit/explain UI. */
  trace: readonly string[];
}
