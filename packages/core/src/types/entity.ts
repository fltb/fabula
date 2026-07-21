// ============================================================================
// Novalistically — Entity, Timestamp & Fact Types
// ============================================================================

import type { BranchSet } from './branch.js';

// ——— IDs ———

export type EntityId = string;

export type EntityKind =
  | 'character'
  | 'location'
  | 'item'
  | 'concept'
  | 'faction'
  | 'rule';

// ——— Entity ———

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  definitionFile: string;
  state: Record<string, unknown>;
}

// ——— Timestamp System (§7.4.16) ———

export type StoryTimestamp =
  | AbsoluteTimestamp
  | RelativeTimestamp
  | ChapterTimestamp;

export interface AbsoluteTimestamp {
  type: 'absolute';
  value: string;
}

export interface RelativeTimestamp {
  type: 'relative';
  anchor: string;
  offset: {
    amount: number;
    unit: 'minute' | 'hour' | 'day' | 'week' | 'month';
  };
}

export interface ChapterTimestamp {
  type: 'chapter';
  chapter: number;
}

export interface TimeAnchor {
  id: string;
  day: number;
  description?: string;
}

// ——— Fact System (§7.4.7) ———

export type FactId = string;

export interface Fact {
  id: FactId;
  entityId: EntityId;
  attribute: string;
  /**
   * Deterministic value to write to WorldState.
   * When present and operation is omitted (or 'set'), the value is canonicalized and written.
   * Operation 'unset' deletes the attribute from state; value MUST be absent.
   */
  value?: unknown;
  /**
   * Semantic description for Pass 2 analysis (no WorldState write).
   * Mutually exclusive with value.
   */
  narrativeHint?: string;
  confidence?: number;
  /**
   * Set or unset the attribute. Default 'set' when value is present.
   * - 'set': write canonicalized value to WorldState (value required)
   * - 'unset': delete the attribute from WorldState (value and narrativeHint forbidden)
   * Omitted/undefined defaults to 'set' when value is present.
   */
  operation?: 'set' | 'unset';
  validity: FactValidity;
}

export interface FactValidity {
  temporal: { start: StoryTimestamp; end: StoryTimestamp | null };
  branches: BranchSet;
}

// ——— Entity Registry (§7.4.14) ———

export interface EntityRegistry {
  load: (projectPath: string) => void;
  resolve: (id: EntityId) => Entity | null;
  findByKind: (kind: EntityKind) => Entity[];
  findByAttribute: (attribute: string, value: unknown) => Entity[];
  resolveRefs: (refs: EntityId[]) => Map<EntityId, Entity | null>;
  register: (entity: Entity) => void;
  updateState: (id: EntityId, state: Record<string, unknown>) => void;
  getAll: () => Entity[];
}
