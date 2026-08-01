// ============================================================================
// Canonical project kernel — focused contract test.
//
// loadCanonicalProject is package-private by design: it is imported directly
// (never through entity/index.ts or the core root), executes at most one
// EntityMapper.loadProject() per uncached authored source, returns fresh
// mutable objects per call, and composes system:introduction transitions
// immediately before their authored target events.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import * as entityIndex from '../../src/entity/index.js';
import { compileCanonicalRuntime, loadCanonicalProject } from '../../src/entity/project-runtime.js';
import { FsStorage } from '../../src/storage/index.js';
import type { Fact, NarrativeEvent } from '../../src/types/index.js';

// ─── Fixture setup ──────────────────────────────────────────────────────────

const FIXTURE = path.resolve(__dirname, '..', '..', '..', '..', 'fixtures', 'zhu-fu');

const tempDirs: string[] = [];

/** A Storage that counts read() calls per path (hash + load both read). */
class CountingStorage extends FsStorage {
  readonly readCounts = new Map<string, number>();
  totalReads = 0;

  override read(filePath: string): string {
    this.totalReads += 1;
    this.readCounts.set(filePath, (this.readCounts.get(filePath) ?? 0) + 1);
    return super.read(filePath);
  }
}

/** Copy the zhu-fu fixture and add a definition-less introduction to E0. */
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-kernel-'));
  tempDirs.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const e0Path = path.join(dir, 'chapters', 'chapter_01', 'E0_encounter.yaml');
  const e0 = fs.readFileSync(e0Path, 'utf-8');
  const anchor = '      social_mood: festive_busy';
  const extended = e0.replace(
    anchor,
    `${anchor}\n  - type: character\n    id: mysterious_stranger\n    initialState:\n      age: "30"`,
  );
  if (extended === e0) throw new Error(`fixture anchor not found in ${e0Path}: ${anchor}`);
  fs.writeFileSync(e0Path, extended);
  return dir;
}
/** Reduce the fixture to E0 so unrelated flashback reads cannot mask activation timing. */
function makeSingleEventProject(): string {
  const dir = makeTempProject();
  const chapterDir = path.join(dir, 'chapters', 'chapter_01');
  for (const fileName of fs.readdirSync(chapterDir)) {
    if (/^E[1-6].*\.yaml$/.test(fileName)) {
      fs.rmSync(path.join(chapterDir, fileName));
    }
  }
  // E6 is the authored provider of `xianglins_wife.status = beggar`, which
  // E0's deterministic preconditions require. Deleting E1–E6 removes that
  // provider, so restore it as authored initial state to keep every E0
  // precondition resolvable in the one-event project.
  const wifePath = path.join(dir, 'definitions', 'characters', 'xianglins_wife.yaml');
  const wife = YAML.parse(fs.readFileSync(wifePath, 'utf-8')) as Record<string, unknown>;
  wife.initialState = { status: 'beggar' };
  fs.writeFileSync(wifePath, YAML.stringify(wife));
  const ledgerPath = path.join(dir, 'definitions', 'discourse-ledger.yaml');
  const ledger = YAML.parse(fs.readFileSync(ledgerPath, 'utf-8')) as {
    chapters: Array<{ sceneIds: string[] }>;
    entries: Array<{ sceneId: string }>;
  };
  for (const chapter of ledger.chapters) chapter.sceneIds = ['E0'];
  ledger.entries = ledger.entries.filter((entry) => entry.sceneId === 'E0');
  fs.writeFileSync(ledgerPath, YAML.stringify(ledger));
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Kernel contract ────────────────────────────────────────────────────────

describe('loadCanonicalProject — canonical kernel', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  it('executes one loadProject per uncached source; cache hits skip the load', () => {
    const storage = new CountingStorage();
    const ir1 = loadCanonicalProject(projectDir, storage);
    const readsAfterFirst = storage.totalReads;

    const ir2 = loadCanonicalProject(projectDir, storage);
    const readsAfterSecond = storage.totalReads;

    // Same storage + unchanged content → cache hit: the character definition
    // is read exactly 3 times (hash, load, hash) instead of 4 (hash, load, hash, load).
    const charFile = path.join(projectDir, 'definitions', 'characters', 'xianglins_wife.yaml');
    expect(storage.readCounts.get(charFile)).toBe(3);
    expect(readsAfterSecond - readsAfterFirst).toBeLessThan(readsAfterFirst);

    // Cache hit still rebuilds every mutable object fresh.
    expect(ir2.sourceHash).toBe(ir1.sourceHash);
    expect(ir2.data).not.toBe(ir1.data);
    expect(ir2.authoredEvents).not.toBe(ir1.authoredEvents);
    expect(ir2.registry).not.toBe(ir1.registry);
    expect(ir2.entityDeclarations).not.toBe(ir1.entityDeclarations);
    expect(ir2.entityTypes).not.toBe(ir1.entityTypes);
  });

  it('never synthesizes a genesis event or a second load, and stays package-private', () => {
    const ir = loadCanonicalProject(projectDir, new FsStorage());

    expect(ir.runtimeEvents.some((event) => event.id === 'system:genesis')).toBe(false);
    expect(ir.authoredEvents.some((event) => event.id === 'system:genesis')).toBe(false);
    expect(ir.entityDeclarations.declarations['system:genesis']).toBeUndefined();

    // Package-private: not exported from the entity barrel or the core root.
    expect('loadCanonicalProject' in entityIndex).toBe(false);
    expect('compileCanonicalRuntime' in entityIndex).toBe(false);
  });

  it('preserves the authored target and groups its introduction transitions immediately before it', () => {
    const ir = loadCanonicalProject(projectDir, new FsStorage());

    const e0 = ir.authoredEvents.find((event) => event.id === 'E0');
    expect(e0).toBeDefined();
    // The exact authored object appears in runtimeEvents (no copy).
    expect(ir.runtimeEvents.includes(e0!)).toBe(true);

    const transitions = ir.runtimeEvents.filter((event) =>
      event.id.startsWith('system:introduction:E0:'),
    );
    expect(transitions).toHaveLength(e0!.introduces?.length ?? 0);
    for (const transition of transitions) {
      expect(transition.narrativeOrder).toBe(e0!.narrativeOrder - 0.5);
      expect(transition.storyTime).toEqual(e0!.storyTime);
      expect(transition.branchExistence).toEqual(e0!.branchExistence);
    }
    const targetIndex = ir.runtimeEvents.indexOf(e0!);
    const transitionIndexes = transitions.map((transition) => ir.runtimeEvents.indexOf(transition));
    expect(Math.max(...transitionIndexes)).toBe(targetIndex - 1);
    expect(transitionIndexes).toEqual(
      Array.from(
        { length: transitions.length },
        (_, index) => targetIndex - transitions.length + index,
      ),
    );
  });

  it('registers definition-less introduced entities from authored data, with no fabricated path', () => {
    const ir = loadCanonicalProject(projectDir, new FsStorage());

    const stranger = ir.registry.resolve('mysterious_stranger');
    expect(stranger).not.toBeNull();
    expect(stranger!.kind).toBe('character');
    expect(stranger!.lifecycle).toBe('active');
    expect(stranger!.state).toEqual({ age: '30' });
    // The honest definition source is the hosting event file.
    expect(stranger!.definitionFile).toBe(
      path.join(projectDir, 'chapters', 'chapter_01', 'E0_encounter.yaml'),
    );

    const declaration = ir.entityDeclarations.declarations['mysterious_stranger'];
    expect(declaration).toBeDefined();
    expect(declaration!.introduction).toEqual({ type: 'event', eventId: 'E0' });
    expect(declaration!.typeRef.typeId).toBe('character');

    // Event-introduced entities never receive initial facts…
    expect(ir.initialFacts.some((fact) => fact.entityId === 'mysterious_stranger')).toBe(false);
    expect(ir.initialFacts.some((fact) => fact.entityId === 'luchen_town')).toBe(false);
    // …while initial declarations do (deterministic lifecycle derivation).
    expect(
      ir.initialFacts.some(
        (fact) =>
          fact.entityId === 'fourth_master_lu' &&
          fact.attribute === 'lifecycle' &&
          fact.value === 'active',
      ),
    ).toBe(true);
  });

  it('activates the introduced entity before its target in the compiled runtime boundaries', () => {
    const ir = loadCanonicalProject(makeSingleEventProject(), new FsStorage());
    const runtime = compileCanonicalRuntime(ir);

    const before = runtime.boundaries.stateBeforeByEventId.get('E0');
    expect(before).toBeDefined();
    expect(before!.entities['luchen_town']).toMatchObject({
      lifecycle: 'active',
      status: 'active',
      season: 'deep_winter',
      atmosphere: 'new_year_preparation',
    });
  });

  it('isolates cache entries per storage and returns fresh mutable objects', () => {
    const irA = loadCanonicalProject(projectDir, new FsStorage());
    const irB = loadCanonicalProject(projectDir, new FsStorage());

    // Different storage instances never share IR internals.
    expect(irA).not.toBe(irB);
    expect(irA.data).not.toBe(irB.data);
    expect(irA.registry).not.toBe(irB.registry);
    expect(irA.runtimeEvents[0]).not.toBe(irB.runtimeEvents[0]);
    expect(irA.entityDeclarations.declarations).not.toBe(irB.entityDeclarations.declarations);

    const bRuntimeLength = irB.runtimeEvents.length;
    const bInitialLength = irB.initialFacts.length;

    // The IR's readonly surface is compile-time only; tests mutate one IR to
    // prove the other stays pristine.
    const e0A = irA.authoredEvents.find((event) => event.id === 'E0')!;
    e0A.title = 'mutated';
    const mutableInitialFacts = irA.initialFacts as Fact[];
    mutableInitialFacts.push({ ...irA.initialFacts[0] });
    const mutableRuntimeEvents = irA.runtimeEvents as NarrativeEvent[];
    mutableRuntimeEvents.push(irA.runtimeEvents[0]);
    irA.registry.register({
      id: 'transient',
      kind: 'character',
      name: 'Transient',
      definitionFile: 'transient.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: {},
    });

    expect(irB.authoredEvents.find((event) => event.id === 'E0')!.title).not.toBe('mutated');
    expect(irB.runtimeEvents.length).toBe(bRuntimeLength);
    expect(irB.initialFacts.length).toBe(bInitialLength);
    expect(irB.registry.resolve('transient')).toBeNull();
  });

  it('keeps the source hash stable per content and invalidates on authored change', () => {
    const storage = new CountingStorage();
    const ir1 = loadCanonicalProject(projectDir, storage);
    const ir2 = loadCanonicalProject(projectDir, storage);
    expect(ir2.sourceHash).toBe(ir1.sourceHash);

    // Touch an authored file: the next load re-hashes, reloads, and re-derives.
    fs.appendFileSync(
      path.join(projectDir, 'chapters', 'chapter_01', 'E0_encounter.yaml'),
      '\n# touched\n',
    );
    const ir3 = loadCanonicalProject(projectDir, storage);
    expect(ir3.sourceHash).not.toBe(ir1.sourceHash);

    const charFile = path.join(projectDir, 'definitions', 'characters', 'xianglins_wife.yaml');
    // hash(1) + load(1) + hash(2) + hash(3) + load(3) = 5 reads.
    expect(storage.readCounts.get(charFile)).toBe(5);
  });
});
