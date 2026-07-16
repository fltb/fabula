// ============================================================================
// AI Prompts — Scene Render
// ============================================================================

import type { ContextPackage, StyleGuidance } from '../../types/index.ts';
import type { Message } from '../types.ts';

export interface SceneRenderInput {
  context: ContextPackage;
  styleGuidance?: StyleGuidance;
  characterVoice?: string;
  povVoice?: string;
  targetLengthWords?: number;
}

/**
 * Build a system + user message pair for rendering a scene as prose.
 *
 * The system prompt establishes the writer's role, the user prompt
 * provides the full context package and concrete writing instructions.
 */
export function buildSceneRenderPrompt(input: SceneRenderInput): Message[] {
  const sysParts: string[] = [
    'You are a narrative prose writer for a long-form literary novel. Your job is to render the next scene based on the provided narrative context package.',
    'Write immersive, character-driven prose. Match the established tone, voice, and pacing of the work.',
    'Do not invent facts that contradict the supplied context. If a fact is uncertain, write it as uncertain. Stay within the established POV.',
  ];

  if (input.styleGuidance) {
    const sg = input.styleGuidance;
    if (sg.tone) sysParts.push(`Tone: ${sg.tone}.`);
    if (sg.scenePacing) sysParts.push(`Pacing: ${sg.scenePacing}.`);
    if (sg.atmosphere) sysParts.push(`Atmosphere: ${sg.atmosphere}.`);
    if (sg.avoid) sysParts.push(`Avoid: ${sg.avoid}.`);
  }

  if (input.characterVoice) {
    sysParts.push(`Character voice notes: ${input.characterVoice}`);
  }
  if (input.povVoice) {
    sysParts.push(`POV voice: ${input.povVoice}`);
  }

  const sys = sysParts.join('\n');

  const userParts: string[] = [
    '## Narrative Context Package\n',
    '```json',
    JSON.stringify(input.context, null, 2),
    '```\n',
  ];
  userParts.push(
    '## Writing Instructions\n',
    'Write the next scene in prose. Follow these rules:',
    '- Maintain third-person limited POV unless the context specifies otherwise',
    '- Show, do not tell — use sensory detail and interiority',
    '- Do not contradict any established fact in the context',
    `- Target length: ~${input.targetLengthWords ?? 1200} words`,
    '\n## Output\n',
    'Begin with the scene. Output ONLY the prose — no preamble, no commentary, no JSON wrapper.',
  );

  return [
    { role: 'system', content: sys },
    { role: 'user', content: userParts.join('\n') },
  ];
}
