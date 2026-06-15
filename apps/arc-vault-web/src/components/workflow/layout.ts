import dagre from "dagre";
import { Position, type Edge, type Node } from "reactflow";

/**
 * Top-to-bottom DAG layout via dagre. Node sizes are estimates; React Flow re-measures
 * them after mount and adjusts edge endpoints. We re-run layout on add/delete/load,
 * not on every drag (the user's manual position wins between layout calls).
 */
const NODE_W = 230;
const NODE_H = 96;

export function layoutDag<NData, EData>(
  nodes: Node<NData>[],
  edges: Edge<EData>[],
): Node<NData>[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 56 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    } as Node<NData>;
  });
}
