"use client";

import * as React from "react";
import { Plus, ShieldAlert, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { VaultClient, WorkflowRow } from "@arc/sdk";
import type { WorkflowDefinition } from "@arc/workflows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Reveal } from "@/components/motion/reveal";
import { Stagger } from "@/components/motion/stagger";
import { WorkflowEditor } from "@/components/workflow/workflow-editor";
import { cn } from "@/lib/utils";

interface Props {
  vaultId: string | null;
  canManage: boolean;
  getClient: () => VaultClient;
}

type Mode = { kind: "list" } | { kind: "edit"; row: WorkflowRow } | { kind: "create" };

export function WorkflowsView({ vaultId, canManage, getClient }: Props) {
  const [mode, setMode] = React.useState<Mode>({ kind: "list" });
  const [rows, setRows] = React.useState<WorkflowRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!vaultId) return;
    setLoading(true);
    try {
      setRows(await getClient().listWorkflows(vaultId));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vaultId, getClient]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!vaultId) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Select a vault under Secrets first.
      </p>
    );
  }

  if (!canManage) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Workflows can only be viewed and edited by admins or owners of this vault.
      </p>
    );
  }

  if (mode.kind === "create" || mode.kind === "edit") {
    return (
      <WorkflowEditor
        initial={mode.kind === "edit" ? toEditorInitial(mode.row) : undefined}
        onCancel={() => setMode({ kind: "list" })}
        onSave={async (body) => {
          // SDK shape expects the canonical JSON envelope. WorkflowDefinition narrows it
          // further (`version: 1` literal), so we cast at the boundary.
          const wireBody = { ...body, definition: body.definition as unknown as Record<string, unknown> };
          try {
            if (mode.kind === "create") {
              const created = await getClient().createWorkflow(vaultId, wireBody);
              toast.success(`Created "${created.name}"`);
            } else {
              const updated = await getClient().updateWorkflow(vaultId, mode.row.id, wireBody);
              toast.success(`Saved "${updated.name}"`);
            }
            setMode({ kind: "list" });
            await refresh();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    );
  }

  const list = rows ?? [];

  return (
    <div className="space-y-4">
      <Reveal variant="fade-up" offset={6}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Workflows</h1>
            <p className="max-w-prose text-sm text-muted-foreground">
              Configurable rules that decide what happens when an agent requests
              elevated access: auto-approve, require a push to your phone, or deny.
            </p>
          </div>
          <Button size="sm" onClick={() => setMode({ kind: "create" })}>
            <Plus className="h-4 w-4" /> New workflow
          </Button>
        </div>
      </Reveal>

      {loading && list.length === 0 ? (
        <Card tone="flat">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card tone="flat">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/15">
              <Workflow className="h-5 w-5 text-primary" />
            </span>
            <div>
              <p className="text-sm font-semibold">No workflows yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Configure one rule that decides what happens when an agent requests access.
              </p>
            </div>
            <Button size="sm" onClick={() => setMode({ kind: "create" })}>
              <Plus className="h-4 w-4" /> New workflow
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stagger className="grid gap-3" stagger={0.05}>
          {list.map((row) => (
            <Stagger.Item key={row.id}>
              <WorkflowRowCard
                row={row}
                onOpen={() => setMode({ kind: "edit", row })}
                onDelete={async () => {
                  if (!confirm(`Delete “${row.name}”? This cannot be undone.`)) return;
                  try {
                    await getClient().deleteWorkflow(vaultId, row.id);
                    toast.success("Deleted");
                    await refresh();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
              />
            </Stagger.Item>
          ))}
        </Stagger>
      )}

      <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.04] p-3 text-sm">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
        <p className="text-muted-foreground">
          Workflows run on the server for elevated agent intents. They cannot reach inside
          end-to-end-encrypted vault items. Trust boundary: see <code>docs/02</code>.
        </p>
      </div>
    </div>
  );
}

function WorkflowRowCard({
  row,
  onOpen,
  onDelete,
}: {
  row: WorkflowRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const counts = summariseDefinition(row.definition);
  return (
    <Card
      tone="raised"
      interactive
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer"
    >
      <CardContent className="flex items-center gap-3 p-4">
        <span
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 ring-1 ring-primary/15",
            !row.enabled && "opacity-40",
          )}
        >
          <Workflow className="h-4 w-4 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{row.name}</span>
            {row.enabled ? (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <ShieldCheck className="h-3 w-3" /> Enabled
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Paused
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {counts.conditions} condition{counts.conditions === 1 ? "" : "s"} ·{" "}
            {counts.actions} action{counts.actions === 1 ? "" : "s"} · v{row.version} · updated{" "}
            {timeAgo(row.updatedAt)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive"
          aria-label="Delete workflow"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

function toEditorInitial(row: WorkflowRow) {
  return {
    id: row.id,
    name: row.name,
    definition: row.definition as unknown as WorkflowDefinition,
    enabled: row.enabled,
    version: row.version,
  };
}

function summariseDefinition(def: Record<string, unknown>) {
  const nodes = Array.isArray((def as { nodes?: unknown }).nodes) ? (def as { nodes: { kind?: string }[] }).nodes : [];
  return {
    conditions: nodes.filter((n) => n.kind === "condition").length,
    actions: nodes.filter((n) => n.kind === "action").length,
  };
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
