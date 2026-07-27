// ============================================================================
// Novalistically — Review System Types (§7.E)
// ============================================================================

// ——— Review Comment ———

export interface ReviewComment {
  id: string;
  author: 'human' | 'llm';
  target: {
    type: 'scene' | 'chapter' | 'character' | 'worldrule' | 'line';
    id: string;
    lineRange?: [number, number];
  };
  severity: 'nit' | 'suggestion' | 'blocking';
  category:
    | 'style'
    | 'pacing'
    | 'character_voice'
    | 'plot_logic'
    | 'world_consistency'
    | 'reader_experience';
  content: string;
  status: 'open' | 'addressed' | 'resolved' | 'wontfix';
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}

// ——— Review Patch ———

export interface ReviewPatch {
  sourceReviewIds: string[];
  description: string;
  changes: PatchChange[];
}

export interface PatchChange {
  type: 'rewrite' | 'insert' | 'delete' | 'attribute_change';
  target: string;
  oldValue?: unknown;
  newValue: unknown;
  rationale: string;
}
