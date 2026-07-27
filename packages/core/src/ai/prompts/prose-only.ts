// ============================================================================
// AI Prompts — Pass 1: Prose Generation (pure output, no metadata)
// ============================================================================
//
// The first pass asks the LLM to write ONLY prose. No preamble, no analysis,
// no JSON wrapper — just the narrative text. This is separate from Pass 2
// (analysis) so the model doesn't waste reasoning budget on formatting.
//
// Reference template: provides a worked example of input → good prose
// so the model converges on quality output faster.
// ============================================================================

import type { ContextPackage, StyleGuidance } from '../../types/index.ts';
import type { Message } from '../types.ts';

export interface ProseOnlyInput {
  context: ContextPackage;
  styleGuidance?: StyleGuidance;
  characterVoiceNotes?: string;
  targetLengthWords?: number;
  referenceExample?: string; // optional "good" example from prior similar scene
  /** Injected on retry: describes what was wrong with the previous attempt */
  retryGuidance?: string;
}

/**
 * Build Pass 1 prompt: produce ONLY prose, no preamble, no JSON.
 */
export function buildProsePrompt(input: ProseOnlyInput): Message[] {
  const parts: string[] = [
    '## Role',
    'You are a working novelist producing the next scene of a literary novel. Your reader expects clean, immersive prose — no commentary, no stage directions, no meta-text.',
    '',
    '## Instructions',
    '- Write ONLY the scene narrative. No planning. No self-analysis. No section headers. No JSON.',
    '- Begin directly with the action or description. Do not label or explain the scene.',
    "- Stay strictly in the POV character's perspective (third-person limited unless stated otherwise).",
    '- Use sensory detail and interiority. Show emotional state through physical detail, not abstract summary.',
    '- Do NOT contradict any established fact from the context package.',
    "- End when this scene's narrative beat is complete. A clean break is better than over-writing.",
    '',
    `- Target length: ~${input.targetLengthWords ?? 800} words.`,
  ];

  if (input.styleGuidance) {
    const sg = input.styleGuidance;
    if (sg.tone) parts.push(`- Tone: ${sg.tone}.`);
    if (sg.scenePacing) parts.push(`- Pacing: ${sg.scenePacing}.`);
    if (sg.atmosphere) parts.push(`- Atmosphere: ${sg.atmosphere}.`);
  }
  if (input.characterVoiceNotes) {
    parts.push(`- Character voice: ${input.characterVoiceNotes}`);
  }

  parts.push(
    '',
    '## Narrative Context Package',
    '```json',
    JSON.stringify(input.context, null, 2),
    '```',
  );

  if (input.referenceExample) {
    parts.push(
      '',
      '## Reference Example',
      '(A well-formed prose example from a similar scene in this novel)',
      '```',
      input.referenceExample,
      '```',
    );
  }

  if (input.retryGuidance) {
    parts.push(
      '',
      '## Correction Required — Previous Output Was Rejected',
      'The previous rendering of this scene failed quality checks. You MUST address ALL of them in this rewrite.',
      '',
      input.retryGuidance,
    );
  }

  parts.push(
    '',
    '## Output',
    'Write the scene now. Output ONLY the prose text — no explanation, no formatting, no JSON.',
  );

  return [
    {
      role: 'system',
      content:
        'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.',
    },
    { role: 'user', content: parts.join('\n') },
  ];
}
