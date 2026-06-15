/**
 * UI-local view types for the workflow editor.
 *
 * Internally the editor stores React Flow nodes + edges; on save we project them into
 * the canonical `WorkflowDefinition` shape (`@arc/workflows`). This module re-exports
 * the workflow vocabulary so consumers stay decoupled from the backend package's
 * import path.
 */
export type {
  Action,
  ActionKind,
  ActionNode,
  AutoApproveAction,
  Condition,
  ConditionKind,
  ConditionNode,
  DenyAction,
  EvaluationContext,
  EvaluationDecision,
  MountPathMatchesCondition,
  NodeKind,
  NotifyAction,
  RequesterGroupCondition,
  RequesterRoleCondition,
  RequiresMfaWithinCondition,
  RequireApprovalAction,
  TerminalActionKind,
  TimeWindowCondition,
  Trigger,
  TriggerKind,
  TriggerNode,
  ValidationResult,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowIssue,
  WorkflowIssueLevel,
  WorkflowNode,
} from "@arc/workflows";

/** Palette entry. Keeps the registry of available kinds + their pretty labels in one place. */
export interface PaletteEntry {
  kind: "trigger" | "condition" | "action";
  /** Internal kind discriminator that fills the new node's `.<kind>.kind`. */
  subKind: string;
  label: string;
  description: string;
}

export const TRIGGER_PALETTE: readonly PaletteEntry[] = [
  {
    kind: "trigger",
    subKind: "request_access",
    label: "Access request",
    description: "Fires when an agent submits an elevated access intent.",
  },
];

export const CONDITION_PALETTE: readonly PaletteEntry[] = [
  {
    kind: "condition",
    subKind: "requester_role",
    label: "Role is",
    description: "Branch on the requester's role in the vault.",
  },
  {
    kind: "condition",
    subKind: "requester_group",
    label: "Group is",
    description: "Branch on whether the requester belongs to a group.",
  },
  {
    kind: "condition",
    subKind: "mount_path_matches",
    label: "Path matches",
    description: "Branch on a glob match against the mount path.",
  },
  {
    kind: "condition",
    subKind: "time_window",
    label: "Time window",
    description: "Branch on whether the current time falls inside a window.",
  },
  {
    kind: "condition",
    subKind: "requires_mfa_within",
    label: "Recent MFA",
    description: "Branch on whether the requester recently passed MFA.",
  },
];

export const ACTION_PALETTE: readonly PaletteEntry[] = [
  {
    kind: "action",
    subKind: "auto_approve",
    label: "Auto approve",
    description: "Allow the intent without an out-of-band push.",
  },
  {
    kind: "action",
    subKind: "require_approval",
    label: "Require approval",
    description: "Send a push to the agent's owner; wait for WebAuthn consent.",
  },
  {
    kind: "action",
    subKind: "deny",
    label: "Deny",
    description: "Refuse the intent and surface a reason.",
  },
  {
    kind: "action",
    subKind: "notify",
    label: "Notify",
    description: "Write an audit-log entry while continuing to a terminal action.",
  },
];

export const NODE_KIND_LABEL: Record<"trigger" | "condition" | "action", string> = {
  trigger: "Trigger",
  condition: "Condition",
  action: "Action",
};
