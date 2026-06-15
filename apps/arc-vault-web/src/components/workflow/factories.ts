import type { Action, Condition, Trigger } from "./types";

/**
 * Construct a fresh payload for a newly-dragged palette entry. Defaults are chosen so
 * the validator passes immediately and the inspector renders a sensible form.
 */
export function defaultTriggerPayload(subKind: string): Trigger {
  if (subKind === "request_access") return { kind: "request_access" };
  throw new Error(`unknown trigger subKind: ${subKind}`);
}

export function defaultConditionPayload(subKind: string): Condition {
  switch (subKind) {
    case "requester_role":
      return { kind: "requester_role", anyOf: ["admin"] };
    case "requester_group":
      return { kind: "requester_group", anyOf: [] };
    case "mount_path_matches":
      return { kind: "mount_path_matches", pattern: "secret/prod/*" };
    case "time_window":
      return { kind: "time_window", startHour: 9, endHour: 18, timezone: "UTC" };
    case "requires_mfa_within":
      return { kind: "requires_mfa_within", maxAgeSeconds: 300 };
    default:
      throw new Error(`unknown condition subKind: ${subKind}`);
  }
}

export function defaultActionPayload(subKind: string): Action {
  switch (subKind) {
    case "auto_approve":
      return { kind: "auto_approve" };
    case "require_approval":
      return { kind: "require_approval" };
    case "deny":
      return { kind: "deny", reason: "denied by workflow" };
    case "notify":
      return { kind: "notify", message: "review requested" };
    default:
      throw new Error(`unknown action subKind: ${subKind}`);
  }
}
