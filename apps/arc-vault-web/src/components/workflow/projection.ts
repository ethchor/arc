/**
 * Projection between React Flow's node + edge representation and the canonical
 * `WorkflowDefinition` the server stores.
 *
 * Two functions, exact inverses up to layout positions (which the canonical form
 * does not carry — dagre re-computes them on load).
 */
import type { Edge, Node } from "reactflow";
import type {
  Action,
  Condition,
  Trigger,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import type { WfNodeData } from "./nodes";

export function projectToDefinition(
  nodes: Node<WfNodeData>[],
  edges: Edge[],
  name?: string,
): WorkflowDefinition {
  const wfNodes: WorkflowNode[] = nodes.map((n) => {
    if (n.data.kind === "trigger") {
      return { id: n.id, kind: "trigger", trigger: n.data.payload as Trigger };
    }
    if (n.data.kind === "condition") {
      return { id: n.id, kind: "condition", condition: n.data.payload as Condition };
    }
    return { id: n.id, kind: "action", action: n.data.payload as Action };
  });
  const wfEdges: WorkflowEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.source,
    to: e.target,
    ...(e.sourceHandle === "true" || e.sourceHandle === "false"
      ? { branch: e.sourceHandle as "true" | "false" }
      : {}),
  }));
  return {
    version: 1,
    ...(name ? { name } : {}),
    nodes: wfNodes,
    edges: wfEdges,
  };
}

export function projectFromDefinition(def: WorkflowDefinition): {
  nodes: Node<WfNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<WfNodeData>[] = def.nodes.map((n) => {
    const data: WfNodeData =
      n.kind === "trigger"
        ? { kind: "trigger", payload: n.trigger }
        : n.kind === "condition"
          ? { kind: "condition", payload: n.condition }
          : { kind: "action", payload: n.action };
    return {
      id: n.id,
      type: n.kind,
      data,
      position: { x: 0, y: 0 }, // dagre fills this in
    };
  });
  const edges: Edge[] = def.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    ...(e.branch ? { sourceHandle: e.branch } : {}),
    type: "smoothstep",
    animated: false,
  }));
  return { nodes, edges };
}
