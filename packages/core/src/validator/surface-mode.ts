// ============================================================================
// SurfaceModeValidator — Validate surface-only description mode (S3)
// ============================================================================
// Post-render: if event.modernNovel?.surfaceMode?.enabled is true,
// scan Pass 2 narrativeChecks for any internal-POV or psychological-activity
// markers. If found, emit a warning — surface mode should describe only
// external/physical detail (Robbe-Grillet structural refusal of depth).
// ============================================================================

import type {
  NarrativeCheck,
  PostRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { makeIssue } from './base.js';

/** Attribute values that indicate internal POV or psychological activity */
const INTERNAL_ATTRIBUTES = new Set([
  'internal_pov',
  'internal',
  'psychological_activity',
  'psychological',
  'emotion',
  'thought',
  'interiority',
]);

export class SurfaceModeValidator implements Validator {
  name = 'surfaceMode';
  category = 'narrative_style' as const;

  validatePre(): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const config = input.event.modernNovel?.surfaceMode;
    if (!config?.enabled) return issues;

    // Pull narrativeChecks from Pass 2 analysis, if available
    const narrativeChecks: NarrativeCheck[] = [];
    if (input.analysis?.analysis?.narrativeChecks) {
      const parsed = input.analysis.analysis.narrativeChecks;
      if (Array.isArray(parsed)) {
        narrativeChecks.push(...(parsed as NarrativeCheck[]));
      }
    }

    const internalMarkers = narrativeChecks.filter((check) =>
      INTERNAL_ATTRIBUTES.has(check.attribute),
    );

    if (internalMarkers.length > 0) {
      const details = internalMarkers.map((c) => `${c.attribute} (${c.hint})`).join('; ');
      issues.push(
        makeIssue(
          this.name,
          input.event.id,
          input.event.pov.character,
          'warning',
          `Surface mode enabled but Pass 2 detected internal POV / psychological markers: ${details}. In surface mode, narrative should describe only external, physical detail.`,
          'Remove internal POV or psychological description from this scene, or disable surfaceMode.',
          'change_value',
          'modernNovel.surfaceMode',
          undefined,
          { surfaceMode: true, internalMarkers },
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [];
  }
}
