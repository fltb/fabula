// ============================================================================
// PromptAssembler — Assembles LLM prompts from templates + context
// ============================================================================

import { readFileSync } from 'node:fs';
import type { Message } from '../ai/types.ts';
import type { ContextPackage, StyleGuidance } from '../types/index.ts';

export interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
  messages: Message[];
}

export class PromptAssembler {
  private scribeSystemPrompt: string;
  private scribeInstructions: string;

  constructor(templatePath?: string) {
    // In production, loads from templatePath
    // For now, use the built-in prompt as default
    if (templatePath) {
      const template = readFileSync(templatePath, 'utf-8');
      const parsed = this.parseTemplate(template);
      this.scribeSystemPrompt = parsed.systemPrompt;
      this.scribeInstructions = parsed.instructions;
    } else {
      this.scribeSystemPrompt =
        'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.';
      this.scribeInstructions = '';
    }
  }

  private parseTemplate(template: string): { systemPrompt: string; instructions: string } {
    const systemMatch = template.match(/## System Prompt\n([\s\S]*?)(?=\n## |$)/);
    const instrMatch = template.match(/## Instructions\n([\s\S]*?)(?=\n## |$)/);
    return {
      systemPrompt: systemMatch?.[1]?.trim() ?? '',
      instructions: instrMatch?.[1]?.trim() ?? '',
    };
  }

  assemble(
    context: ContextPackage,
    options?: {
      styleGuidance?: StyleGuidance;
      characterVoiceNotes?: string;
      targetLengthWords?: number;
      language?: string;
      referenceExample?: string;
      retryGuidance?: string;
      /** Pre-composed style profile notes from resolved project/chapter/scene profile */
      profileStyleNotes?: string;
      /** S1: Narrative checklist items as coverage requirements for Pass 1 */
      narrativeChecklistItems?: Array<{
        dimension: string;
        description: string;
        required: boolean;
      }>;
      /** S4: Source context style notes (STYLE-classified only), injected as style anchors */
      sourceContextStyleNotes?: string;
    },
  ): AssembledPrompt {
    const parts: string[] = [
      '## Role',
      this.scribeInstructions || this.scribeSystemPrompt,
      '',
      '## Instructions',
    ];

    if (this.scribeInstructions) {
      // Use the parsed instructions from template
      parts.push(this.scribeInstructions);
    } else {
      // Fallback to built-in instructions
      const effectiveTarget =
        options?.styleGuidance?.targetWordCount ?? options?.targetLengthWords ?? 800;
      const lang = options?.language ?? 'en';
      parts.push(...this.getBuiltInInstructions(effectiveTarget, lang));
    }

    if (options?.styleGuidance) {
      const sg = options.styleGuidance;
      if (sg.tone) parts.push(`- Tone: ${sg.tone}.`);
      if (sg.scenePacing) parts.push(`- Pacing: ${sg.scenePacing}.`);
      if (sg.atmosphere) parts.push(`- Atmosphere: ${sg.atmosphere}.`);
      if (sg.targetWordCount) {
        const isCJK = (options?.language ?? 'en').startsWith('zh');
        const unit = isCJK ? '字' : 'words';
        parts.push(
          `- This scene should be approximately ${sg.targetWordCount} ${unit} long. This is a firm target — do not significantly under- or over-write.`,
        );
      }
      if (sg.avoid) parts.push(`- Avoid: ${sg.avoid}.`);
    }
    if (context.sceneSpec?.emotionalValence) {
      parts.push(`- Emotional keynote: ${context.sceneSpec.emotionalValence}.`);
    }
    if (context.sceneSpec?.emotionalBeat) {
      parts.push(`- Emotional beat: ${context.sceneSpec.emotionalBeat}.`);
    }
    if (options?.characterVoiceNotes) {
      parts.push(`- Character voice: ${options.characterVoiceNotes}`);
    }
    if (options?.profileStyleNotes) {
      parts.push(`- ${options.profileStyleNotes}`);
    }
    // S1: Narrative checklist items as coverage requirements
    if (options?.narrativeChecklistItems && options.narrativeChecklistItems.length > 0) {
      parts.push('');
      parts.push('## Narrative Coverage Requirements');
      parts.push('The following narrative dimensions must be addressed in this scene prose:');
      for (const item of options.narrativeChecklistItems) {
        const marker = item.required ? 'REQUIRED' : 'recommended';
        parts.push(`- [${marker}] ${item.dimension}: ${item.description}`);
      }
    }
    // S4: Source context style anchors (STYLE only)
    if (options?.sourceContextStyleNotes) {
      parts.push('');
      parts.push('## Source Style Anchors');
      parts.push('Reference these style elements from the original text as prose guidance:');
      parts.push(options.sourceContextStyleNotes);
    }
    const targetAudience = context.systemContext?.targetAudience;
    if (targetAudience) {
      parts.push(
        `- Target audience: ${targetAudience}. Adjust vocabulary, complexity, and prose style accordingly.`,
      );
    }
    // S7b: Whole-work synopsis
    if (context.systemContext?.synopsis) {
      parts.push('');
      parts.push('## Work Synopsis');
      parts.push(context.systemContext.synopsis);
    }
    // S7a: Whole-work thematic intent (Idea IR)
    if (context.systemContext?.thematicIntent) {
      parts.push('');
      parts.push('## Thematic Intent');
      parts.push(context.systemContext.thematicIntent.primaryTheme);
      if (context.systemContext.thematicIntent.subThemes?.length) {
        parts.push(`Sub-themes: ${context.systemContext.thematicIntent.subThemes.join(', ')}`);
      }
    }
    // S6c: Narrator profile for this scene
    if (context.narratorProfile) {
      parts.push('');
      parts.push('## Narrator');
      parts.push(`Type: ${context.narratorProfile.type}`);
      parts.push(
        `Fidelity: ${context.narratorProfile.fidelity}; Sincerity: ${context.narratorProfile.sincerity}`,
      );
    }

    // DRC: Author notes
    if (context.sceneSpec?.authorNotes && context.sceneSpec.authorNotes.length > 0) {
      parts.push('');
      parts.push('## Author Notes');
      for (const note of context.sceneSpec.authorNotes) {
        parts.push(`- ${note}`);
      }
    }
    // DRC: Active world rules
    if (context.activeRules && context.activeRules.length > 0) {
      parts.push('');
      parts.push('## World Rules');
      for (const rule of context.activeRules) {
        parts.push(`- ${rule.ruleId}: ${rule.statement}`);
      }
      parts.push('Prose must not contradict these rules.');
    }
    parts.push(
      '',
      '## Narrative Context Package',
      '```json',
      JSON.stringify(
        (({ markdown: _omitted, ...contextForPrompt }) => contextForPrompt)(context),
        null,
        2,
      ),
      '```',
    );

    if (options?.referenceExample) {
      parts.push(
        '',
        '## Reference Example',
        '(A well-formed prose example from a similar scene in this novel)',
        '```',
        options.referenceExample,
        '```',
      );
    }

    if (options?.retryGuidance) {
      parts.push(
        '',
        '## Correction Required — Previous Output Was Rejected',
        'The previous rendering of this scene failed quality checks. You MUST address ALL of them in this rewrite.',
        '',
        options.retryGuidance,
      );
    }

    parts.push(
      '',
      '## Output',
      'Write the scene now. Output ONLY the prose text — no explanation, no formatting, no JSON.',
    );

    const userPrompt = parts.join('\n');

    return {
      systemPrompt:
        'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.',
      userPrompt,
      messages: [
        {
          role: 'system',
          content:
            'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.',
        },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  private getBuiltInInstructions(targetLength: number, language: string): string[] {
    const isCJK =
      language.startsWith('zh') || language.startsWith('ja') || language.startsWith('ko');
    const unit = isCJK ? '字（characters）' : 'words';
    return [
      '- Write ONLY the scene narrative. No planning. No self-analysis. No section headers. No JSON.',
      '- Begin directly with the action or description. Do not label or explain the scene.',
      "- Stay strictly in the POV character's perspective (third-person limited unless stated otherwise).",
      '- Use sensory detail and interiority. Show emotional state through physical detail, not abstract summary.',
      '- Do NOT contradict any established fact from the context package.',
      "- End when this scene's narrative beat is complete. A clean break is better than over-writing.",
      `- Target length: ~${targetLength} ${unit}.`,
    ];
  }
}
