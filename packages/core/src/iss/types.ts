// ============================================================================
// ISS — Shared Types & Utilities
// ============================================================================

import type { EntityLookup, NarrativeEvent, RuleDefinition } from '../types/index.js';

// ─── Placeholder Detection ──────────────────────────────────────────────────

const PLACEHOLDER_VALUES = [
  'changed',
  'resolved',
  'updated',
  'affected',
  'modified',
  'altered',
] as const;
export type PlaceholderValue = (typeof PLACEHOLDER_VALUES)[number];

export function isPlaceholderValue(value: unknown): value is PlaceholderValue {
  return (
    typeof value === 'string' &&
    PLACEHOLDER_VALUES.includes(value.toLowerCase() as PlaceholderValue)
  );
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ISSOptions {
  entities: EntityLookup;
  events: NarrativeEvent[];
  threads: Array<{ id: string; name: string }>;
  rules: RuleDefinition[];
}

export interface StrictValidationContext {
  entities: EntityLookup;
  events: NarrativeEvent[];
  rules: RuleDefinition[];
  threads: Array<{ id: string; name: string }>;
}
