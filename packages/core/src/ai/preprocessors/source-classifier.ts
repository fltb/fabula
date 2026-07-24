// ============================================================================
// Novalistically — Source Classifier (S4)
// LLM-based STYLE/FACT/MIXED classifier.
//
// The prompt instructs the LLM to classify each segment of a source excerpt
// as STYLE (pure style — atmosphere, syntax, poetry), FACT (plot fact that
// enters WorldState), or MIXED (both — split for separate handling).
// Only STYLE-classified parts enter Pass 1 as style references.
// ============================================================================

import type { SourceContextEntry } from '../../types/source-context.ts';
import type { LLMProvider } from '../types.ts';

// ── Prompt template ──────────────────────────────────────────────────────────

export const CLASSIFIER_SYSTEM_PROMPT = `You are a literary style classifier for a narrative generation system.
Given a text excerpt from a source work, identify each distinct semantic segment and classify it.

Rules:
- STYLE: atmosphere, syntax, prose rhythm, figurative language, sensory detail, poetry, or any element that establishes tone/mood without conveying plot facts
- FACT: character actions, events, setting changes, dialogue that advances the story, or any statement about what happens in the narrative
- MIXED: the same sentence contains both style and fact elements — split it into separate STYLE and FACT entries

Return a JSON array of objects with fields:
  - excerpt: string (the classified text segment)
  - classification: "STYLE" | "FACT" | "MIXED"
  - styleNote: string (optional, for STYLE/MIXED entries: what specific style element to reference)`;

// ── Zod validation for LLM response ─────────────────────────────────────────

import { z } from 'zod';
const sourceContextEntrySchema = z.object({
  excerpt: z.string(),
  classification: z.enum(['STYLE', 'FACT', 'MIXED']),
  styleNote: z.string().optional(),
});

// ── Classifier function ───────────────────────────────────────────────────────

/**
 * Classify a source excerpt into STYLE/FACT/MIXED segments using an LLM provider.
 *
 * @param excerpt - The source text excerpt to classify
 * @param provider - An LLMProvider instance (e.g. AiSdkProvider)
 * @returns A promise resolving to an array of classified SourceContextEntry objects.
 *          Returns a single MIXED fallback entry if the provider is unavailable or fails.
 */
export async function classifySourceExcerpt(
  excerpt: string,
  provider?: LLMProvider,
): Promise<SourceContextEntry[]> {
  if (!provider) {
    // Provider not available: return a single MIXED entry — the caller can still
    // use it as a unified style reference, but STYLE/FACT separation is deferred.
    return [{
      excerpt,
      classification: 'MIXED',
      styleNote: 'LLM provider not configured — entire excerpt treated as MIXED. Configure NOVALISTICALLY_AI_API_KEY for STYLE/FACT separation.',
    }];
  }

  try {
    const response = await provider.complete({
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: excerpt },
      ],
      taskType: 'summary',
      temperature: 0.1,
    });

    const text = response.content.trim();
    // Strip markdown code fences if present
    const jsonText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonText);

    const entries = z.array(sourceContextEntrySchema).parse(parsed);
    return entries;
  } catch {
    // On any failure (network, parse, validation), fall back to MIXED
    return [{
      excerpt,
      classification: 'MIXED',
      styleNote: 'Classification failed — treating entire excerpt as MIXED fallback.',
    }];
  }
}
