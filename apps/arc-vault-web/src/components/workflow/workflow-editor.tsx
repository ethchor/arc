"use client";

import * as React from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import { ArrowLeft, Loader2, Save, ShieldAlert, Workflow } from "lucide-react";
import { toast } from "sonner";
import { parseAndValidate, type WorkflowDefinition, type WorkflowIssue } from "@arc/workflows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { WorkflowPalette } from "./palette";
import { WorkflowInspector } from "./inspector";
import { ActionNode, ConditionNode, TriggerNode, type WfNodeData } from "./nodes";
import { defaultActionPayload, defaultConditionPayload, defaultTriggerPayload } from "./factories";
import { projectFromDefinition, projectToDefinition } from "./projection";
import { layoutDag } from "./layout";

export interface WorkflowEditorProps {
  /** When provided, edit mode; otherwise create. */
  initial?: {
    id: string;
    name: string;
    definition: WorkflowDefinition;
    enabled: boolean;
    version: number;
  };
  onSave: (body: {
    name: string;
    definition: WorkflowDefinition;
    enabled: boolean;
    expectedVersion?: number;
  }) => Promise<void>;
  onCancel: () => void;
}

const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
};

const PALETTE_WIDTH = 240;
const INSPECTOR_WIDTH = 320;

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Empty starting graph for a brand-new workflow: just the trigger node. */
function emptyGraph(): { nodes: Node<WfNodeData>[]; edges: Edge[] } {
  const triggerId = newId("trigger");
  return {
    nodes: [
      {
        id: triggerId,
        type: "trigger",
        data: { kind: "trigger", payload: { kind: "request_access" } },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowEditorInner({ initial, onSave, onCancel }: WorkflowEditorProps) {
  const [name, setName] = React.useState(initial?.name ?? "Untitled workflow");
  const [enabled, setEnabled] = React.useState(initial?.enabled ?? true);
  const [{ nodes, edges }, setGraph] = React.useState(() => {
    const seed = initial ? projectFromDefinition(initial.definition) : emptyGraph();
    const laidOut = layoutDag(seed.nodes, seed.edges);
    return { nodes: laidOut, edges: seed.edges };
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<readonly WorkflowIssue[]>([]);
  const [saving, setSaving] = React.useState(false);

  const setNodes = React.useCallback(
    (updater: (ns: Node<WfNodeData>[]) => Node<WfNodeData>[]) =>
      setGraph((g) => ({ ...g, nodes: updater(g.nodes) })),
    [],
  );
  const setEdges = React.useCallback(
    (updater: (es: Edge[]) => Edge[]) => setGraph((g) => ({ ...g, edges: updater(g.edges) })),
    [],
  );

  // Live validation as the user edits. Cheap: pure call, no I/O. The issues list drives
  // the per-node red-dot indicator + the inspector's local error list.
  React.useEffect(() => {
    const definition = projectToDefinition(nodes, edges, name);
    const { result } = parseAndValidate(definition);
    setIssues(result.issues);
  }, [nodes, edges, name]);

  // Decorate nodes with their per-node issues (used by the chrome to render the dot).
  const decoratedNodes = React.useMemo(
    () =>
      nodes.map((n) => {
        const nodeIssues = issues.filter((i) => i.nodeId === n.id);
        return { ...n, data: { ...n.data, issues: nodeIssues } };
      }),
    [nodes, issues],
  );

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [setNodes],
  );
  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [setEdges],
  );

  const onConnect = React.useCallback(
    (params: Connection) => {
      setEdges((es) =>
        addEdge(
          {
            ...params,
            id: newId("edge"),
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          },
          es,
        ),
      );
    },
    [setEdges],
  );

  const addNode = React.useCallback(
    (kind: "trigger" | "condition" | "action", subKind: string) => {
      if (kind === "trigger") {
        if (nodes.some((n) => n.data.kind === "trigger")) {
          toast.error("Only one trigger per workflow");
          return;
        }
      }
      const id = newId(kind);
      const payload =
        kind === "trigger"
          ? defaultTriggerPayload(subKind)
          : kind === "condition"
            ? defaultConditionPayload(subKind)
            : defaultActionPayload(subKind);
      const next: Node<WfNodeData> = {
        id,
        type: kind,
        data: { kind, payload },
        position: { x: 0, y: 0 },
      };
      setGraph((g) => {
        const nextNodes = [...g.nodes, next];
        return { nodes: layoutDag(nextNodes, g.edges), edges: g.edges };
      });
      setSelectedId(id);
    },
    [nodes],
  );

  const updateNode = React.useCallback(
    (id: string, patch: Partial<WfNodeData>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as Node<WfNodeData>) : n)),
      );
    },
    [setNodes],
  );

  const deleteNode = React.useCallback(
    (id: string) => {
      setGraph((g) => ({
        nodes: g.nodes.filter((n) => n.id !== id),
        edges: g.edges.filter((e) => e.source !== id && e.target !== id),
      }));
      setSelectedId(null);
    },
    [],
  );

  const selectedNode = decoratedNodes.find((n) => n.id === selectedId) ?? null;
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Give the workflow a name");
      return;
    }
    if (errors.length > 0) {
      toast.error(`Fix ${errors.length} validation error${errors.length === 1 ? "" : "s"} before saving`);
      return;
    }
    const definition = projectToDefinition(nodes, edges, name);
    setSaving(true);
    try {
      await onSave({
        name,
        definition,
        enabled,
        ...(initial ? { expectedVersion: initial.version } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem-3.5rem-3rem)] min-h-[480px] flex-col overflow-hidden rounded-md border bg-background">
      {/* Topbar */}
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Workflow className="h-4 w-4" />
            <span>{initial ? "Edit workflow" : "New workflow"}</span>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-end gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 max-w-[280px] text-[14px] font-semibold"
            placeholder="Workflow name"
          />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <Button size="sm" onClick={handleSave} disabled={saving || errors.length > 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>

      {/* Three-column body */}
      <div className="flex min-h-0 flex-1">
        <aside style={{ width: PALETTE_WIDTH }} className="shrink-0 border-r bg-muted/20">
          <WorkflowPalette onAdd={addNode} />
        </aside>

        <div className="relative flex-1">
          <ReactFlow
            nodes={decoratedNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            defaultEdgeOptions={{
              type: "smoothstep",
              markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!bg-muted/10" />
            <Controls className="!shadow-none" />
          </ReactFlow>

          {/* Validation summary footer */}
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex justify-between text-[11px]">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-1.5 rounded-md border px-2 py-1 backdrop-blur",
                errors.length > 0
                  ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : warnings.length > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              )}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              {errors.length === 0 && warnings.length === 0
                ? "Valid"
                : `${errors.length} error${errors.length === 1 ? "" : "s"} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>

        <aside style={{ width: INSPECTOR_WIDTH }} className="shrink-0 border-l bg-muted/20">
          <WorkflowInspector
            selectedId={selectedId}
            nodeData={selectedNode?.data ?? null}
            issues={issues}
            onChange={updateNode}
            onDelete={deleteNode}
          />
        </aside>
      </div>
    </div>
  );
}

// Re-export a Label use so unused-import warnings stay quiet in some tsconfigs.
// (Not strictly necessary — left for future "Label" usage in topbar.)
export const _Label = Label;
