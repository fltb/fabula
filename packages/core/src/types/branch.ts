// ============================================================================
// Novalistically — Branch System Types (§7.4.7)
// ============================================================================

// ——— Branch Path ———

export interface BranchPath {
  decisions: Array<{
    atEventId: string;
    choiceId: string;
    narrativeOrder: number;
  }>;
}

export type BranchSet =
  | { type: 'all' }
  | { type: 'paths'; paths: BranchPath[] }
  | { type: 'condition'; condition: Condition }
  | { type: 'except'; branches: BranchSet };

export interface BranchPoint {
  branchPointId: string;
  atEventId: string;
  description: string;
  choices: BranchChoice[];
  defaultBranch?: string;
  existenceCondition: BranchSet;
}

export interface BranchChoice {
  choiceId: string;
  label: string;
  condition?: Condition;
  narrativeOrder: number;
}

export interface Condition {
  type: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'and' | 'or';
  field?: string;
  value?: unknown;
  conditions?: Condition[];
}

// ——— Branch Points File ———

export interface BranchPointsFile {
  branchPoints: Array<{
    id: string;
    atEvent: string;
    description: string;
    choices: Array<{
      path: string;
      label: string;
      branchId: string;
      description: string;
    }>;
  }>;
}
