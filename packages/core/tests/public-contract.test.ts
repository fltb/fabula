import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../dist/index.js', import.meta.url).href;
const schemaUrl = new URL('../src/schema.ts', import.meta.url).href;
const extensionsUrl = new URL('../dist/extensions.js', import.meta.url).href;
const editorialUrl = new URL('../dist/editorial.js', import.meta.url).href;
const toolingUrl = new URL('../dist/tooling.js', import.meta.url).href;
const testingUrl = new URL('../dist/testing.js', import.meta.url).href;

describe('Core public runtime contract', () => {
  it('exports exactly the approved root runtime values', async () => {
    const root = await import(rootUrl);

    expect(Object.keys(root).sort()).toEqual([
      'LLMError',
      'NovalisticallyError',
      'compareFact',
      'compileProject',
      'getProjectStatus',
      'listEntities',
      'resolveTemporalContext',
      'sanitizeError',
      'showEntity',
      'validateNovel',
    ]);
  });

  it('keeps runtime values on their assigned entry points', async () => {
    const [root, schema, extensions, editorial, tooling, testing] = await Promise.all([
      import(rootUrl),
      import(schemaUrl),
      import(extensionsUrl),
      import(editorialUrl),
      import(toolingUrl),
      import(testingUrl),
    ]);
    const namespaces = [root, schema, extensions, editorial, tooling, testing];

    for (const name of [
      'initializeProject',
      'EntityMapper',
      'StateManager',
      'AiSdkProvider',
      'ResultAggregator',
      'TimelineValidator',
      'buildLogicalKeyMaterial',
      'MockProvider',
    ]) {
      expect(root).not.toHaveProperty(name);
    }

    expect(testing).toHaveProperty('MockProvider');
    expect(testing).toHaveProperty('MockPass2Provider');
    expect(tooling).toHaveProperty('ResultAggregator');
    expect(tooling).toHaveProperty('buildLogicalKeyMaterial');
    expect(editorial).toHaveProperty('renderNovel');
    expect(schema).toHaveProperty('analysisResultSchema');
    expect(schema).toHaveProperty('projectSourceSnapshotV1Schema');
    expect(schema).toHaveProperty('sourceAnalysisV1Schema');
    expect(schema).toHaveProperty('sourceChangeV1Schema');
    expect(schema).toHaveProperty('sourceDiagnosticV1Schema');
    expect(schema).toHaveProperty('sourceDocumentV1Schema');
    expect(schema).toHaveProperty('sourceParseResultV1Schema');
    expect(testing).toHaveProperty('MemoryExecutionRepository');
    expect(testing).toHaveProperty('MemoryRenderCacheRepository');
    expect(testing).toHaveProperty('MemoryStateLogRepository');
    expect(testing).toHaveProperty('MemoryStateSnapshotRepository');
    expect(Object.keys(extensions)).toHaveLength(0);

    for (const name of [
      'EntityMapper',
      'StateManager',
      'initializeProject',
      'TimelineValidator',
    ]) {
      for (const namespace of namespaces) {
        expect(namespace).not.toHaveProperty(name);
      }
    }
  });
});
