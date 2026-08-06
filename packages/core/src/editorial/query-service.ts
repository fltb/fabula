import type {
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../contracts/source.ts';
import { analyzeSource, type SourceAnalysisOptions } from '../entity/source-analysis.ts';

export interface QueryResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

export class QueryService {
  constructor(private readonly snapshot: ProjectSourceSnapshotV1) {}

  listSources(): QueryResult<readonly SourceDocumentV1[]> {
    return { ok: true, data: this.snapshot.documents };
  }

  getSource(logicalPath: string): QueryResult<SourceDocumentV1> {
    const document = this.snapshot.documents.find(
      (candidate) => candidate.logicalPath === logicalPath,
    );
    return document
      ? { ok: true, data: document }
      : { ok: false, error: { code: 'SOURCE_DOCUMENT_NOT_FOUND', message: logicalPath } };
  }

  analyze(
    changes: readonly SourceChangeV1[],
    options?: SourceAnalysisOptions,
  ): QueryResult<SourceAnalysisV1> {
    return { ok: true, data: analyzeSource(this.snapshot, changes, options) };
  }
}
