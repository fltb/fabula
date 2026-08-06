/** Canonical immutable author-source utilities (identity, analysis options, extension gate). */

export type { SourceDiagnosticV1 } from './contracts/source.js';
export type { SourceAnalysisOptions } from './entity/source-analysis.js';
export { extensionDiagnosticsForSnapshot } from './entity/source-analysis.js';
export {
  buildSourceSnapshot,
  compareLogicalPaths,
  computeSourceDocumentHash,
  computeSourceHash,
} from './source/source-identity.js';
