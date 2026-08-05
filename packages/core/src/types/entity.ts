// ============================================================================
// Novalistically — Entity, Timestamp & Fact Types
// ============================================================================

import type { ProjectData } from '../entity/types.js';
import type { BranchSet } from './branch.js';

// ——— IDs ———

export type EntityId = string;

export type EntityKind = 'character' | 'location' | 'item' | 'concept' | 'faction';

// ——— Type Reference ———

export interface EntityTypeRef {
  typeId: string;
  schemaVersion: number;
}

// ——— Runtime State ———

export type EntityRuntimeState = 'active' | 'inactive' | 'retired';

// ——— Entity ———

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  definitionFile: string;
  lifecycle: EntityRuntimeState;
  typeRef: EntityTypeRef;
  state: Record<string, unknown>;
}

// ——— Timestamp System (§7.4.16) ———

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

export type AuthoredLocatableStoryTime =
  | string
  | { at: string }
  | { after: { ref: string; amount: number; unit: TimeUnit } }
  | { offset: { amount: number; unit: TimeUnit } }
  | { chapter: number };

export type AuthoredStoryTime =
  | AuthoredLocatableStoryTime
  | {
      type: 'indeterminate';
      reason?: string;
    };

export interface AbsoluteTimestamp {
  type: 'absolute';
  value: string;
}

export interface RelativeTimestamp {
  type: 'relative';
  anchor: string;
  offset: {
    amount: number;
    unit: TimeUnit;
  };
}

export interface ChapterTimestamp {
  type: 'chapter';
  chapter: number;
}

export interface StoryOffsetTimestamp {
  type: 'offset';
  amount: number;
  unit: TimeUnit;
}

export interface IndeterminateTimestamp {
  type: 'indeterminate';
  mode: 'unspecified' | 'intentional';
  reason?: string;
}

export type LocatableStoryTimestamp =
  | AbsoluteTimestamp
  | RelativeTimestamp
  | ChapterTimestamp
  | StoryOffsetTimestamp;

/** Preserved authored expression; never use this to order graph nodes. */
export type StoryTimestamp = LocatableStoryTimestamp | IndeterminateTimestamp;

export interface TimeAnchor {
  id: string;
  at: LocatableStoryTimestamp;
  description?: string;
  significance?: string;
}

export interface InitialStoryCoordinate {
  type: 'storyTime';
  kind: 'initial';
}

export interface UnlocatedStoryCoordinate {
  type: 'storyTime';
  kind: 'unlocated';
}

export interface PointStoryCoordinate {
  type: 'storyTime';
  kind: 'point';
  clock: 'story' | 'calendar' | 'chapter';
  scalar: number;
}

export type SceneStoryCoordinate = UnlocatedStoryCoordinate | PointStoryCoordinate;
export type StoryCoordinate = InitialStoryCoordinate | SceneStoryCoordinate;
export type TemporalOrder = 'before' | 'equal' | 'after' | 'incomparable';

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
  /**
   * Comparison operator for precondition evaluation:
   * - 'eq' / 'neq' / 'gt' / 'gte' / 'lt' / 'lte' / 'contains' / 'not_contains' require a value
   * - 'exists' / 'not_exists' check attribute presence/absence (no value)
   * Omitted defaults to 'eq' when value is present.
   */
  operator?:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'not_contains'
    | 'exists'
    | 'not_exists';
  validity: FactValidity;
}

export interface FactValidity {
  temporal: { start: StoryTimestamp; end: StoryTimestamp | null };
  branches: BranchSet;
}

// ——— Entity Registry (§7.4.14) ———

export interface EntityRegistry {
  /**
   * Load entities from already-loaded ProjectData (never loads the project
   * itself — the canonical kernel owns the single loadProject call).
   * `deferredIntroductionIds` are entities whose activation is authored as an
   * event `introduces` boundary.
   */
  load: (data: ProjectData, deferredIntroductionIds?: readonly string[]) => void;
  resolve: (id: EntityId) => Entity | null;
  findByKind: (kind: EntityKind) => Entity[];
  findByAttribute: (attribute: string, value: unknown) => Entity[];
  resolveRefs: (refs: EntityId[]) => Map<EntityId, Entity | null>;
  register: (entity: Entity) => void;
  updateState: (id: EntityId, state: Record<string, unknown>) => void;
  getAll: () => Entity[];
}
// ——— Read-only Entity Lookup (public contract) ———

/**
 * Read-only capability boundary over the entity model for the general
 * narrative-engine contract. Exposes only resolution and listing — no load,
 * register, or state mutation. Validators and consumers receive this surface
 * instead of the mutable registry.
 */
export interface EntityLookup {
  resolve(id: EntityId): Entity | null;
  findByKind(kind: EntityKind): readonly Entity[];
  getAll(): readonly Entity[];
}
