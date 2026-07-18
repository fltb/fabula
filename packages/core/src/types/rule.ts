// ============================================================================
// Novalistically — Rule Definition Types
// ============================================================================

import type { RuleEffectEntry } from './event.js';

// ——— Rule Definition (YAML) ———

export interface RuleDefinition {
  ruleId: string;
  name: string;
  category: string;
  type: string;
  statement: string;
  ruleClass?: 'natural_law' | 'social_norm' | 'moral_principle' | 'game_rule' | 'legal_code';
  logicalConsequences: LogicalConsequence[];
  exceptions?: Array<{ condition: string; note: string }>;
  evidenceChain: RuleEffectEntry[];
}

export interface LogicalConsequence {
  description: string;
  check: {
    type: 'state_invariant' | 'transition_constraint' | 'progression';
    filter: string;
    assert: string;
    unlessEvent?: string;
    direction?: string;
    tolerance?: number;
    severity: 'error' | 'warning';
  };
}
