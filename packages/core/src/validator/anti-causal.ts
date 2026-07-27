// ============================================================================
// AntiCausalEdgeValidator — Detect structural anti-causal patterns (S3)
// ============================================================================
// Post-render: checks whether the project's event graph shows a high ratio
// of events whose postconditions are never referenced by later preconditions.
// Default threshold: 0.5 (50%).
//
// Stub implementation (Wave 2): emits an info-level issue noting the
// configured threshold. Full implementation will count events via the
// event store and compare against worldState facts.
// ============================================================================

import type { PostRenderInput, ValidationIssue, Validator } from '../types/index.js';
import { makeIssue } from './base.js';

export class AntiCausalEdgeValidator implements Validator {
  name = 'antiCausalEdge';
  category = 'timeline_plot' as const;

  validatePre(): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const config = input.event.modernNovel?.antiCausalEdge;
    if (!config?.enabled) return issues;

    const threshold = config.threshold ?? 0.5;
    issues.push(
      makeIssue(
        this.name,
        input.event.id,
        input.event.pov.character,
        'info',
        `Anti-causal edge detection enabled (threshold=${threshold}). Full project-level scan requires event store access — skipped in stub.`,
        'Implement project-wide anti-causal edge ratio analysis for production use.',
        'manual',
        'modernNovel.antiCausalEdge',
        undefined,
        { threshold, enabled: true },
      ),
    );
    return issues;
  }

  getAnalysisRequirements() {
    return [];
  }
}
