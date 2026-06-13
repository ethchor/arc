"use client";
import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
  Position,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";

/**
 * Interactive control-plane diagram. Three engines (A / B / C) attached to one
 * `arc-server` plane, with the surfaces above and the storage below. Each node carries
 * a colour family so the engine identity is legible at a glance: blue = Engine A (infra
 * secrets), violet = Engine B (E2E vault), amber = Engine C (agents).
 *
 * Layout is hand-positioned for clarity at typical docs widths (~960px). React Flow's
 * controls (zoom + fit) let visitors poke around if they want to inspect a particular
 * node group.
 */
const surfaceStyle = {
  background: "hsl(var(--card))",
  color: "hsl(var(--card-foreground))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  padding: 10,
  fontSize: 12,
  fontWeight: 500,
  width: 150,
};
const serverStyle = {
  ...surfaceStyle,
  border: "2px solid hsl(var(--primary))",
  fontWeight: 600,
  width: 220,
};
const engineAStyle = {
  ...surfaceStyle,
  background: "rgb(59 130 246 / 0.08)",
  border: "1px solid rgb(59 130 246 / 0.4)",
  width: 170,
};
const engineBStyle = {
  ...surfaceStyle,
  background: "rgb(139 92 246 / 0.08)",
  border: "1px solid rgb(139 92 246 / 0.4)",
  width: 170,
};
const engineCStyle = {
  ...surfaceStyle,
  background: "rgb(245 158 11 / 0.08)",
  border: "1px solid rgb(245 158 11 / 0.4)",
  width: 170,
};
const storeStyle = {
  ...surfaceStyle,
  background: "hsl(var(--muted))",
  color: "hsl(var(--muted-foreground))",
  fontStyle: "italic" as const,
};

const nodes: Node[] = [
  // Surfaces — top row
  { id: "web", position: { x: 60, y: 0 }, data: { label: "Web console" }, style: surfaceStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "desktop", position: { x: 230, y: 0 }, data: { label: "Desktop · Tauri" }, style: surfaceStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "ext", position: { x: 400, y: 0 }, data: { label: "Browser ext." }, style: surfaceStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "cli", position: { x: 570, y: 0 }, data: { label: "CLI · SDK · API" }, style: surfaceStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "mcp", position: { x: 740, y: 0 }, data: { label: "MCP server" }, style: surfaceStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },

  // arc-server hub
  {
    id: "server",
    position: { x: 320, y: 120 },
    data: { label: "arc-server\nidentity · policy · audit" },
    style: serverStyle,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  },

  // Engines — middle row
  { id: "engineA", position: { x: 60, y: 250 }, data: { label: "Engine A\nKV · Transit · PKI · Dynamic creds" }, style: engineAStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "engineB", position: { x: 350, y: 250 }, data: { label: "Engine B\nE2E vault · ciphertext only" }, style: engineBStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: "engineC", position: { x: 640, y: 250 }, data: { label: "Engine C\nAgents · signed intents" }, style: engineCStyle, sourcePosition: Position.Bottom, targetPosition: Position.Top },

  // Storage — bottom row
  { id: "openbao", position: { x: 60, y: 380 }, data: { label: "OpenBao (MPL 2.0)\nbarrier · seal · Raft" }, style: storeStyle, targetPosition: Position.Top },
  { id: "postgres", position: { x: 350, y: 380 }, data: { label: "PostgreSQL\nciphertext + metadata" }, style: storeStyle, targetPosition: Position.Top },
  { id: "leases", position: { x: 640, y: 380 }, data: { label: "Leases\n(closeTask cascades)" }, style: storeStyle, targetPosition: Position.Top },
];

const edge = (id: string, source: string, target: string, label?: string, animated = false): Edge => ({
  id,
  source,
  target,
  label,
  animated,
  style: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5 },
  labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
  labelBgStyle: { fill: "hsl(var(--background))" },
});

const edges: Edge[] = [
  edge("e-web", "web", "server"),
  edge("e-desktop", "desktop", "server"),
  edge("e-ext", "ext", "server"),
  edge("e-cli", "cli", "server"),
  edge("e-mcp", "mcp", "server", "agent path"),

  edge("e-a", "server", "engineA"),
  edge("e-b", "server", "engineB"),
  edge("e-c", "server", "engineC"),

  edge("e-a-bao", "engineA", "openbao"),
  edge("e-b-pg", "engineB", "postgres", "ciphertext only"),
  edge("e-c-l", "engineC", "leases", "close cascades", true),
];

export function ArchitectureDiagram() {
  const flow = useMemo(() => ({ nodes, edges }), []);
  return (
    <div className="my-6 h-[520px] overflow-hidden rounded-xl border bg-background/50">
      <ReactFlowProvider>
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll={false}
          zoomOnPinch
        >
          <Background gap={20} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
