import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../contracts/source.ts';

export interface EditorialWorkspaceSnapshotV1 {
  readonly version: 1;
  readonly sourceHash: string;
  readonly documents: readonly SourceDocumentV1[];
}

/** Read-only value facade over an already materialized authored-source snapshot. */
export class EditorialWorkspace {
  constructor(readonly snapshot: ProjectSourceSnapshotV1) {}

  listSources(): readonly SourceDocumentV1[] {
    return this.snapshot.documents;
  }

  getSource(logicalPath: string): SourceDocumentV1 | null {
    return this.snapshot.documents.find((document) => document.logicalPath === logicalPath) ?? null;
  }

  snapshotValue(): EditorialWorkspaceSnapshotV1 {
    return { version: 1, sourceHash: this.snapshot.sourceHash, documents: this.snapshot.documents };
  }
}

export function getEditorialWorkspace(snapshot: ProjectSourceSnapshotV1): EditorialWorkspace {
  return new EditorialWorkspace(snapshot);
}
