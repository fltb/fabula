// ============================================================================
// Novalistically — ISS (Internal Structural Soundness) Types
// ============================================================================

// ——— ISS Snapshot ———

export interface ISSSnapshot {
  overall: number;
  target: number;
  dimensions: ISSDimension[];
}

export interface ISSDimension {
  name: string;
  score: number;
  max: number;
  threshold: number;
  status: 'green' | 'yellow' | 'red';
  gaps: ISSGap[];
}

export interface ISSGap {
  entity?: string;
  id?: string;
  file?: string;
  suggestion: string;
  fixAction: 'create_file' | 'edit_file' | 'add_field' | 'change_value';
  fixTarget: string;
  template?: string;
}
