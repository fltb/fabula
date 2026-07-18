// ============================================================================
// AI Prompts — Pass 2: Structured Analysis of Rendered Prose
// ============================================================================
//
// After the LLM produces prose (Pass 1), we feed the prose + context back
// to the same LLM and ask it to produce a structured JSON analysis.
//
// This serves two purposes:
// 1. The LLM self-checks its own output against the event's claims
// 2. We get machine-parseable metadata about coverage, contradictions, POV
//
// If the JSON is malformed, we retry ONLY Pass 2 (cheaper than re-rendering).
//
// The JSON schema is built dynamically from AnalysisBlockRequirement[]:
// Only blocks that have at least one active validator consumer are included.
// For narrativeChecks, the attribute enum is built from merged attributes.
// ============================================================================

import type { ContextPackage, NarrativeEvent } from '../../types/index.ts';
import type { RuleDefinition } from '../../types/rule.ts';
import type { AnalysisBlockRequirement } from '../../types/index.ts';
import type { Message } from '../types.ts';

export interface RenderAnalysisInput {
  event: NarrativeEvent;
  prose: string;
  context: ContextPackage;
  /** Previous validation error messages for self-correction context */
  previousErrors?: string[];
  /** Active rule definitions for rule consistency checks */
  activeRules?: RuleDefinition[];
  /** Dynamic analysis requirements from active validators */
  analysisRequirements?: AnalysisBlockRequirement[];
}

/**
 * Extract the top-level analysis block field from a dotted requirement field.
 * e.g. 'pov.leaks' → 'pov', 'narrativeChecks' → 'narrativeChecks'
 */
function topField(field: string): string {
  return field.split('.')[0];
}

/**
 * Build the dynamic JSON template for the Pass 2 analysis schema.
 * Only blocks with active validator requirements are included.
 * Each block is generated from the schemaExample of the first matching requirement.
 * For narrativeChecks, attributes from all requirements are merged.
 */
function buildDynamicJsonTemplate(
  eventId: string,
  requirements: AnalysisBlockRequirement[],
): Record<string, unknown> {
  // ── Collect active top-level fields ─────────────────────────
  const activeFields = new Set<string>();
  for (const req of requirements) {
    activeFields.add(topField(req.field));
  }

  // ── Build merged attributes for narrativeChecks ─────────────
  const narrativeCheckAttrs: string[] = [];
  for (const req of requirements) {
    if (topField(req.field) === 'narrativeChecks' && req.attributes) {
      narrativeCheckAttrs.push(...req.attributes);
    }
  }

  // ── Build the analysis object from requirements ─────────────
  const analysis: Record<string, unknown> = {};

  // Group requirements by top-level field, use first as template
  const fieldToReq = new Map<string, AnalysisBlockRequirement>();
  for (const req of requirements) {
    const tf = topField(req.field);
    if (!fieldToReq.has(tf)) {
      fieldToReq.set(tf, req);
    }
  }

  for (const field of activeFields) {
    const req = fieldToReq.get(field);
    if (!req) continue; // Shouldn't happen, but guard

    // Deep-clone the schemaExample as the template base
    const template = JSON.parse(JSON.stringify(req.schemaExample));

    // Special handling for narrativeChecks: merge attributes & add matchLevel
    if (field === 'narrativeChecks' && Array.isArray(template)) {
      const item = template[0] as Record<string, unknown>;
      if (narrativeCheckAttrs.length > 0) {
        item.attribute = narrativeCheckAttrs.join(' | ');
      }
      item.matchLevel = 'exact|similar|absent|contradicted';
      analysis[field] = template;
    } else {
      // For all other blocks, use the schemaExample as-is
      // (it already contains the correct structure)
      analysis[field] = template;
    }
  }

  return {
    eventId,
    analysis,
  };
}

/**
 * Build Pass 2 prompt: analyze the just-generated prose vs the source event.
 */
export function buildAnalysisPrompt(input: RenderAnalysisInput): Message[] {
  const sys = 'You are a literary editor and quality assurance agent. Given a scene specification and the rendered prose, produce a structured analysis of how well the prose matches the specification. Output ONLY valid JSON.';

  const userParts: string[] = [
    '## Scene Specification',
    '```json',
    JSON.stringify(
      {
        id: input.event.id,
        title: input.event.title,
        sceneType: input.event.sceneType,
        storyTime: input.event.storyTime,
        pov: input.event.pov,
        sceneBrief: input.event.sceneBrief,
        tense: input.event.tense,
        conflictType: input.event.conflictType,
        resolutionType: input.event.resolutionType,
        discourseMode: input.event.discourseMode,
        arcPosition: input.event.arcPosition,
        preconditions: input.event.preconditions.map((p) => ({
          entityId: p.entityId,
          attribute: p.attribute,
          value: p.value,
          narrativeHint: p.narrativeHint,
        })),
        postconditions: input.event.postconditions.map((p) => ({
          entityId: p.entityId,
          attribute: p.attribute,
          value: p.value,
          narrativeHint: p.narrativeHint,
        })),
        threadProgress: input.event.threadProgress,
        foreshadowing: input.event.foreshadowing?.map((f) => ({
          id: f.id,
          hint: f.hint,
        })),
        relationshipEffects: input.event.relationshipEffects,
        ruleEffects: input.event.ruleEffects,
      },
      null,
      2,
    ),
    '```',
    '',
    '## Context',
    input.context.markdown,
    '',
    '## Rendered Prose',
    '```',
    input.prose,
    '```',
    '',
  ];

  if (input.activeRules && input.activeRules.length > 0) {
    userParts.push(
      '',
      '## Active World Rules',
      '```json',
      JSON.stringify(input.activeRules, null, 2),
      '```',
      '',
    );
  }

  // ── Build dynamic JSON template ───────────────────────────
  const requirements = input.analysisRequirements ?? [];
  const jsonTemplate = buildDynamicJsonTemplate(input.event.id, requirements);

  userParts.push(
    '## Instructions',
    'Analyze the prose against the specification. Output ONLY valid JSON with this schema:',
    '',
    '```json',
    JSON.stringify(jsonTemplate, null, 2),
    '```',
    '',
    '### Analysis Guidance',
    '',
  );

  // ── Dynamic instructions from requirements ────────────────
  const instructions = requirements
    .map(r => r.instruction)
    .join('\n\n');

  userParts.push(
    instructions || 'Analyze the prose for consistency with the specification. Follow the structure defined in the JSON schema above.',
    '',
  );

  if (input.previousErrors && input.previousErrors.length > 0) {
    userParts.push(
      '',
      '## Previous Validation Errors',
      'The previous rendering was flagged for these issues. Re-evaluate whether the current prose has addressed them:',
      ...input.previousErrors.map((e) => `- ${e}`),
    );
  }

  userParts.push(
    '',
    'Output ONLY the JSON object. No preamble, no explanation.',
  );

  return [
    { role: 'system', content: sys },
    { role: 'user', content: userParts.join('\n') },
  ];
}
