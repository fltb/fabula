import { describe, expect, it } from 'vitest';
import type { ProjectSourceSnapshotV1 } from '../../src/contracts/source.ts';
import {
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
} from '../../src/editorial/facade.ts';
import { QueryService } from '../../src/editorial/query-service.ts';
import { SourceWorkspace } from '../../src/editorial/source-workspace.ts';
import { analyzeSource } from '../../src/entity/source-analysis.ts';

const snapshot: ProjectSourceSnapshotV1 = {
  version: 1,
  sourceHash: 'a'.repeat(64),
  documents: [
    {
      version: 1,
      logicalPath: 'nova.yaml',
      content: 'name: test\n',
      contentHash: 'b'.repeat(64),
      parseResult: { status: 'parsed', value: { name: 'test' } },
      diagnostics: [],
    },
  ],
};

describe('snapshot source facade', () => {
  it('lists and gets immutable source documents', () => {
    expect(listSourceDocuments(snapshot)).toEqual(snapshot.documents);
    expect(getSourceDocument(snapshot, 'nova.yaml')).toEqual(snapshot.documents[0]);
    expect(new SourceWorkspace(snapshot).get('missing.yaml')).toBeNull();
  });

  it('returns a pure candidate analysis without mutation', () => {
    const changes = [
      {
        logicalPath: 'nova.yaml',
        beforeContent: 'name: test\n',
        beforeHash: 'b'.repeat(64),
        afterContent: 'name: changed\n',
        afterHash: null,
      },
    ];
    const result = previewSourceChange(snapshot, changes);
    expect(result.current).toBe(snapshot);
    expect(result.candidate.documents[0].content).toBe('name: changed\n');
    expect(snapshot.documents[0].content).toBe('name: test\n');
    expect(analyzeSource(snapshot, changes).candidate.sourceHash).toBe(result.candidate.sourceHash);
  });

  it('exposes the same value contract through QueryService', () => {
    const service = new QueryService(snapshot);
    expect(service.listSources()).toEqual({ ok: true, data: snapshot.documents });
    expect(service.getSource('missing')).toMatchObject({ ok: false });
  });
});
