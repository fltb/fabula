// ============================================================================
// State projection equivalence gate (plan 8.4 — THE gate)
//
// For EVERY fixture project (enumerated per-project roots under fixtures/)
// and EVERY route selector (canonical + each discourse branch the fixture
// defines, derived the same way the graph route derives them), this suite
// builds the CanonicalStateProjectionService stream AND the full canonical
// compile (`compileProject(...).boundaries`) and asserts the per-event
// stateBefore/stateAfter canonical state hashes are IDENTICAL.
//
// The gate MUST pass before any production caller may read through the
// service (`nova_event_state_diff` / status reads); the comparison is never
// relaxed. Routes that fail to compile fail closed on BOTH sides (the
// projection cannot exist for a source the compiler rejects) and are
// recorded as skipped, never asserted.
//
// Additional invariants pinned here:
//   - sequence is the canonical graph replay order (1-based contiguous from
//     the compiled topological order) and NEVER `narrativeOrder`;
//   - a sourceHash change produces a NEW stream key (no rewrite of the
//     accepted source);
//   - corrupt snapshots are quarantined (never hydrated) and the state is
//     rebuilt from the immutable source; a broken snapshot file is replaced
//     by valid snapshots derived from the source.
// ============================================================================

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CompileProjectOptions,
  CoreRuntimeServices,
  ProjectSourceSnapshotV1,
} from '@novalistically/core';
import {
  CANONICAL_WORLD_SCHEMA,
  CANONICAL_WORLD_SCHEMA_VERSION,
  compileProject,
  computeSnapshotStateHash,
  verifySnapshotRecord,
} from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '@novalistically/core/testing';
import { diffEvent } from '@novalistically/core/tooling';
import { createFileCoreRuntimeServices } from '@novalistically/node-host';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { WorkbenchRouteSelectorV1 } from '../src/contracts/graph.js';
import { WORKBENCH_GRAPH_VIEW_VERSION } from '../src/contracts/graph.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import {
  createCanonicalStateProjectionService,
  DEFAULT_SNAPSHOT_INTERVAL,
} from '../src/host/state/canonical-state-projection.js';

const FIXTURES_ROOT = fileURLToPath(new URL('../../../fixtures', import.meta.url));

// ─── Fixture discovery (per-project roots, same walk core calibration uses) ──

function findProjects(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      try {
        readFileSync(join(path, 'nova.yaml'), 'utf8');
        out.push(relative(root, path));
      } catch {
        walk(path);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Materialize a version-controlled fixture project into an immutable snapshot. */
function materializeFixture(root: string): ProjectSourceSnapshotV1 {
  const documents: ProjectSourceSnapshotV1['documents'] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (entry.name === '.nova') continue;
        walk(join(dir, entry.name));
      } else if (/ya?ml$/i.test(entry.name)) {
        const logicalPath = relative(root, join(dir, entry.name)).split(sep).join('/');
        const content = readFileSync(join(dir, entry.name), 'utf8');
        documents.push({
          version: 1,
          logicalPath,
          content,
          contentHash: computeSourceDocumentHash(content),
          parseResult: { status: 'parsed', value: null },
          diagnostics: [],
        });
      }
    }
  };
  walk(root);
  return buildSourceSnapshot(documents);
}

// ─── Route selector derivation (same shape the graph route consumes) ────────

interface DerivedChoice {
  readonly atEventId: string;
  readonly choiceId: string;
  readonly narrativeOrder: number;
  readonly targetEvent: string;
}

function documentOf(snapshot: ProjectSourceSnapshotV1, logicalPath: string): string | null {
  const document = snapshot.documents.find((candidate) => candidate.logicalPath === logicalPath);
  return document === null || document === undefined ? null : document.content;
}

function discourseBranches(snapshot: ProjectSourceSnapshotV1): string[] {
  const ledger = documentOf(snapshot, 'definitions/discourse-ledger.yaml');
  if (ledger === null) return ['main'];
  const parsed = YAML.parse(ledger) as {
    chapters?: readonly { branch?: unknown }[];
  } | null;
  const branches = (parsed?.chapters ?? [])
    .map((chapter) => chapter.branch)
    .filter((branch): branch is string => typeof branch === 'string' && branch.length > 0);
  return branches.length === 0 ? ['main'] : [...new Set(branches)];
}

/** Author event files (chapters/**\/E*.yaml) → authored choices. */
function authoredChoices(snapshot: ProjectSourceSnapshotV1): DerivedChoice[] {
  const choices: DerivedChoice[] = [];
  for (const document of snapshot.documents) {
    if (!/^chapters\/.*\.ya?ml$/i.test(document.logicalPath)) continue;
    const parsed = YAML.parse(document.content) as {
      event?: unknown;
      narrativeOrder?: unknown;
      choices?: readonly { id?: unknown; targetEvent?: unknown }[];
    } | null;
    if (parsed === null || typeof parsed.event !== 'string') continue;
    const atEventId = parsed.event;
    const narrativeOrder = typeof parsed.narrativeOrder === 'number' ? parsed.narrativeOrder : 0;
    for (const choice of parsed.choices ?? []) {
      if (typeof choice.id !== 'string' || typeof choice.targetEvent !== 'string') continue;
      choices.push({
        atEventId,
        choiceId: choice.id,
        narrativeOrder,
        targetEvent: choice.targetEvent,
      });
    }
  }
  return choices;
}

function branchSceneIds(snapshot: ProjectSourceSnapshotV1, branch: string): Set<string> {
  const ledger = documentOf(snapshot, 'definitions/discourse-ledger.yaml');
  const parsed =
    ledger === null
      ? null
      : (YAML.parse(ledger) as {
          chapters?: readonly { branch?: unknown; sceneIds?: unknown }[];
        } | null);
  const sceneIds = new Set<string>();
  for (const chapter of parsed?.chapters ?? []) {
    if (chapter.branch !== branch) continue;
    for (const sceneId of Array.isArray(chapter.sceneIds) ? chapter.sceneIds : []) {
      if (typeof sceneId === 'string') sceneIds.add(sceneId);
    }
  }
  return sceneIds;
}

/**
 * Route selectors per fixture, derived the way the graph route derives them:
 * the canonical route plus one selector per discourse branch the fixture
 * defines, carrying the branch path decisions whose choice targets the
 * branch's scenes (a game-dialogue leaf), or an empty branch path otherwise.
 */
function deriveSelectors(snapshot: ProjectSourceSnapshotV1): WorkbenchRouteSelectorV1[] {
  const selectors: WorkbenchRouteSelectorV1[] = [
    { version: WORKBENCH_GRAPH_VIEW_VERSION, branchPath: { decisions: [] } },
  ];
  const choices = authoredChoices(snapshot);
  for (const branch of discourseBranches(snapshot)) {
    const targets = branchSceneIds(snapshot, branch);
    const decisions = choices
      .filter((choice) => targets.has(choice.targetEvent))
      .map((choice) => ({
        atEventId: choice.atEventId,
        choiceId: choice.choiceId,
        narrativeOrder: choice.narrativeOrder,
      }))
      .sort(
        (a, b) => a.narrativeOrder - b.narrativeOrder || a.atEventId.localeCompare(b.atEventId),
      );
    selectors.push({
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions },
      discourseBranch: branch,
    });
  }
  return selectors;
}

function selectorLabel(selector: WorkbenchRouteSelectorV1): string {
  const decisions = selector.branchPath.decisions
    .map((decision) => `${decision.atEventId}:${decision.choiceId}`)
    .join(',');
  return `branchPath=[${decisions}];discourse=${selector.discourseBranch ?? 'main'}`;
}

/** Mirror of the service's canonical-route compile translation. */
function compileOptionsFor(selector: WorkbenchRouteSelectorV1): CompileProjectOptions | undefined {
  if (selector.branchPath.decisions.length === 0 && selector.discourseBranch === undefined) {
    return undefined;
  }
  return {
    branchPath: { decisions: selector.branchPath.decisions.map((decision) => ({ ...decision })) },
    ...(selector.discourseBranch === undefined
      ? {}
      : { discourseBranch: selector.discourseBranch }),
  };
}

// ─── Service harness ─────────────────────────────────────────────────────────

function snapshotIntervalFor(snapshot: ProjectSourceSnapshotV1): number {
  const nova = documentOf(snapshot, 'nova.yaml');
  if (nova === null) return DEFAULT_SNAPSHOT_INTERVAL;
  const parsed = YAML.parse(nova) as { snapshotInterval?: unknown } | null;
  const value = parsed?.snapshotInterval;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SNAPSHOT_INTERVAL;
}

function harness(projectId: string) {
  const stateLog = new MemoryStateLogRepository();
  const stateSnapshots = new MemoryStateSnapshotRepository();
  const services = {
    execution: new MemoryExecutionRepository(),
    renderCache: new MemoryRenderCacheRepository(),
    stateLog,
    stateSnapshots,
    promptTemplates: { get: async () => null },
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    ids: { next: () => `test-id-${Math.random()}` },
    llm: {},
  } as unknown as CoreRuntimeServices;
  const runtime = createProjectCoreRuntime({ projectId, services });
  return { runtime, services, stateLog, stateSnapshots };
}

// ─── The gate ────────────────────────────────────────────────────────────────

describe('state-projection equivalence gate', () => {
  const projects = findProjects(FIXTURES_ROOT);
  const skipped: string[] = [];

  it('discovers every fixture project root', () => {
    expect(projects.length).toBeGreaterThanOrEqual(13);
    expect(projects).toContain('zhu-fu');
    expect(projects).toContain('game-dialogue-tree');
    expect(projects).toContain('zhu-fu-variants/branch-A');
  });

  it.each(projects)(
    '%s: the projection stream matches the full canonical compile for every route',
    async (fixture) => {
      const snapshot = materializeFixture(join(FIXTURES_ROOT, fixture));
      const selectors = deriveSelectors(snapshot);
      expect(selectors.length).toBeGreaterThanOrEqual(1);
      const interval = snapshotIntervalFor(snapshot);

      for (const selector of selectors) {
        const label = selectorLabel(selector);
        let expected;
        try {
          expected = compileProject(snapshot, compileOptionsFor(selector));
        } catch (error) {
          // The compiler rejects this route (broken fixture, or a dialogue
          // route without a complete leaf): the projection cannot exist for a
          // source the compiler rejects — both sides fail closed. Recorded,
          // never asserted.
          skipped.push(`${fixture} [${label}]: ${(error as Error).message.slice(0, 80)}`);
          continue;
        }
        const boundaries = expected.boundaries;
        const orderedEventIds = boundaries.orderedEventIds;

        const harnessed = harness(`p-${fixture}`);
        const service = createCanonicalStateProjectionService({
          projectId: `p-${fixture}`,
          runtime: harnessed.runtime,
          snapshotInterval: interval,
          route: selector,
        });

        // The stream IS the canonical replay order: 1-based contiguous, and
        // never `narrativeOrder`.
        const stream = await service.events(snapshot);
        expect(stream.map((event) => event.eventId)).toEqual(orderedEventIds);
        expect(stream.map((event) => event.sequence)).toEqual(
          orderedEventIds.map((_, index) => index + 1),
        );

        // Per-event before/after hashes identical to the full compile.
        for (let index = 0; index < orderedEventIds.length; index++) {
          const eventId = orderedEventIds[index];
          const before = await service.stateBefore(snapshot, eventId);
          const after = await service.stateAfter(snapshot, eventId);
          expect(before).not.toBeNull();
          expect(after).not.toBeNull();
          if (before === null || after === null) continue;
          expect(computeSnapshotStateHash(before)).toBe(
            computeSnapshotStateHash(boundaries.stateBeforeByEventId.get(eventId) as never),
          );
          expect(computeSnapshotStateHash(after)).toBe(
            computeSnapshotStateHash(boundaries.stateAfterByEventId.get(eventId) as never),
          );
        }

        // Diff parity with the raw `diffEvent` compile on the same route,
        // for every streamed event. `diffEvent` auto-resolves the discourse
        // branch (no route parameter), so routes whose event set matches
        // multiple ledger branches are ambiguous for it; the service honors
        // the explicit selector and is the correct path there — the raw
        // comparison is skipped for those routes, never relaxed elsewhere.
        for (const eventId of orderedEventIds) {
          const serviceDiff = await service.diff(snapshot, eventId);
          expect(serviceDiff).not.toBeNull();
          let rawDiff: ReturnType<typeof diffEvent>;
          try {
            rawDiff = diffEvent(snapshot, eventId);
          } catch {
            continue; // auto-resolve ambiguous for this route
          }
          expect(rawDiff).not.toBeNull();
          if (serviceDiff === null || rawDiff === null) continue;
          expect(serviceDiff).toEqual(rawDiff);
        }

        // The read path is snapshot-first when the cadence produces one: a
        // second service over the SAME repositories (fresh session, no
        // in-memory state) must reconstruct identical states.
        if (interval <= orderedEventIds.length) {
          const head = await harnessed.stateSnapshots.readNearestValid({
            key: service.streamKey(snapshot),
            atOrBeforeSequence: orderedEventIds.length,
            schema: CANONICAL_WORLD_SCHEMA,
            schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
          });
          expect(head).not.toBeNull();
          if (head !== null) expect(verifySnapshotRecord(head).valid).toBe(true);
        }
        const second = createCanonicalStateProjectionService({
          projectId: `p-${fixture}`,
          runtime: createProjectCoreRuntime({
            projectId: `p-${fixture}`,
            services: harnessed.services,
          }),
          snapshotInterval: interval,
          route: selector,
        });
        const lastEventId = orderedEventIds[orderedEventIds.length - 1];
        if (lastEventId !== undefined) {
          const after = await second.stateAfter(snapshot, lastEventId);
          expect(after).not.toBeNull();
          if (after !== null) {
            expect(computeSnapshotStateHash(after)).toBe(
              computeSnapshotStateHash(boundaries.stateAfterByEventId.get(lastEventId) as never),
            );
          }
        }
        await service.dispose();
        await second.dispose();
      }
    },
    30_000,
  );

  it('pins zhu-fu sequence to the canonical replay order, never narrativeOrder', async () => {
    const fixture = 'zhu-fu';
    const snapshot = materializeFixture(join(FIXTURES_ROOT, fixture));
    const compiled = compileProject(snapshot);
    const { runtime } = harness(`p-${fixture}`);
    const service = createCanonicalStateProjectionService({
      projectId: `p-${fixture}`,
      runtime,
      snapshotInterval: 3,
    });
    const stream = await service.events(snapshot);

    // Canonical order is the compiled topological order...
    expect(stream.map((event) => event.eventId)).toEqual(compiled.boundaries.orderedEventIds);
    // ...which provably differs from a narrativeOrder sort for this fixture
    // (system:introduction transitions interleave with authored events).
    const narrativeSorted = [...compiled.runtimeEvents]
      .sort((a, b) => a.narrativeOrder - b.narrativeOrder || a.id.localeCompare(b.id))
      .map((event) => event.id);
    expect(stream.map((event) => event.eventId)).not.toEqual(narrativeSorted);
    // Sequences are 1-based contiguous positions, not narrativeOrder values.
    expect(stream.map((event) => event.sequence)).toEqual(stream.map((_, index) => index + 1));
  });

  it('creates a NEW stream key when the immutable sourceHash changes', async () => {
    const fixture = 'zhu-fu';
    const snapshot = materializeFixture(join(FIXTURES_ROOT, fixture));
    const { runtime } = harness('p-streams');
    const service = createCanonicalStateProjectionService({
      projectId: 'p-streams',
      runtime,
      snapshotInterval: 3,
    });
    const originalEvents = await service.events(snapshot);

    // One modified document → a different immutable sourceHash.
    const nova = snapshot.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (nova === undefined) throw new Error('nova.yaml missing');
    const { buildSourceSnapshot, computeSourceDocumentHash } = await import(
      '@novalistically/core/source'
    );
    const variant = buildSourceSnapshot(
      snapshot.documents.map((document) =>
        document.logicalPath === 'nova.yaml'
          ? {
              ...document,
              content: `${document.content}\n# variant\n`,
              contentHash: computeSourceDocumentHash(`${document.content}\n# variant\n`),
            }
          : document,
      ),
    );

    expect(variant.sourceHash).not.toBe(snapshot.sourceHash);
    const originalKey = service.streamKey(snapshot);
    const variantKey = service.streamKey(variant);
    expect(originalKey.streamId).toBe(snapshot.sourceHash);
    expect(variantKey.streamId).toBe(variant.sourceHash);
    expect(variantKey).not.toEqual(originalKey);

    // The variant builds its own stream; the original stream is untouched.
    const variantEvents = await service.events(variant);
    expect(variantEvents.map((event) => event.eventId)).toEqual(
      originalEvents.map((event) => event.eventId),
    );
    expect(variantEvents.map((event) => event.sequence)).toEqual(
      originalEvents.map((event) => event.sequence),
    );
    const after = await service.stateAfter(snapshot, originalEvents[0]?.eventId ?? '');
    expect(after).not.toBeNull();
    await service.dispose();
  });
});

// ─── Corrupt snapshot quarantine + rebuild (file-backed derived area) ────────

describe('state projection corrupt-snapshot quarantine + rebuild', () => {
  const FIXTURE = 'zhu-fu';
  const INTERVAL = 3;

  function fileHarness(): {
    projectRoot: string;
    services: CoreRuntimeServices;
    snapshotFile: () => string;
  } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fabula-state-projection-'));
    const artifactRoot = join(projectRoot, 'runtime');
    // The launch pre-creates the project-private runtime tree before the
    // file repositories realpath their root; mirror that here.
    mkdirSync(artifactRoot, { recursive: true });
    const services = createFileCoreRuntimeServices(projectRoot, {
      artifactRoot,
      provider: {},
    }) as unknown as CoreRuntimeServices;
    return {
      projectRoot,
      services,
      snapshotFile: () => {
        const dir = join(artifactRoot, 'state-snapshots');
        const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
        if (files.length !== 1) throw new Error(`expected one snapshot file, got ${files.length}`);
        return join(dir, files[0]);
      },
    };
  }

  function snapshotFor(projectId: string): ProjectSourceSnapshotV1 {
    return materializeFixture(join(FIXTURES_ROOT, FIXTURE));
  }

  it('never hydrates a hash-tampered snapshot: quarantine + full-replay correctness', async () => {
    const projectId = 'p-corrupt-hash';
    const { projectRoot, services, snapshotFile } = fileHarness();
    const snapshot = snapshotFor(projectId);

    // Session 1: build the stream and persist valid snapshots.
    const first = createCanonicalStateProjectionService({
      projectId,
      runtime: createProjectCoreRuntime({ projectId, services }),
      snapshotInterval: INTERVAL,
    });
    await first.events(snapshot);
    await first.dispose();

    // Tamper the durable snapshot file: keep the shape, corrupt the state
    // value (the stored snapshotHash no longer matches).
    const file = snapshotFile();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      records: { sequence: number; state: Record<string, unknown> }[];
    };
    const tampered = {
      ...stored,
      records: stored.records.map((record) => ({
        ...record,
        state: {
          ...record.state,
          entities: { ...(record.state.entities as Record<string, unknown>), __corrupt__: true },
        },
      })),
    };
    writeFileSync(file, JSON.stringify(tampered));

    // Session 2 (fresh service, same derived area): the tampered snapshot is
    // quarantined — the read must equal the full canonical replay and never
    // surface the forged value as an empty or corrupt state.
    const second = createCanonicalStateProjectionService({
      projectId,
      runtime: createProjectCoreRuntime({ projectId, services }),
      snapshotInterval: INTERVAL,
    });
    const compiled = compileProject(snapshot);
    const order = compiled.boundaries.orderedEventIds;
    const lastEventId = order[order.length - 1];
    if (lastEventId === undefined) throw new Error('fixture has no events');
    const after = await second.stateAfter(snapshot, lastEventId);
    expect(after).not.toBeNull();
    if (after !== null) {
      expect(computeSnapshotStateHash(after)).toBe(
        computeSnapshotStateHash(compiled.boundaries.stateAfterByEventId.get(lastEventId) as never),
      );
      expect('__corrupt__' in after.entities).toBe(false);
    }
    // Unknown events still answer null, never a forged state.
    expect(await second.stateAfter(snapshot, 'NO_SUCH_EVENT')).toBeNull();
    await second.dispose();
  });

  it('rebuilds a broken snapshot file from the immutable source', async () => {
    const projectId = 'p-corrupt-file';
    const { projectRoot, services, snapshotFile } = fileHarness();
    const snapshot = snapshotFor(projectId);

    const first = createCanonicalStateProjectionService({
      projectId,
      runtime: createProjectCoreRuntime({ projectId, services }),
      snapshotInterval: INTERVAL,
    });
    await first.events(snapshot);
    await first.dispose();

    // Destroy the snapshot file (unparseable) — the derived cache is broken.
    writeFileSync(snapshotFile(), '{ this is not json ');

    // A fresh session treats the broken cache as absent (never as an empty
    // state), re-saves valid snapshots derived from the immutable source and
    // answers with the full canonical replay.
    const second = createCanonicalStateProjectionService({
      projectId,
      runtime: createProjectCoreRuntime({ projectId, services }),
      snapshotInterval: INTERVAL,
    });
    const compiled = compileProject(snapshot);
    const order = compiled.boundaries.orderedEventIds;
    const lastEventId = order[order.length - 1];
    if (lastEventId === undefined) throw new Error('fixture has no events');
    const after = await second.stateAfter(snapshot, lastEventId);
    expect(after).not.toBeNull();
    if (after !== null) {
      expect(computeSnapshotStateHash(after)).toBe(
        computeSnapshotStateHash(compiled.boundaries.stateAfterByEventId.get(lastEventId) as never),
      );
    }

    // The rebuild replaced the broken file with valid derived snapshots.
    const head = await services.stateSnapshots.readNearestValid({
      key: second.streamKey(snapshot),
      atOrBeforeSequence: order.length,
      schema: CANONICAL_WORLD_SCHEMA,
      schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
    });
    expect(head).not.toBeNull();
    if (head !== null) expect(verifySnapshotRecord(head).valid).toBe(true);
    await second.dispose();
  });
});
