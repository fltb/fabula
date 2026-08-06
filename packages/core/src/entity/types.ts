import type { RelationshipReplayContext } from '../state/relationship-replay.js';
import type { NarrativeStateBaseline, StoryBoundaries } from '../state/story-boundaries.js';
import type { BranchPath } from '../types/branch.js';
import type { EntityLookup } from '../types/entity.js';
import type { EntityCatalogContext } from '../types/entity-catalog.js';
import type {
  ChapterMetadata,
  CharacterDefinition,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EventFile,
  Fact,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
  NarrativeEvent,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  ProjectConfig,
  PropositionCatalog,
  RelationshipDeclaration,
  RelationshipTypeCatalog,
  RuleDeclaration,
  RuleTypeCatalog,
  ThreadTypeCatalog,
  TimeAnchor,
  WorldInitialState,
} from '../types/index.js';

// ============================================================================
// ProjectData — aggregate of all project file data
// ============================================================================

/**
 * Canonical source data after one strict mapper pass.
 *
 * Catalog roots and relationship/rule declaration documents are required
 * authoring inputs. No legacy relationship/rule shapes are represented here.
 */
export interface ProjectData {
  config: ProjectConfig;
  characters: CharacterDefinition[];
  locations: LocationDefinition[];
  items: ItemDefinition[];
  factions: FactionDefinition[];
  worldInitialState: WorldInitialState;
  chapters: Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>;
  timeAnchors: TimeAnchor[];
  narratorProfiles: Record<string, NarratorProfile>;
  discourseLedger: PlannedDiscourseLedger;
  narratorAssertions: Record<string, NarratorAssertion>;
  entityTypeCatalogSource: EntityTypeCatalogSource;
  threadTypeCatalog: ThreadTypeCatalog;
  propositionCatalog: PropositionCatalog;
  relationshipTypeCatalog: RelationshipTypeCatalog;
  ruleTypeCatalog: RuleTypeCatalog;
  relationshipDeclarations: RelationshipDeclaration[];
  ruleDeclarations: RuleDeclaration[];
}

// ============================================================================
// CompileProjectOptions + ProjectCompilation — canonical compilation contract
// ============================================================================

/** Route options for one canonical project compilation. */
export interface CompileProjectOptions {
  branchPath?: BranchPath;
  discourseBranch?: string;
}

/**
 * Detached snapshot of one canonical project compilation — the general
 * narrative-engine contract for "compile this project". Every array, catalog,
 * map, and state object is a structured clone taken at the API boundary;
 * mutating a returned value never affects the next call's result.
 * `entities` is a frozen plain object exposing exactly the three
 * {@link EntityLookup} methods over the detached snapshot.
 */
export interface ProjectCompilation {
  readonly data: ProjectData;
  readonly events: readonly NarrativeEvent[];
  readonly runtimeEvents: readonly NarrativeEvent[];
  readonly initialFacts: readonly Fact[];
  readonly entityTypes: EntityTypeCatalog;
  readonly entityDeclarations: EntityDeclarationCatalog;
  readonly entities: EntityLookup;
  readonly boundaries: StoryBoundaries;
  /**
   * The exact replay context the compiler threaded into this compilation —
   * the shared catalog pair, relationship declarations/types and the full
   * non-entity baseline. Detached clones, so a ReplayEngine built from them
   * reconstructs per-event world states identically to the story boundaries
   * (plan 8.1 read path: nearest verified snapshot → canonical suffix).
   */
  readonly replay: ProjectReplayContext;
}

/**
 * Replay inputs for one canonical compilation (plan 8.1). Absent optional
 * members mean the project compiles without them (no relationships/baseline).
 */
export interface ProjectReplayContext {
  /** The one shared catalog pair threaded to replay and boundary compilation. */
  readonly catalogContext: EntityCatalogContext;
  /** Canonical relationship declarations and types for fail-closed replay. */
  readonly relationshipReplayContext?: RelationshipReplayContext;
  /** Full non-entity baseline cloned for each replay/boundary reconstruction. */
  readonly baseline?: NarrativeStateBaseline;
}
