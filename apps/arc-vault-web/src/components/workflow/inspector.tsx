"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  Action,
  Condition,
  WorkflowIssue,
} from "./types";
import type { WfNodeData } from "./nodes";

interface Props {
  selectedId: string | null;
  nodeData: WfNodeData | null;
  issues: readonly WorkflowIssue[];
  onChange: (id: string, patch: Partial<WfNodeData>) => void;
  onDelete: (id: string) => void;
}

/**
 * Right-side inspector for the currently-selected node. Forms are typed against the
 * concrete vocabulary so users never type a string into a numeric field by accident
 * (the validator would catch it on save but the UI level catches it earlier).
 */
export function WorkflowInspector({ selectedId, nodeData, issues, onChange, onDelete }: Props) {
  if (!selectedId || !nodeData) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Nothing selected</p>
        <p>Click a node on the canvas to edit it.</p>
      </div>
    );
  }

  const localIssues = issues.filter((i) => i.nodeId === selectedId);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {nodeData.kind} node
          </p>
          <h3 className="text-base font-semibold leading-tight">{nodeKindTitle(nodeData)}</h3>
        </div>
        {nodeData.kind !== "trigger" ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            onClick={() => onDelete(selectedId)}
            aria-label="Delete node"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {localIssues.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-rose-500/30 bg-rose-500/[0.04] p-2.5 text-xs text-rose-600 dark:text-rose-400">
          {localIssues.map((i, idx) => (
            <li key={`${i.code}-${idx}`}>
              <span className="font-medium">{i.code}</span> · {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      {nodeData.kind === "condition" ? (
        <ConditionForm
          payload={nodeData.payload as Condition}
          onChange={(payload) => onChange(selectedId, { payload })}
        />
      ) : null}
      {nodeData.kind === "action" ? (
        <ActionForm
          payload={nodeData.payload as Action}
          onChange={(payload) => onChange(selectedId, { payload })}
        />
      ) : null}
      {nodeData.kind === "trigger" ? (
        <p className="text-xs text-muted-foreground">
          The trigger fires when an agent submits an elevated access intent. No configuration in Phase 1.
        </p>
      ) : null}
    </div>
  );
}

function nodeKindTitle(d: WfNodeData): string {
  if (d.kind === "trigger") return "Access request";
  const payload = d.payload as { kind: string };
  return payload.kind.replaceAll("_", " ");
}

function ConditionForm({
  payload,
  onChange,
}: {
  payload: Condition;
  onChange: (payload: Condition) => void;
}) {
  const set = (next: Partial<Condition>) => onChange({ ...payload, ...next } as Condition);

  switch (payload.kind) {
    case "requester_role":
      return (
        <Field label="Roles allowed" hint="Branch true when the requester has one of these roles.">
          <RoleMultiSelect
            value={payload.anyOf}
            onChange={(anyOf) => set({ anyOf })}
          />
        </Field>
      );
    case "requester_group":
      return (
        <Field label="Groups" hint="Comma-separated list of arc-grants group names.">
          <Input
            value={payload.anyOf.join(", ")}
            onChange={(e) =>
              set({
                anyOf: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
          />
        </Field>
      );
    case "mount_path_matches":
      return (
        <>
          <Field label="Pattern" hint="Glob — `*` matches one segment, `**` matches one or more.">
            <Input value={payload.pattern} onChange={(e) => set({ pattern: e.target.value })} />
          </Field>
          <label className="mt-1 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={payload.not ?? false}
              onChange={(e) => set({ not: e.target.checked })}
            />
            Invert (branch true when the path does NOT match)
          </label>
        </>
      );
    case "time_window":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start hour" hint="0-23">
              <Input
                type="number"
                min={0}
                max={23}
                value={payload.startHour}
                onChange={(e) => set({ startHour: Number(e.target.value) })}
              />
            </Field>
            <Field label="End hour" hint="0-23, wraps midnight">
              <Input
                type="number"
                min={0}
                max={23}
                value={payload.endHour}
                onChange={(e) => set({ endHour: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="Timezone" hint="IANA name; defaults to UTC.">
            <Input
              value={payload.timezone ?? ""}
              placeholder="UTC"
              onChange={(e) => set({ timezone: e.target.value || undefined })}
            />
          </Field>
        </div>
      );
    case "requires_mfa_within":
      return (
        <Field label="Max age (seconds)" hint="Branch true if MFA was passed less than this long ago.">
          <Input
            type="number"
            min={1}
            value={payload.maxAgeSeconds}
            onChange={(e) => set({ maxAgeSeconds: Number(e.target.value) })}
          />
        </Field>
      );
  }
}

function ActionForm({
  payload,
  onChange,
}: {
  payload: Action;
  onChange: (payload: Action) => void;
}) {
  const set = (next: Partial<Action>) => onChange({ ...payload, ...next } as Action);

  switch (payload.kind) {
    case "auto_approve":
      return (
        <Field label="Reason (optional)" hint="Recorded in the audit log alongside the auto-approval.">
          <Input value={payload.reason ?? ""} onChange={(e) => set({ reason: e.target.value || undefined })} />
        </Field>
      );
    case "require_approval":
      return (
        <p className="text-xs text-muted-foreground">
          Approver is the agent&apos;s owner. Server pushes a WebAuthn challenge and waits for proof of control.
        </p>
      );
    case "deny":
      return (
        <Field label="Reason" hint="Returned to the caller + audited.">
          <Input value={payload.reason} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      );
    case "notify":
      return (
        <Field label="Message" hint="Free-text. Recorded in the audit log.">
          <Input value={payload.message} onChange={(e) => set({ message: e.target.value })} />
        </Field>
      );
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[13px] font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const ROLES = ["owner", "admin", "editor", "viewer"] as const;

function RoleMultiSelect({
  value,
  onChange,
}: {
  value: readonly ("owner" | "admin" | "editor" | "viewer")[];
  onChange: (next: readonly ("owner" | "admin" | "editor" | "viewer")[]) => void;
}) {
  const toggle = (role: "owner" | "admin" | "editor" | "viewer") => {
    const set = new Set(value);
    if (set.has(role)) set.delete(role);
    else set.add(role);
    onChange(Array.from(set));
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLES.map((r) => {
        const active = value.includes(r);
        return (
          <button
            key={r}
            type="button"
            onClick={() => toggle(r)}
            className={
              "rounded-md border px-2.5 py-1 text-xs capitalize transition-[background-color,border-color,color] [transition-duration:var(--dur-fast)] ease-out-quart " +
              (active
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-input text-muted-foreground hover:border-ring/40 hover:text-foreground")
            }
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
