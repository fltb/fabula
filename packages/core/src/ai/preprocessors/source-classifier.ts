// ============================================================================
// Novalistically — Source Classifier (S4)
// LLM-based STYLE/FACT/MIXED classifier.
//
// The prompt instructs the LLM to classify each segment of a source excerpt
// as STYLE (pure style — atmosphere, syntax, poetry), FACT (plot fact that
// enters WorldState), or MIXED (both — split for separate handling).
// Only STYLE-classified parts enter Pass 1 as style references.
// ============================================================================
// NOTE: This is a stub. The actual LLM call integration is deferred.
// The pipeline is wired — data flows through — but no real provider call
// is made until LLM integration is set up in a follow-up pass.
// ============================================================================

import type { SourceContextEntry } from '../../types/source-context.ts';

// ── Prompt template ──────────────────────────────────────────────────────────

/**
 * The classification prompt sent to the LLM.
 *
 * Given a source excerpt, classify each segment as STYLE, FACT, or MIXED.
 *
 * - STYLE: pure style element — atmosphere, syntax, prose rhythm, poetry,
 *   figurative language, sensory detail that sets tone without conveying plot
 * - FACT: plot fact — character action, event, setting change, dialogue that
 *   advances the story; these enter WorldState via preconditions/postconditions
 * - MIXED: both style and fact are present in the same segment — the LLM
 *   should split the segment and return separate STYLE and FACT entries
 */
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

// ── Classifier function ───────────────────────────────────────────────────────

/**
 * Classify a source excerpt into STYLE/FACT/MIXED segments.
 *
 * @param excerpt - The source text excerpt to classify
 * @returns A promise resolving to an array of classified SourceContextEntry objects
 *
 * TODO: Wire actual LLM call once provider integration is complete.
 * Current implementation returns a placeholder that marks the entire
 * excerpt as MIXED, signalling that integration is pending.
 */
export async function classifySourceExcerpt(
  excerpt: string,
): Promise<SourceContextEntry[]> {
  // ── TODO: Replace placeholder with real LLM call ───────────────────────
  // The real implementation should:
  //   1. Call an LLM provider with CLASSIFIER_SYSTEM_PROMPT + the excerpt
  //   2. Parse the JSON response
  //   3. Validate each entry against SourceContextEntry shape
  //   4. Return the classified entries
  //
  // Example LLM call pattern:
  //   const provider = getProvider('default');
  //   const response = await provider.complete({
  //     messages: [
  //       { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
  //       { role: 'user', content: excerpt },
  //     ],
  //   });
  //   const entries = JSON.parse(response.content);
  //   return entries.map(validateEntry);

  // Placeholder: return a single MIXED entry for the full excerpt
  return [
    {
      excerpt,
      classification: 'MIXED',
      styleNote:
        'LLM integration pending — classify this excerpt with a real provider call',
    },
  ];
}
