// ============================================================================
// DiscourseValidator — Narrator profile resolution + discourse replay integrity
// ============================================================================
// Purely deterministic (no Pass 2 analysis-block dependency):
//   validatePre: always returns [] — PreRenderInput does not carry narrator profiles
//     or ContextPackage data (only event, worldState, events, entityRegistry, etc.).
//     Narrator profile resolution requires context compiled in Pass 1, available only post-render.
//   validatePost: checks two conditions:
//     1. If event.narratorProfileRef is set but context.narratorProfile is undefined,
//        the reference did not resolve to a loaded profile (fatal).
//     2. If context.discourseReplayError is set, the discourse replay engine caught
//        a constraint violation (truth-boundary, hint lifecycle, retraction, etc.).
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class DiscourseValidator implements Validator {
  name = 'discourse';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    // PreRenderInput does not carry narrator profiles or ContextPackage data;
    // narrator profile resolution is only available after Pass 1 (post-render).
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    // Check 1: If event declares a narratorProfileRef, it must resolve successfully.
    // This check assumes PostRenderInput.context (being added by orchestrator) carries
    // narratorProfile if the ref resolved, undefined if it did not.
    if (
      event.narratorProfileRef &&
      !(input as PostRenderInput & { context?: { narratorProfile?: unknown } }).context
        ?.narratorProfile
    ) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'error',
          `Scene "${event.id}" references narratorProfileRef "${event.narratorProfileRef}" which did not resolve to a loaded NarratorProfile`,
          'Define the referenced narrator profile in definitions/narrators/, or remove narratorProfileRef.',
          'edit_file',
          'narratorProfileRef',
        ),
      );
    }

    // Check 2: If discourse replay encountered a constraint violation, surface it.
    // discourseReplayError is populated by ContextCompiler.compile() when
    // replayDiscourseState() throws (truth-boundary, hint-state, retraction violations, etc.).
    const discourseReplayError = (
      input as PostRenderInput & { context?: { discourseReplayError?: string } }
    ).context?.discourseReplayError;

    if (discourseReplayError) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'error',
          `Discourse replay failed for "${event.id}": ${discourseReplayError}`,
          'Fix the discourse ledger entry referencing this scene — check truth-boundary, hint-state, or retraction constraints in discourse-replay.ts.',
          'edit_file',
          'discourse',
        ),
      );
    }

    return issues;
  }
}
