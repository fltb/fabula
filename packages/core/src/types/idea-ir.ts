// ============================================================================
// Novalistically — S7a: Idea IR — Aristotelian Mythos (thematic intent)
// Whole-work thematic intent, emotional arc, and core conflict.
// ============================================================================

/** Thematic intent — the macro-level thematic concerns of the work */
export interface ThematicIntent {
  /** Primary theme of the work (e.g. "revolution devours its children") */
  primaryTheme: string;
  /** Supporting or subordinate themes */
  subThemes: string[];
}

/** Definition of the intended emotional arc across the whole work */
export interface EmotionalArcDefinition {
  /** Arc type label (e.g. "tragedy", "bildungsroman", "redemption") */
  arcType: string;
  /** Emotional beats mapped to arc positions (opening/rising/climax/falling/denouement) */
  emotionalBeats: { position: string; emotion: string }[];
}

/**
 * Idea IR — the top-level thematic and emotional blueprint.
 * Declared once per project YAML, not per event.
 * Optional for backward compatibility — projects without Idea IR are valid.
 */
export interface IdeaIR {
  /** Thematic intent of the work */
  thematicIntent: ThematicIntent;
  /** Intended emotional arc across the whole work */
  emotionalArc: EmotionalArcDefinition;
  /** Optional target audience description */
  targetAudience?: string;
  /** Optional core conflict summary */
  coreConflict?: string;
}
