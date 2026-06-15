"use client";

import { Bell, Check, Clock, KeyRound, ShieldCheck, Users, Workflow, X, Zap } from "lucide-react";
import { Pressable } from "@/components/motion/pressable";
import { ACTION_PALETTE, CONDITION_PALETTE, TRIGGER_PALETTE, type PaletteEntry } from "./types";
import { cn } from "@/lib/utils";

function paletteIcon(kind: PaletteEntry["kind"], subKind: string) {
  if (kind === "trigger") return <Zap className="h-4 w-4 text-amber-500" />;
  if (kind === "condition") {
    if (subKind === "time_window") return <Clock className="h-4 w-4 text-sky-500" />;
    if (subKind === "requester_group" || subKind === "requester_role") return <Users className="h-4 w-4 text-sky-500" />;
    if (subKind === "requires_mfa_within") return <ShieldCheck className="h-4 w-4 text-sky-500" />;
    return <Workflow className="h-4 w-4 text-sky-500" />;
  }
  if (subKind === "auto_approve") return <Check className="h-4 w-4 text-emerald-500" />;
  if (subKind === "require_approval") return <KeyRound className="h-4 w-4 text-violet-500" />;
  if (subKind === "deny") return <X className="h-4 w-4 text-rose-500" />;
  if (subKind === "notify") return <Bell className="h-4 w-4 text-amber-500" />;
  return null;
}

/**
 * Left-side palette. Click a card to add a node at the cursor / center; the editor
 * decides where to place it. The cards stagger in on first paint via the existing
 * motion primitives.
 */
export function WorkflowPalette({
  onAdd,
  disabled,
}: {
  onAdd: (kind: PaletteEntry["kind"], subKind: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-3">
      <PaletteSection title="Trigger" hint="Exactly one per workflow" entries={TRIGGER_PALETTE} onAdd={onAdd} disabled={disabled} />
      <PaletteSection title="Conditions" hint="Branch on context" entries={CONDITION_PALETTE} onAdd={onAdd} disabled={disabled} />
      <PaletteSection title="Actions" hint="Three are terminal" entries={ACTION_PALETTE} onAdd={onAdd} disabled={disabled} />
    </div>
  );
}

function PaletteSection({
  title,
  hint,
  entries,
  onAdd,
  disabled,
}: {
  title: string;
  hint: string;
  entries: readonly PaletteEntry[];
  onAdd: (kind: PaletteEntry["kind"], subKind: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        <span className="text-[10px] text-muted-foreground/60">{hint}</span>
      </div>
      <div className="space-y-1.5">
        {entries.map((e) => (
          <Pressable key={`${e.kind}-${e.subKind}`} asChild>
            <button
              type="button"
              onClick={() => onAdd(e.kind, e.subKind)}
              disabled={disabled}
              className={cn(
                "flex w-full items-start gap-2 rounded-md border bg-background px-2.5 py-2 text-left",
                "transition-[border-color,background-color,box-shadow] [transition-duration:var(--dur-fast)] ease-out-quart",
                "hover:border-ring/40 hover:bg-accent/50",
                "disabled:opacity-50 disabled:pointer-events-none",
              )}
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                {paletteIcon(e.kind, e.subKind)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{e.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{e.description}</span>
              </span>
            </button>
          </Pressable>
        ))}
      </div>
    </div>
  );
}
