import type {
  CharacterDefinition,
  RelationshipDefinition,
  ChapterMetadata,
  EventFile,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  ProjectConfig,
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
  /** Planned discourse ledger from definitions/discourse-ledger.yaml (DISCOURSE-1), null when absent. */
  discourseLedger: PlannedDiscourseLedger | null;
  /** Narrator assertions from definitions/assertions/ (DISCOURSE-1), indexed by id. */
  narratorAssertions: Record<string, NarratorAssertion>;
}
