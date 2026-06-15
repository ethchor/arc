import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./types";

/**
 * Canonical JSON serialization for storage + future signing. RFC 8785 (JCS) is overkill
 * for our needs; the workflow shape is structurally small and we control both ends, so
 * a deterministic sort + minimal JSON is enough.
 *
 * Stable: nodes and edges are sorted by id; object keys at every level are sorted
 * alphabetically. Two semantically-equivalent definitions always serialize identically,
 * so a future server-side signature stays stable across UI saves that reorder things
 * in-memory.
 */
export function canonicalize(def: WorkflowDefinition): string {
  return JSON.stringify(prepare(def));
}

function prepare(def: WorkflowDefinition): unknown {
  return sortKeys({
    version: def.version,
    ...(def.name !== undefined ? { name: def.name } : {}),
    nodes: [...def.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(nodeToCanonical),
    edges: [...def.edges].sort((a, b) => a.id.localeCompare(b.id)).map(edgeToCanonical),
  });
}

function nodeToCanonical(n: WorkflowNode): unknown {
  return sortKeys(n as unknown as Record<string, unknown>);
}

function edgeToCanonical(e: WorkflowEdge): unknown {
  return sortKeys(e as unknown as Record<string, unknown>);
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = sortKeys(obj[k]);
  }
  return out;
}
