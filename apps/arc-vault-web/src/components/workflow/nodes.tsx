"use client";

import type { ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  Bell,
  Check,
  Clock,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  Action,
  Condition,
  Trigger,
  WorkflowIssue,
} from "./types";

/** Per-node data carried inside React Flow. Selection drives the inspector. */
export interface WfNodeData {
  /** Full kind discriminator: trigger / condition / action. */
  kind: "trigger" | "condition" | "action";
  /** The payload — narrow by `kind`. */
  payload: Trigger | Condition | Action;
  /** Validation issues local to this node, surfaced as a red dot. */
  issues?: readonly WorkflowIssue[];
  /** Highlight this node when present (executor trace). */
  active?: boolean;
}

const TONE: Record<
  WfNodeData["kind"],
  { ring: string; bg: string; icon: ReactNode; label: string }
> = {
  trigger: {
    ring: "border-amber-500/50 hover:border-amber-500/70",
    bg: "bg-amber-500/[0.04]",
    icon: <Zap className="h-4 w-4 text-amber-500" />,
    label: "Trigger",
  },
  condition: {
    ring: "border-sky-500/50 hover:border-sky-500/70",
    bg: "bg-sky-500/[0.04]",
    icon: <Workflow className="h-4 w-4 text-sky-500" />,
    label: "Condition",
  },
  action: {
    ring: "border-primary/50 hover:border-primary/70",
    bg: "bg-primary/[0.04]",
    icon: <ShieldCheck className="h-4 w-4 text-primary" />,
    label: "Action",
  },
};

function payloadSummary(d: WfNodeData): { title: string; subtitle?: string } {
  if (d.kind === "trigger") return { title: "Access request" };
  if (d.kind === "condition") {
    const c = d.payload as Condition;
    switch (c.kind) {
      case "requester_role":
        return { title: "Role is", subtitle: c.anyOf.join(" or ") };
      case "requester_group":
        return { title: "Group is", subtitle: c.anyOf.length > 0 ? c.anyOf.join(" or ") : "(none)" };
      case "mount_path_matches":
        return { title: c.not ? "Path does not match" : "Path matches", subtitle: c.pattern };
      case "time_window":
        return { title: "Time window", subtitle: `${pad(c.startHour)}:00 to ${pad(c.endHour)}:00 ${c.timezone ?? "UTC"}` };
      case "requires_mfa_within":
        return { title: "Recent MFA", subtitle: `< ${c.maxAgeSeconds}s` };
    }
  }
  const a = d.payload as Action;
  switch (a.kind) {
    case "auto_approve":
      return { title: "Auto approve", subtitle: a.reason };
    case "require_approval":
      return { title: "Require approval", subtitle: "Owner via passkey" };
    case "deny":
      return { title: "Deny", subtitle: a.reason };
    case "notify":
      return { title: "Notify", subtitle: a.message };
  }
}

function ActionIcon({ payload }: { payload: Action }) {
  switch (payload.kind) {
    case "auto_approve":
      return <Check className="h-4 w-4 text-emerald-500" />;
    case "require_approval":
      return <KeyRound className="h-4 w-4 text-violet-500" />;
    case "deny":
      return <X className="h-4 w-4 text-rose-500" />;
    case "notify":
      return <Bell className="h-4 w-4 text-amber-500" />;
  }
}

function ConditionIcon({ payload }: { payload: Condition }) {
  switch (payload.kind) {
    case "requester_role":
    case "requester_group":
      return <Users className="h-4 w-4 text-sky-500" />;
    case "mount_path_matches":
      return <Workflow className="h-4 w-4 text-sky-500" />;
    case "time_window":
      return <Clock className="h-4 w-4 text-sky-500" />;
    case "requires_mfa_within":
      return <ShieldCheck className="h-4 w-4 text-sky-500" />;
  }
}

function WfNodeChrome({ data, selected }: NodeProps<WfNodeData>) {
  const tone = TONE[data.kind];
  const summary = payloadSummary(data);
  const hasErrors = (data.issues ?? []).some((i) => i.level === "error");
  return (
    <div
      className={cn(
        "relative w-[220px] rounded-md border bg-card text-card-foreground shadow-[var(--shadow-sm)] transition-[transform,box-shadow,border-color] [transition-duration:var(--dur-fast)] ease-out-quart",
        tone.ring,
        tone.bg,
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        data.active && "border-emerald-500/70 shadow-[0_0_0_2px_rgb(16_185_129_/_0.25)]",
      )}
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {data.kind === "action"
            ? <ActionIcon payload={data.payload as Action} />
            : data.kind === "condition"
              ? <ConditionIcon payload={data.payload as Condition} />
              : tone.icon}
          {tone.label}
        </span>
        {hasErrors && (
          <span className="relative inline-flex h-2 w-2" title="This node has validation errors">
            <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/60" />
            <span className="relative h-2 w-2 rounded-full bg-rose-500" />
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-semibold leading-tight">{summary.title}</div>
        {summary.subtitle ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={summary.subtitle}>
            {summary.subtitle}
          </div>
        ) : null}
      </div>
      {data.kind !== "trigger" ? (
        <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground/50" />
      ) : null}
      {data.kind === "action" && isTerminalAction(data.payload as Action) ? null : data.kind === "condition" ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: 56 }}
            className="!h-2.5 !w-2.5 !border-2 !border-background !bg-emerald-500"
            title="true branch"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: 164 }}
            className="!h-2.5 !w-2.5 !border-2 !border-background !bg-rose-500"
            title="false branch"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground/50"
        />
      )}
      {data.kind === "condition" ? (
        <div className="pointer-events-none absolute -bottom-5 left-0 right-0 flex justify-between px-3 text-[10px] font-medium">
          <span className="text-emerald-500">true</span>
          <span className="text-rose-500">false</span>
        </div>
      ) : null}
    </div>
  );
}

export function TriggerNode(props: NodeProps<WfNodeData>) {
  return <WfNodeChrome {...props} />;
}
export function ConditionNode(props: NodeProps<WfNodeData>) {
  return <WfNodeChrome {...props} />;
}
export function ActionNode(props: NodeProps<WfNodeData>) {
  return <WfNodeChrome {...props} />;
}

function isTerminalAction(a: Action): boolean {
  return a.kind === "auto_approve" || a.kind === "require_approval" || a.kind === "deny";
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Sentinel marker for `ShieldAlert` import used only when issues panel is rendered elsewhere. */
export const _placeholders = { ShieldAlert };
