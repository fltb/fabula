import { describe, expect, it } from 'vitest';
import type { ProjectSourceSnapshotV1 } from '../../src/contracts/source.ts';
import {
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
} from '../../src/editorial/facade.ts';
import {
  editorialMutationContextSchema,
  editorialRenderRequestV1Schema,
  sceneSelectorSchema,
} from '../../src/schemas/editorial.ts';

const HASH = 'a'.repeat(64);

function snapshot(): ProjectSourceSnapshotV1 {
  return {
    version: 1,
    sourceHash: HASH,
    documents: [
      {
        version: 1,
        logicalPath: 'nova.yaml',
        content: 'title: Test\n',
        contentHash: HASH,
        parseResult: { status: 'parsed', value: { title: 'Test' } },
        diagnostics: [],
      },
    ],
  };
}

describe('Editorial product boundary', () => {
  it('lists and resolves immutable source documents', () => {
    const source = snapshot();
    expect(listSourceDocuments(source)).toHaveLength(1);
    expect(getSourceDocument(source, 'nova.yaml').content).toBe('title: Test\n');
    expect(() => getSourceDocument(source, 'missing.yaml')).toThrow('Source document not found');
  });

  it('previews source changes without persistence', () => {
    const source = snapshot();
    const result = previewSourceChange(source, [
      {
        logicalPath: 'nova.yaml',
        beforeContent: 'title: Test\n',
        beforeHash: HASH,
        afterContent: 'title: Updated\n',
        afterHash: 'b'.repeat(64),
      },
    ]);
    expect(result.current.sourceHash).toBe(HASH);
    expect(result.candidate.documents[0]?.content).toBe('title: Updated\n');
    expect(result.changes).toHaveLength(1);
  });

  it('round-trips semantic request schemas', () => {
    const mutation = { operationId: '00000000-0000-0000-0000-000000000001', actorId: 'actor' };
    expect(editorialMutationContextSchema.parse(mutation)).toEqual(mutation);
    const request = {
      version: 1,
      source: snapshot(),
      selector: { type: 'all' },
      mutation,
    };
    expect(editorialRenderRequestV1Schema.parse(request)).toEqual(request);
    expect(sceneSelectorSchema.parse({ type: 'events', eventIds: ['E001'] })).toEqual({
      type: 'events',
      eventIds: ['E001'],
    });
  });
});
