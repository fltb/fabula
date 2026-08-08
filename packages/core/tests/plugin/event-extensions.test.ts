// ============================================================================
// Plan 7.5 — EventFile `extensions` + PluginExtensionSchemaRegistrar
//
// 1. The strict eventFileSchema parses an `extensions` block (structural
//    JsonValue) and STILL rejects any other unknown top-level key.
// 2. PluginExtensionSchemaRegistrar: unknown/disabled namespace = source
//    error; declared schema violations = source error; schema-less enabled
//    plugins accept structural JsonValue.
// 3. analyzeSource wires the registrar: an extension for a non-enabled
//    plugin produces an error-severity diagnostic on the candidate snapshot.
// 4. Extensions ride the read-only EventFile → NarrativeEvent projection but
//    never mutate WorldState: full-project replay boundaries are identical
//    with and without extensions.
// ============================================================================

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { EntityMapper } from '../../src/entity/index.js';
import { compileCanonicalRuntime, loadCanonicalProject } from '../../src/entity/project-runtime.ts';
import { analyzeSource, type SourceAnalysisOptions } from '../../src/entity/source-analysis.ts';
import { PluginExtensionSchemaRegistrar } from '../../src/plugin/index.js';
import { eventFileSchema } from '../../src/schemas/event.js';
import { materializeFixtureSnapshot } from '../fixtures/fixture-snapshots.ts';
import { sourceEntryMap, toSourceChange, withDocument } from '../fixtures/source-snapshot.ts';

const FIXTURE_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'zhu-fu',
);
const EVENT_PATH = 'chapters/chapter_01/E0_encounter.yaml';

const BASE_EVENT = {
  event: 'E1',
  narrativeOrder: 1,
  title: 'Test Event',
  pov: { character: 'narrator', type: 'first_person' as const },
  sceneBrief: 'A scene.',
  beats: ['A beat.'],
  preconditions: [],
  expectedPostconditions: [],
};

describe('eventFileSchema extensions', () => {
  it('parses an extensions block of structural JsonValue', () => {
    const parsed = eventFileSchema.safeParse({
      ...BASE_EVENT,
      extensions: {
        'enabled-plugin': { weight: 1, tags: ['a', 'b'], nested: { ok: true } },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.extensions?.['enabled-plugin']).toEqual({
        weight: 1,
        tags: ['a', 'b'],
        nested: { ok: true },
      });
    }
  });

  it('strict() still rejects any other unknown top-level key', () => {
    const parsed = eventFileSchema.safeParse({ ...BASE_EVENT, unknownKey: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message).join('; ');
      expect(messages).toContain('unknownKey');
    }
  });

  it('rejects non-object extensions', () => {
    const parsed = eventFileSchema.safeParse({ ...BASE_EVENT, extensions: 'nope' });
    expect(parsed.success).toBe(false);
  });
});

describe('PluginExtensionSchemaRegistrar', () => {
  const registrar = new PluginExtensionSchemaRegistrar([
    { name: 'enabled-plugin', schema: z.object({ weight: z.number() }) },
    { name: 'structural-plugin' },
  ]);

  it('unknown namespace is an error-severity source error', () => {
    const diagnostics = registrar.validateExtensions({ 'ghost-plugin': {} }, EVENT_PATH, false);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_EXTENSION_NAMESPACE_UNKNOWN',
        severity: 'error',
        message: expect.stringContaining('ghost-plugin'),
        logicalPath: EVENT_PATH,
      }),
    ]);
  });

  it('disabled (unlisted) plugin namespace is a source error', () => {
    const diagnostics = registrar.validateExtensions(
      { 'swear-filter': { enabled: false } },
      EVENT_PATH,
      false,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('SOURCE_EXTENSION_NAMESPACE_UNKNOWN');
  });

  it('declared schema violation is a source error', () => {
    const diagnostics = registrar.validateExtensions(
      { 'enabled-plugin': { weight: 'heavy' } },
      EVENT_PATH,
      false,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_EXTENSION_SCHEMA_INVALID',
        severity: 'error',
        message: expect.stringContaining('enabled-plugin'),
      }),
    ]);
  });

  it('schema-less enabled plugin accepts structural JsonValue', () => {
    const diagnostics = registrar.validateExtensions(
      { 'structural-plugin': { anything: [1, true, null, { deep: 'value' }] } },
      EVENT_PATH,
      false,
    );
    expect(diagnostics).toEqual([]);
  });

  it('undefined extensions produce no diagnostics', () => {
    expect(registrar.validateExtensions(undefined, EVENT_PATH, false)).toEqual([]);
  });
});

describe('analyzeSource registrar wiring', () => {
  const snapshot = materializeFixtureSnapshot(FIXTURE_ROOT);
  const original = sourceEntryMap(snapshot)[EVENT_PATH] ?? '';

  function analyzeWith(registrar?: PluginExtensionSchemaRegistrar) {
    const change = toSourceChange(
      snapshot,
      EVENT_PATH,
      `${original}\nextensions:\n  ghost-plugin: {}\n`,
    );
    const options: SourceAnalysisOptions = registrar ? { extensionRegistrar: registrar } : {};
    return analyzeSource(snapshot, [change], options);
  }

  it('absent registrar keeps today behavior (no extension diagnostics)', () => {
    const result = analyzeWith(undefined);
    expect(result.diagnostics.some((d) => d.code.startsWith('SOURCE_EXTENSION'))).toBe(false);
  });

  it('unknown namespace is an error diagnostic on the candidate snapshot', () => {
    const result = analyzeWith(new PluginExtensionSchemaRegistrar([{ name: 'structural-plugin' }]));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_EXTENSION_NAMESPACE_UNKNOWN',
        severity: 'error',
        logicalPath: EVENT_PATH,
      }),
    );
  });

  it('enabled namespace passes cleanly', () => {
    const change = toSourceChange(
      snapshot,
      EVENT_PATH,
      `${original}\nextensions:\n  structural-plugin:\n    weight: 1\n`,
    );
    const result = analyzeSource(snapshot, [change], {
      extensionRegistrar: new PluginExtensionSchemaRegistrar([{ name: 'structural-plugin' }]),
    });
    expect(result.diagnostics.some((d) => d.code.startsWith('SOURCE_EXTENSION'))).toBe(false);
  });
});

describe('extensions never mutate state', () => {
  const snapshot = materializeFixtureSnapshot(FIXTURE_ROOT);

  it('NarrativeEvent carries extensions as a read-only projection', () => {
    const original = sourceEntryMap(snapshot)[EVENT_PATH] ?? '';
    const withExt = withDocument(
      snapshot,
      EVENT_PATH,
      `${original}\nextensions:\n  structural-plugin:\n    weight: 7\n`,
    );
    const mapper = new EntityMapper(withExt);
    const data = mapper.loadProject();
    const events = data.chapters.get(1)?.events ?? [];
    const event = events.find((candidate) => candidate.event === 'E0');
    expect(event?.extensions?.['structural-plugin']).toEqual({ weight: 7 });
  });

  it('full-project replay state is identical with and without extensions', () => {
    const original = sourceEntryMap(snapshot)[EVENT_PATH] ?? '';
    const withExt = withDocument(
      snapshot,
      EVENT_PATH,
      `${original}\nextensions:\n  structural-plugin:\n    weight: 7\n`,
    );

    const baseBoundaries = compileCanonicalRuntime(loadCanonicalProject(snapshot)).boundaries;
    const extBoundaries = compileCanonicalRuntime(loadCanonicalProject(withExt)).boundaries;

    expect(extBoundaries.stateBeforeByEventId).toEqual(baseBoundaries.stateBeforeByEventId);
    expect(extBoundaries.stateAfterByEventId).toEqual(baseBoundaries.stateAfterByEventId);
    expect(extBoundaries.finalState).toEqual(baseBoundaries.finalState);
  });
});
