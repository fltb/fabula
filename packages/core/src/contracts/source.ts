import type { JsonValue } from './json.js';

export type SourceDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface SourceDiagnosticV1 {
  readonly code: string;
  readonly severity: SourceDiagnosticSeverity;
  readonly message: string;
  readonly logicalPath: string | null;
}

export type SourceParseStatusV1 = 'parsed' | 'invalid' | 'not_applicable';

export interface SourceParseResultV1 {
  readonly status: SourceParseStatusV1;
  readonly value: JsonValue | null;
}

export interface SourceDocumentV1 {
  readonly version: 1;
  readonly logicalPath: string;
  readonly content: string;
  readonly contentHash: string;
  readonly parseResult: SourceParseResultV1;
  readonly diagnostics: readonly SourceDiagnosticV1[];
}

/** Immutable materialized author source. sourceHash is content identity only;
 * it is not a Git revision, path, actor, timestamp, or persistence head. */
export interface ProjectSourceSnapshotV1 {
  readonly version: 1;
  /** Canonical logical-POSIX documents, sorted by logicalPath. */
  readonly documents: readonly SourceDocumentV1[];
  /** Canonical hash of logical paths and bytes; equal bytes produce equal identity. */
  readonly sourceHash: string;
}

export interface SourceChangeV1 {
  readonly logicalPath: string;
  readonly beforeContent: string | null;
  readonly beforeHash: string | null;
  readonly afterContent: string | null;
  readonly afterHash: string | null;
}

export interface SourceAnalysisV1 {
  readonly version: 1;
  readonly current: ProjectSourceSnapshotV1;
  readonly candidate: ProjectSourceSnapshotV1;
  readonly changes: readonly SourceChangeV1[];
  readonly affectedEventIds: readonly string[];
  readonly diagnostics: readonly SourceDiagnosticV1[];
}
