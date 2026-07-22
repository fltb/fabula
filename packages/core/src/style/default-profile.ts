// ============================================================================
// Novalistically — Default Style Profile (§D8)
//
// User-facing StyleProfile for project/chapter/narrator/scene style config.
// This is a simpler type than the internal StyleProfile (render-surface.ts),
// omitting profileId and resolutionPrecedence which are added by the resolver.
// ============================================================================

export interface StyleProfile {
  /** Narrative voice description (e.g. "formal", "conversational", "lyrical") */
  voice?: string;
  /** Word choice level (e.g. "standard", "elevated", "colloquial") */
  diction?: string;
  /** Sentence rhythm pattern (e.g. "varied", "staccato", "flowing") */
  rhythm?: string;
  /** Paragraph structure (e.g. "standard", "short_paragraphs", "dense") */
  paragraphing?: string;
  /** Typographic conventions (e.g. "standard", "minimal_punctuation") */
  typography?: string;
  /** Dialogue formatting rules (e.g. "standard", "minimal_attribution") */
  dialogue?: string;
  /** Patterns to avoid in generated prose */
  avoid?: string[];
}

export const DEFAULT_STYLE_PROFILE: StyleProfile = {
  voice: 'neutral',
  diction: 'standard',
  rhythm: 'varied',
  paragraphing: 'standard',
  typography: 'standard',
  dialogue: 'standard',
  avoid: [],
};
