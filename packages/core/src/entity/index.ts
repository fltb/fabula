// ============================================================================
// Entity — barrel exports
// ============================================================================

export type { CompareOutcome } from './compare.js';
export { compareFact } from './compare.js';
export {
  defaultEntityTypeCatalog,
  getAttributeIdsForKind,
  getTypeDefinitionByKind,
} from './default-catalog.js';
export type { CanonicalFactValue } from './fact-value.js';
export { canonicalDeepEqual, canonicalizeFactValue, isCanonicalFactValue } from './fact-value.js';
export { EntityMapper, mapToNarrativeEllipsis } from './mapper.js';
export { InMemoryEntityRegistry } from './registry.js';
export {
  compareStoryCoordinates,
  INITIAL_STORY_ROOT_ID,
  parseStoryTimestamp,
  resolveTemporalContext,
} from './timestamp.js';
export type { TemporalContext } from './timestamp.js';
export type { ProjectData } from './types.js';
export {
  loadProjectConfig,
  migrateProjectFile,
  readYamlFile,
  readYamlFilesInDir,
} from './yaml-loader.js';
