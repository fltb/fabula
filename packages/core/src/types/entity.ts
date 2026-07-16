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
  value: unknown;
  confidence?: number;
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
