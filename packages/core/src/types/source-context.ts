// ============================================================================
// Novalistically — Source Context Types (S4)
// Style anchors extracted from original source text, classified as STYLE/FACT/MIXED.
// STYLE-classified parts enter Pass 1 as style references; FACT parts are filtered
// out (already present in preconditions/postconditions).
// ============================================================================

/**
 * A single excerpt from source text, classified by an LLM preprocessor.
 */
export interface SourceContextEntry {
  /** Text excerpt from the source material */
  excerpt: string;
  /**
   * Classification of the excerpt:
   * - STYLE: pure style element (atmosphere, syntax, poetry, prose rhythm)
   * - FACT: plot fact that enters WorldState
   * - MIXED: both style and fact — split for separate handling
   */
  classification: 'STYLE' | 'FACT' | 'MIXED';
  /** For STYLE/MIXED excerpts: what style element to reference in generation */
  styleNote?: string;
}

/**
 * Per-event source context container.
 * Attached to EventFile to carry style anchors through the pipeline.
 * Does NOT enter Fact comparison; does NOT conflict with validators.
 */
export interface SourceContext {
  entries: SourceContextEntry[];
}
