import type {
  ChapterMetadata,
  CharacterDefinition,
  EntityTypeCatalogSource,
  EventFile,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
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
