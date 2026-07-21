// ============================================================================
// PromptAssembler — Assembles LLM prompts from templates + context
// ============================================================================

import { readFileSync } from 'node:fs';
import type { ContextPackage, StyleGuidance } from '../types/index.ts';
import type { Message } from '../ai/types.ts';

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
      const effectiveTarget = options?.styleGuidance?.targetWordCount ?? options?.targetLengthWords ?? 800;
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
        parts.push(`- This scene should be approximately ${sg.targetWordCount} ${unit} long. This is a firm target — do not significantly under- or over-write.`);
      }
    }
    if (options?.characterVoiceNotes) {
      parts.push(`- Character voice: ${options.characterVoiceNotes}`);
    }
    const targetAudience = context.systemContext?.targetAudience;
    if (targetAudience) {
      parts.push(`- Target audience: ${targetAudience}. Adjust vocabulary, complexity, and prose style accordingly.`);
    }

    parts.push(
      '',
      '## Narrative Context Package',
      '```json',
      JSON.stringify(context, null, 2),
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
      systemPrompt: 'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.',
      userPrompt,
      messages: [
        { role: 'system', content: 'You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.' },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  private getBuiltInInstructions(targetLength: number, language: string): string[] {
    const isCJK = language.startsWith('zh') || language.startsWith('ja') || language.startsWith('ko');
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
