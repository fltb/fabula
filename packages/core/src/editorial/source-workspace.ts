import type {
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../contracts/source.ts';
import { analyzeSource } from '../entity/source-analysis.ts';

/** Pure authored-source queries and candidate analysis over an immutable snapshot. */
export class SourceWorkspace {
  readonly snapshot: ProjectSourceSnapshotV1;

  constructor(snapshot: ProjectSourceSnapshotV1) {
    this.snapshot = snapshot;
  }

  list(): readonly SourceDocumentV1[] {
    return this.snapshot.documents;
  }

  get(logicalPath: string): SourceDocumentV1 | null {
    return this.snapshot.documents.find((document) => document.logicalPath === logicalPath) ?? null;
  }

  analyze(changes: readonly SourceChangeV1[]): SourceAnalysisV1 {
    return analyzeSource(this.snapshot, changes);
  }
}
