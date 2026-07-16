// ============================================================================
// Novalistically — Location & Item Definition Types
// ============================================================================

// ——— Location Definition ———

export interface LocationDefinition {
  id: string;
  name: string;
  kind: string;
  parent?: string;
  description: string;
  initialState: Record<string, unknown>;
  notableFeatures?: string[];
}

// ——— Item Definition ———

export interface ItemDefinition {
  id: string;
  name: string;
  kind: string;
  description: string;
  initialState: Record<string, unknown>;
}
