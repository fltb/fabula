// ============================================================================
// DAG Export — Visualize causal edge DAG as DOT (Graphviz) or Mermaid
// ============================================================================

import type { AdjacencyList } from './dag.js';

/**
 * Export the causal edge DAG in Graphviz DOT format.
 * Nodes are colored by sceneType (flashback=blue, others=green).
 * Edges represent postcondition→precondition causal dependencies.
 */
export function exportDAGtoDOT(
  edges: AdjacencyList,
  events: Array<{ eventId: string; title?: string; sceneType?: string }>,
): string {
  const lines: string[] = ['digraph G {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];

  // Add nodes with labels and colors
  for (const event of events) {
    const label = event.title ?? event.eventId;
    const color = event.sceneType === 'flashback' ? 'lightblue' : 'lightgreen';
    lines.push(
      `  "${event.eventId}" [label="${event.eventId}\\n${label}", fillcolor=${color}, style="filled,rounded"];`,
    );
  }

  // Add edges
  for (const [from, tos] of edges.entries()) {
    for (const to of tos) {
      lines.push(`  "${from}" -> "${to}";`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Export the causal edge DAG in Mermaid flowchart format.
 * Suitable for rendering in GitHub Markdown or Mermaid-compatible tools.
 */
export function exportDAGtoMermaid(
  edges: AdjacencyList,
  events: Array<{ eventId: string; title?: string }>,
): string {
  const lines: string[] = ['graph TD'];

  // Add styled nodes
  for (const event of events) {
    const label = event.title ?? event.eventId;
    lines.push(`  ${event.eventId}["${event.eventId}: ${label}"]`);
  }

  // Add edges
  for (const [from, tos] of edges.entries()) {
    for (const to of tos) {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  return lines.join('\n');
}
