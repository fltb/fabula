// ============================================================================
// NarrativeTechniqueValidator — Validates Pass 2 analysis for resolved
// narrative technique contracts.
// ============================================================================
//
// Checks:
// 1. Wiring check: if the raw event has direct technique fields but
//    context.narrativeTechniques is empty/missing, produce a wiring error.
// 2. For each resolved contract in context.narrativeTechniques, require
//    exactly one matching narrativeCheck with entityId=event.id,
//    attribute=contract.kind, and matchLevel of exact or similar.
//    Missing, duplicate, absent, or contradicted → error.
//
// Events without any technique contracts (neither raw nor resolved) are
// skipped silently — no automatic checklist generation.
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  ResolvedNarrativeTechniqueContract,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { NARRATIVE_TECHNIQUE_KINDS } from '../types/narrative-techniques.js';
import { makeIssue } from './base.js';
import { narrativeCheckSchema } from './schemas.js';

/**
 * The 8 raw technique field names on NarrativeEvent that indicate
 * a direct author-authored technique contract.
 */
const RAW_TECHNIQUE_FIELDS: Record<string, true> = {
  causalDiscontinuity: true,
  surfaceMode: true,
  causalMultiplicity: true,
  irresolvableIndeterminacy: true,
  absentApparatus: true,
  voiceDissonance: true,
  multiplicity: true,
  metanarrativeLevel: true,
};

function hasRawTechniqueContracts(event: Record<string, unknown>): boolean {
  for (const field of Object.keys(RAW_TECHNIQUE_FIELDS)) {
    if (event[field] !== undefined) return true;
  }
  return false;
}

export class NarrativeTechniqueValidator implements Validator {
  name = 'narrative_technique' as const;
  category = 'narrative_style' as const;

  validatePre(): ValidationIssue[] {
    return []; // No pre-render checks
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis, context } = input;
    const eventId = event.id;

    // ── 1. Wiring check ──────────────────────────────────────────────
    // If the raw event has direct technique contracts but the context
    // package has none (or is missing), that's a wiring error.
    const eventRaw = event as unknown as Record<string, unknown>;
    const hasRaw = hasRawTechniqueContracts(eventRaw);
    const resolvedContracts: readonly ResolvedNarrativeTechniqueContract[] =
      context?.narrativeTechniques ?? [];

    if (hasRaw && resolvedContracts.length === 0) {
      issues.push(
        makeIssue(
          this.name,
          eventId,
          eventId,
          'error',
          `Event "${eventId}" has direct technique contracts but the resolved context package has none — technique resolution or wiring may have failed`,
          'Ensure technique resolver runs and produces contracts for this event',
          'manual',
          'narrativeTechniques',
        ),
      );
      // Nothing more to check — no resolved contracts to validate against
      return issues;
    }

    // No contracts at all — nothing to validate
    if (resolvedContracts.length === 0) return issues;

    // ── 2. Pass 2 analysis check ─────────────────────────────────────
    if (!analysis) return issues;

    // Parse narrativeChecks from the analysis payload
    const rawChecks = (analysis.analysis as Record<string, unknown>).narrativeChecks;
    const allChecks = z.array(narrativeCheckSchema).safeParse(rawChecks).data ?? [];

    for (const contract of resolvedContracts) {
      const kind = contract.kind;

      // Find all narrativeChecks for this event + kind
      const matchingChecks = allChecks.filter(
        (c) => c.entityId === eventId && c.attribute === kind,
      );

      if (matchingChecks.length === 0) {
        // Required check was not produced by Pass 2
        issues.push(
          makeIssue(
            this.name,
            eventId,
            eventId,
            'error',
            `Narrative technique contract "${kind}" for event "${eventId}" has no matching narrativeCheck in Pass 2 analysis`,
            `Ensure Pass 2 produces a narrativeCheck with entityId="${eventId}" and attribute="${kind}"`,
            'change_value',
            kind,
            undefined,
            undefined,
            'evidence_mismatch',
            { field: 'narrativeChecks' },
          ),
        );
        continue;
      }

      if (matchingChecks.length > 1) {
        issues.push(
          makeIssue(
            this.name,
            eventId,
            eventId,
            'error',
            `Narrative technique contract "${kind}" for event "${eventId}" has ${matchingChecks.length} matching narrativeChecks — expected exactly 1`,
            `Ensure Pass 2 produces exactly one narrativeCheck with entityId="${eventId}" and attribute="${kind}"`,
            'change_value',
            kind,
            undefined,
            undefined,
            'evidence_mismatch',
            {
              field: 'narrativeChecks',
              analysisPointer: `/narrativeChecks/${allChecks.findIndex((c) => c.entityId === eventId && c.attribute === kind)}`,
            },
          ),
        );
        continue;
      }

      const check = matchingChecks[0];
      const checkIndex = allChecks.indexOf(check);
      const checkRef =
        checkIndex >= 0
          ? { field: 'narrativeChecks', analysisPointer: `/narrativeChecks/${checkIndex}` }
          : { field: 'narrativeChecks' };

      // Validate matchLevel
      if (check.matchLevel === 'absent') {
        issues.push(
          makeIssue(
            this.name,
            eventId,
            eventId,
            'error',
            `Narrative technique contract "${kind}" for event "${eventId}" has matchLevel "absent" — the prose does not satisfy the required evidence: ${contract.requiredEvidence}`,
            `Revise the prose to satisfy the "${kind}" required evidence: ${contract.requiredEvidence}`,
            'change_value',
            kind,
            undefined,
            undefined,
            'evidence_mismatch',
            checkRef,
          ),
        );
      } else if (check.matchLevel === 'contradicted') {
        issues.push(
          makeIssue(
            this.name,
            eventId,
            eventId,
            'error',
            `Narrative technique contract "${kind}" for event "${eventId}" has matchLevel "contradicted" — the prose contradicts the required evidence: ${contract.requiredEvidence}`,
            `Revise the prose to satisfy the "${kind}" required evidence: ${contract.requiredEvidence}`,
            'change_value',
            kind,
            undefined,
            undefined,
            'evidence_mismatch',
            checkRef,
          ),
        );
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'narrativeChecks',
        attributes: [...NARRATIVE_TECHNIQUE_KINDS],
        schema: z.array(narrativeCheckSchema),
        instruction:
          'narrativeChecks[technique]: For each narrative technique contract active on this scene, ' +
          'evaluate whether the prose satisfies the required evidence. Use the narrativeChecks block ' +
          'with attribute set to the exact technique kind (causalDiscontinuity, surfaceMode, ' +
          'causalMultiplicity, irresolvableIndeterminacy, absentApparatus, voiceDissonance, ' +
          'multiplicity, metanarrativeLevel) and entityId set to the event ID. Report matchLevel ' +
          'as "exact", "similar", "absent", or "contradicted".',
      },
    ];
  }
}
