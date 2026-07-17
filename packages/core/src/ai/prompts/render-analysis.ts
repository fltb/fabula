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
// ============================================================================

import type { ContextPackage, NarrativeEvent } from '../../types/index.ts';
import type { Message } from '../types.ts';

export interface RenderAnalysisInput {
  event: NarrativeEvent;
  prose: string;
  context: ContextPackage;
  /** Previous validation error messages for self-correction context */
  previousErrors?: string[];
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
        preconditions: input.event.preconditions.map((p) => ({
          entityId: p.entityId,
          attribute: p.attribute,
          value: p.value,
        })),
        postconditions: input.event.postconditions.map((p) => ({
          entityId: p.entityId,
          attribute: p.attribute,
          value: p.value,
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
    '## Rendered Prose',
    '```',
    input.prose,
    '```',
    '',
    '## Instructions',
    'Analyze the prose against the specification. Output ONLY valid JSON with this schema:',
    '',
    '```json',
    JSON.stringify(
      {
        eventId: input.event.id,
        analysis: {
          postconditions: {
            covered: [
              'list of entityId.attribute that ARE mentioned or implied in the prose',
            ],
            dropped: [
              'list of entityId.attribute that are NOT mentioned in the prose',
            ],
          },
          preconditions: {
            violated: [
              {
                entityId: 'entityId',
                attribute: 'attribute',
                expectedValue: 'expected value',
                issue: 'description of contradiction found in prose',
              },
            ],
          },
          pov: {
            consistent: true,
            leaks: ['any phrases that enter another character\'s inner thoughts'],
          },
          inventedDetails: [
            {
              detail: 'something in prose not in specification',
              severity: 'minor or major',
            },
          ],
          quality: {
            proseScore: 0,
            maxScore: 10,
            strengths: ['specific strength'],
            weaknesses: ['specific weakness'],
            estimatedWordCount: 0,
          },
          threadProgressAchieved: ['thread IDs where prose advances the thread'],
          foreshadowingDeployed: ['foreshadowing IDs that appear in prose'],
        },
      },
      null,
      2,
    ),
    '```',
    '',
  ];

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
