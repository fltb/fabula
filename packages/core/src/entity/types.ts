import type {
  CharacterDefinition,
  CharacterRelationshipDef,
  ChapterMetadata,
  EventFile,
  FactionDefinition,
  ItemDefinition,
  LocationDefinition,
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
  relationships: CharacterRelationshipDef[];
  rules: RuleDefinition[];
  locations: LocationDefinition[];
  items: ItemDefinition[];
  factions: FactionDefinition[];
  worldInitialState: WorldInitialState | null;
  chapters: Map<number, { metadata: ChapterMetadata | null; events: EventFile[] }>;
  timeAnchors: TimeAnchor[];
}
