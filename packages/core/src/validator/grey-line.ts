// ============================================================================
// GreyLineValidator — Validate grey line motif tracking after render
// ============================================================================
// Checks that grey line nodes declared in the current event are well-formed:
//   - Each node references a valid eventId
//   - The imagery text appears in the rendered prose (via Pass 2 narrativeChecks)
//   - No duplicate nodes for the same event within a single grey line
// Does NOT require closure — nodes can grow indefinitely.

import type {
  Validator,
  ValidationIssue,
  PostRenderInput,
  PreRenderInput,
  NarrativeCheck,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class GreyLineValidator implements Validator {
  name = 'greyLine';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    // No grey lines declared — nothing to validate
    const greyLines = event.greyLines ?? [];
    if (greyLines.length === 0) return issues;

    // Pull narrativeChecks from Pass 2 analysis, if available
    const narrativeChecks: NarrativeCheck[] = [];
    if (analysis?.analysis?.narrativeChecks) {
      const parsed = analysis.analysis.narrativeChecks;
      if (Array.isArray(parsed)) {
        narrativeChecks.push(...parsed);
      }
    }

    for (const gl of greyLines) {
      // — eventId validity —
      for (const node of gl.nodes) {
        if (!node.eventId || node.eventId.trim().length === 0) {
          issues.push(makeIssue(
            this.name,
            input.event.id,
            gl.id,
            'warning',
            `Grey line "${gl.id}" contains a node with an empty or missing eventId`,
            'Provide a valid event identifier for each node',
            'edit_file',
            'greyLines',
            undefined,
            node,
          ));
        }
      }

      // — imagery appears in narrativeChecks evidence —
      const imagery = gl.imagery;
      if (imagery && narrativeChecks.length > 0) {
        const imageryFound = narrativeChecks.some(
          (nc) => nc.evidence && nc.evidence.includes(imagery),
        );
        if (!imageryFound) {
          issues.push(makeIssue(
            this.name,
            input.event.id,
            gl.id,
            'warning',
            `Imagery "${imagery}" from grey line "${gl.id}" not detected in Pass 2 narrativeChecks evidence`,
            'Ensure the imagery text appears in the rendered prose',
            'edit_file',
            'greyLines',
          ));
        }
      }

      // — duplicate eventId nodes within the same grey line —
      const seenEventIds = new Set<string>();
      for (const node of gl.nodes) {
        if (!node.eventId) continue;
        if (seenEventIds.has(node.eventId)) {
          issues.push(makeIssue(
            this.name,
            input.event.id,
            gl.id,
            'warning',
            `Grey line "${gl.id}" has multiple nodes referencing event "${node.eventId}"`,
            'Each event should appear at most once per grey line',
            'edit_file',
            'greyLines',
            undefined,
            node,
          ));
        }
        seenEventIds.add(node.eventId);
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [];
  }
}
