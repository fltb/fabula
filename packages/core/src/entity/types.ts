import type { StoryBoundaries } from '../state/story-boundaries.js';
import type { BranchPath } from '../types/branch.js';
import type { EntityLookup } from '../types/entity.js';
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
  RelationshipDefinition,
  RuleDefinition,
  TimeAnchor,
  WorldInitialState,
} from '../types/index.js';
// ============================================================================
// ProjectData — aggregate of all project file data
// ============================================================================

export interface ProjectData {
  config: ProjectConfig | null;
  characters: CharacterDefinition[];
  relationships: RelationshipDefinition[];
  rules: RuleDefinition[];
  locations: LocationDefinition[];
  items: ItemDefinition[];
  factions: FactionDefinition[];
  worldInitialState: WorldInitialState | null;
  chapters: Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>;
  timeAnchors: TimeAnchor[];
  /** Narrator profiles from definitions/narrators/ (S6c), indexed by id. */
  narratorProfiles: Record<string, NarratorProfile>;
  /** Mandatory runtime-compiled disclosure ledger from definitions/discourse-ledger.yaml. */
  discourseLedger: PlannedDiscourseLedger;
  /** Narrator assertions from definitions/assertions/ (DISCOURSE-1), indexed by id. */
  narratorAssertions: Record<string, NarratorAssertion>;
  /**
   * Author-facing entity type catalog source from definitions/entity-types.yaml.
   * Serialized source only — never a live Zod object. Compiled fresh per call
   * via compileEntityTypeCatalog (internal entity module).
   */
  entityTypeCatalogSource: EntityTypeCatalogSource;
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
}
