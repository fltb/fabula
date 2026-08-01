// ============================================================================
// Novalistically — Review System Types (§7.E)
// ============================================================================

// ——— Review Application V1 ———

export interface ReviewApplicationV1 {
  eventId: string;
  revisionId: string;
  operationId: string;
  appliedAt: string;
}

// ——— Review Comment ———

export interface ReviewComment {
  id: string;
  author: 'human' | 'llm';
  actorId: string;
  target: {
    type: 'scene' | 'chapter' | 'character' | 'worldrule' | 'line' | 'novel';
    id: string;
    lineRange?: [number, number];
    lineBasis?: { revisionId: string; proseHash: string };
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
  status: 'open' | 'addressed' | 'resolved' | 'wontfix' | 'superseded';
  applications: ReviewApplicationV1[];
  supersedesId?: string;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}

// ——— New Review Comment Input ———

export interface NewReviewComment {
  target: {
    type: 'scene' | 'chapter' | 'character' | 'worldrule' | 'line' | 'novel';
    id: string;
    lineRange?: [number, number];
    lineBasis?: { revisionId: string; proseHash: string };
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
}

// ——— Review Ledger V1 ———

export interface ReviewLedgerV1 {
  version: 1;
  comments: ReviewComment[];
  patches: ReviewPatch[];
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
