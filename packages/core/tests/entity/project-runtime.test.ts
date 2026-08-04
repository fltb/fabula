import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import * as entityIndex from '../../src/entity/index.js';
import { compileCanonicalRuntime, loadCanonicalProject } from '../../src/entity/project-runtime.js';
import { ConfigError } from '../../src/errors.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function makeSnapshot(entries: Record<string, string>): ProjectSourceSnapshotV1 {
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: hash(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: hash(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
}
function snapshot(title = 'Test'): ProjectSourceSnapshotV1 {
  const entries: Record<string, string> = {
    'nova.yaml': `project: test\ntitle: ${title}\nauthor: Test\ndefaultLanguage: en\ndefaultModel: mock-pass2\n`,
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: [[active, inactive], [active, retired], [inactive, active], [inactive, retired]]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []',
    'definitions/state_initial.yaml':
      'info: { currentEra: contemporary, politicalSituation: stable }\ntimeAnchors: [{ id: day_1, at: day_1 }]\nthreads: []\nworldFacts: []\n',
    'definitions/discourse-ledger.yaml':
      'id: ledger\nchapters: [{ branch: main, chapter: 1, sceneIds: [E0] }]\nentries: []\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Chapter 1\nsummary: Test\nintent: Introduction\nplannedScenes: 1\n',
    'chapters/chapter_01/E0.yaml':
      'event: E0\nnarrativeOrder: 1\ntitle: Encounter\nstoryTime: day_1\npov: { character: narrator, type: first_person }\nsceneBrief: A test scene.\nbeats: [A test scene.]\npreconditions: []\nexpectedPostconditions: []\n',
  };
  return makeSnapshot(entries);
}

describe('loadCanonicalProject — canonical kernel', () => {
  it('caches by immutable sourceHash while rebuilding mutable objects', () => {
    const source = snapshot();
    const ir1 = loadCanonicalProject(source);
    const ir2 = loadCanonicalProject(source);
    expect(ir2.sourceHash).toBe(ir1.sourceHash);
    expect(ir2.data).not.toBe(ir1.data);
    expect(ir2.authoredEvents).not.toBe(ir1.authoredEvents);
    expect(ir2.registry).not.toBe(ir1.registry);
    expect(ir2.entityDeclarations).not.toBe(ir1.entityDeclarations);
  });
  it('reuses one runtime for byte-identical snapshots regardless of object identity', () => {
    // Distinct snapshot objects with identical normalized bytes share one
    // sourceHash — memoization is content-keyed, never object-identity-keyed,
    // and never carries host/Git provenance.
    const first = snapshot();
    const second = snapshot();
    expect(second.sourceHash).toBe(first.sourceHash);
    const ir1 = loadCanonicalProject(first);
    const ir2 = loadCanonicalProject(second);
    expect(ir2.sourceHash).toBe(ir1.sourceHash);
    // Every call receives fresh mutable objects, never cached internals.
    expect(ir2.data).not.toBe(ir1.data);
    expect(ir2.authoredEvents).not.toBe(ir1.authoredEvents);
    expect(ir2.registry).not.toBe(ir1.registry);
    // Identical bytes ⇒ identical compiled runtime semantics.
    expect(ir2.data.config?.title).toBe(ir1.data.config?.title);
    expect(ir2.authoredEvents.map((event) => event.id)).toEqual(
      ir1.authoredEvents.map((event) => event.id),
    );
    expect(ir2.runtimeEvents.map((event) => event.id)).toEqual(
      ir1.runtimeEvents.map((event) => event.id),
    );
    // Mutating one call's output cannot leak into the cached entry.
    const firstEvent = ir1.authoredEvents[0];
    if (firstEvent === undefined) {
      throw new Error('expected at least one authored event');
    }
    firstEvent.title = 'mutated';
    expect(ir2.authoredEvents[0]?.title).not.toBe('mutated');
  });
  it('rebuilds when one relevant authored source byte changes', () => {
    const base = snapshot();
    const irA = loadCanonicalProject(base);
    const entries = Object.fromEntries(
      base.documents.map((document) => [document.logicalPath, document.content]),
    );
    entries['chapters/chapter_01/E0.yaml'] = entries['chapters/chapter_01/E0.yaml']?.replace(
      'title: Encounter',
      'title: Encounter!',
    );
    const changed = makeSnapshot(entries);
    expect(changed.sourceHash).not.toBe(base.sourceHash);
    const irB = loadCanonicalProject(changed);
    const e0 = irA.authoredEvents.find((event) => event.id === 'E0');
    const e0Changed = irB.authoredEvents.find((event) => event.id === 'E0');
    if (e0 === undefined || e0Changed === undefined) {
      throw new Error('expected E0 in both runtimes');
    }
    expect(e0Changed.title).toBe('Encounter!');
    expect(e0Changed.title).not.toBe(e0.title);
    // The unchanged bytes still resolve to the original runtime (no poisoning).
    expect(
      loadCanonicalProject(base).authoredEvents.find((event) => event.id === 'E0')?.title,
    ).toBe('Encounter');
  });
  it('never caches a failed mapping and ignores diagnostics for cache identity', () => {
    const valid = snapshot();
    loadCanonicalProject(valid);
    // A malformed document fails during mapping — before any cache write.
    const badEntries = Object.fromEntries(
      valid.documents.map((document) => [document.logicalPath, document.content]),
    );
    badEntries['definitions/state_initial.yaml'] = 'info: [unclosed';
    const bad = makeSnapshot(badEntries);
    expect(bad.sourceHash).not.toBe(valid.sourceHash);
    expect(() => loadCanonicalProject(bad)).toThrow(ConfigError);
    // A failed mapping is never cached: reloading the same bad bytes fails again.
    expect(() => loadCanonicalProject(bad)).toThrow(ConfigError);
    // The valid runtime was not poisoned by the failed candidate.
    expect(
      loadCanonicalProject(valid).authoredEvents.find((event) => event.id === 'E0')?.title,
    ).toBe('Encounter');
    // Diagnostics on identical bytes do not alter identity or compiled output.
    const noisy: ProjectSourceSnapshotV1 = {
      version: 1,
      sourceHash: valid.sourceHash,
      documents: valid.documents.map((document) => ({
        ...document,
        diagnostics: [
          {
            code: 'noise',
            severity: 'warning',
            message: 'noise',
            logicalPath: document.logicalPath,
          },
        ],
      })),
    };
    expect(noisy.sourceHash).toBe(valid.sourceHash);
    expect(
      loadCanonicalProject(noisy).authoredEvents.find((event) => event.id === 'E0')?.title,
    ).toBe('Encounter');
  });
  it('never synthesizes genesis and stays package-private', () => {
    const ir = loadCanonicalProject(snapshot());
    expect(ir.runtimeEvents.some((event) => event.id === 'system:genesis')).toBe(false);
    expect(ir.authoredEvents.some((event) => event.id === 'system:genesis')).toBe(false);
    expect('loadCanonicalProject' in entityIndex).toBe(false);
    expect('compileCanonicalRuntime' in entityIndex).toBe(false);
  });
  it('preserves authored targets and runtime boundaries', () => {
    const ir = loadCanonicalProject(snapshot());
    const e0 = ir.authoredEvents.find((event) => event.id === 'E0');
    expect(e0).toBeDefined();
    expect(ir.runtimeEvents.some((event) => event.id === 'E0')).toBe(true);
    const runtime = compileCanonicalRuntime(ir);
    expect(runtime.boundaries.stateBeforeByEventId.has('E0')).toBe(true);
    expect(runtime.boundaries.stateAfterByEventId.has('E0')).toBe(true);
  });
  it('isolates cache entries and invalidates on changed sourceHash', () => {
    const irA = loadCanonicalProject(snapshot());
    const irB = loadCanonicalProject(snapshot());
    expect(irA).not.toBe(irB);
    expect(irA.data).not.toBe(irB.data);
    expect(irA.registry).not.toBe(irB.registry);
    const e0 = irA.authoredEvents.find((event) => event.id === 'E0');
    if (e0 === undefined) {
      throw new Error('expected E0 in the first runtime');
    }
    e0.title = 'mutated';
    const cachedE0 = irB.authoredEvents.find((event) => event.id === 'E0');
    if (cachedE0 === undefined) throw new Error('expected E0 in the cached runtime');
    expect(cachedE0.title).not.toBe('mutated');
    const changed = loadCanonicalProject(snapshot('Changed'));
    expect(changed.sourceHash).not.toBe(irA.sourceHash);
  });
});

describe('wall-clock determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compiles identical canonical projects under different wall clocks', () => {
    const source = snapshot();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const early = loadCanonicalProject(source);
    vi.setSystemTime(new Date('2026-08-02T03:04:05.000Z'));
    const late = loadCanonicalProject(source);
    expect(late.authoredEvents).toEqual(early.authoredEvents);
    expect(late.runtimeEvents).toEqual(early.runtimeEvents);
    expect(late.initialFacts).toEqual(early.initialFacts);
    expect(late.initialThreads).toEqual(early.initialThreads);
    expect(late.registry).toEqual(early.registry);
    expect(late.entityDeclarations).toEqual(early.entityDeclarations);
    expect(late.chapterByEventId).toEqual(early.chapterByEventId);
    // The runtime catalog carries executable Zod schemas; compare their
    // JSON-serialized form — identical construction yields identical identity.
    expect(JSON.stringify(late.entityTypes)).toBe(JSON.stringify(early.entityTypes));
    expect(JSON.stringify(late.catalogContext)).toBe(JSON.stringify(early.catalogContext));
  });
});
