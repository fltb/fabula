// ============================================================================
// Browser Scene Map surface (plan 9.2): route registration, chapter grouping,
// per-scene summary rows, the 9.2.5 context-fingerprint stale flag, the hash
// chain, and the cross-chapter strips — exercised over a REAL compiled project
// session (memory execution + state repositories), through the actual
// GET routes mounted on a Host server.
// ============================================================================

import { createHash } from 'node:crypto';
import type {
  CoreExecutionRepository,
  CoreRuntimeServices,
  LLMProvider,
  ProjectSourceSnapshotV1,
  RenderCacheRepository,
} from '@novalistically/core';
import { compileProject } from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import {
  MemoryExecutionRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '@novalistically/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  BROWSER_PROJECT_SCENE_MAP_PATH,
  BROWSER_PROJECT_SCENE_PATH,
  BROWSER_SESSION_HEADER,
  type BrowserApiErrorV1,
  type BrowserSessionPrincipalV1,
} from '../src/contracts/browser-api.js';
import type { SceneDetailViewV1, SceneMapViewV1 } from '../src/contracts/scene.js';
import type {
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
  BrowserReadApiOptions,
  BrowserSceneMapSource,
} from '../src/host/browser-read-api.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import type { ProjectionDerivationInput, ProjectSession } from '../src/host/project-session.js';
import { createProjectSession } from '../src/host/project-session.js';
import { loadSceneDetail, loadSceneMap, sceneFingerprint } from '../src/host/scene-map-service.js';
import { createHostServer, type HostServer } from '../src/host/server.js';
import {
  type CanonicalStateProjectionService,
  createCanonicalStateProjectionService,
} from '../src/host/state/canonical-state-projection.js';

const PROJECT_ID = 'proj-scenes';
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const FINGERPRINT = 'a'.repeat(64);

const openServers: HostServer[] = [];
const trackServer = (server: HostServer): HostServer => {
  openServers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

// ─── Fixture project (two chapters, three scenes) ────────────────────────────

function fixtureEntries(): Record<string, string> {
  return {
    'nova.yaml':
      'project: scenes-fixture\ntitle: Scenes\nauthor: Test\ndefaultLanguage: en\ndefaultModel: mock\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n      emotionalState:\n        attributeId: emotionalState\n        valueType: string\n        requiredAt: never\n        writePolicy: mutable\n        unsetAllowed: true\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      knowledge:\n        attributeId: knowledge\n        valueType: string\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n      location:\n        attributeId: location\n        valueType: string\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n      role:\n        attributeId: role\n        valueType: string\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: [[active, inactive], [active, retired], [inactive, active], [inactive, retired]]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/state_initial.yaml':
      'info: { currentEra: contemporary, politicalSituation: calm }\ntimeAnchors: [{ id: day_1, at: day_1 }]\nthreads:\n  - threadId: T1\n    typeId: primary\n    name: Main thread\n    description: Main thread\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml':
      'version: 1\npropositions:\n  narrator_met_character: { kind: grounded, id: narrator_met_character, entityId: narrator, attribute: emotionalState, value: curious }\n  dialogue_happened: { kind: grounded, id: dialogue_happened, entityId: narrator, attribute: emotionalState, value: engaged }\n  flashback_revealed: { kind: grounded, id: flashback_revealed, entityId: narrator, attribute: emotionalState, value: nostalgic }\ndependencyGraph: {}\n',
    'definitions/assertions/a1.yaml':
      'id: a1\nnarrator: narrator\nproposition: narrator_met_character\npolarity: affirmative\ntype: authoritative_reveal\nstatus: asserted\nnarrationBoundary: { narratorId: narrator }\n',
    'definitions/assertions/a2.yaml':
      'id: a2\nnarrator: narrator\nproposition: dialogue_happened\npolarity: affirmative\ntype: claim\nstatus: contested\nnarrationBoundary: { narratorId: narrator }\n',
    'definitions/assertions/a3.yaml':
      'id: a3\nnarrator: narrator\nproposition: flashback_revealed\npolarity: affirmative\ntype: authoritative_reveal\nstatus: asserted\nnarrationBoundary: { narratorId: narrator }\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/narrators/narrator.yaml':
      'id: narrator\ntype: retrospective_entity\naccess: full\nassertion: constrained\ntruth: limited_knowledge\nfidelity: reliable\nsincerity: sincere\nknowledgeBoundary: present_day\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'definitions/discourse-ledger.yaml':
      'id: scenes_fixture_ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1, E2]\n  - branch: main\n    chapter: 2\n    sceneIds: [E3]\nentries:\n  - id: e1_reveal\n    action: { type: reveal, assertionId: a1, discoursePosition: 0 }\n    sceneId: E1\n    branch: main\n    discoursePosition: 0\n  - id: e2_claim\n    action: { type: claim, assertionId: a2, discoursePosition: 1 }\n    sceneId: E2\n    branch: main\n    discoursePosition: 1\n  - id: e3_reveal\n    action: { type: reveal, assertionId: a3, discoursePosition: 2 }\n    sceneId: E3\n    branch: main\n    discoursePosition: 2\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Opening\nsummary: The start\nintent: Setup\nplannedScenes: 2\n',
    'chapters/chapter_01/E1.yaml': [
      'event: E1',
      'narrativeOrder: 1',
      'title: Encounter',
      'pov: { character: narrator, type: first_person }',
      'narratorProfileRef: narrator',
      'storyTime: day_1',
      'sceneType: linear',
      'discourseMode: action',
      'emotionalValence: tension',
      'sceneBrief: A test scene.',
      'beats: [A test scene.]',
      'threadProgress:',
      '  - thread: T1',
      '    advancement: The main thread advances.',
      '    progressAfter: 1',
      '    progressTotal: 3',
      'greyLines:',
      '  - id: gl_flower',
      '    imagery: 花',
      '    nodes:',
      '      - eventId: E1',
      '        semanticAccumulation: First appearance.',
      '        narrativeOrder: 1',
      'preconditions: []',
      'expectedPostconditions:',
      '  - entity: narrator',
      '    attribute: emotionalState',
      '    value: curious',
      '',
    ].join('\n'),
    'chapters/chapter_01/E2.yaml': [
      'event: E2',
      'narrativeOrder: 2',
      'title: Dialogue',
      'pov: { character: narrator, type: first_person }',
      'narratorProfileRef: narrator',
      'storyTime: day_2',
      'sceneType: linear',
      'discourseMode: dialogue',
      'sceneBrief: A dialogue scene.',
      'beats: [A dialogue scene.]',
      'introduces:',
      '  - type: character',
      '    id: sidekick',
      '    initialState:',
      '      role: helper',
      'preconditions:',
      '  - entity: narrator',
      '    attribute: emotionalState',
      '    value: curious',
      'expectedPostconditions:',
      '  - entity: narrator',
      '    attribute: emotionalState',
      '    value: engaged',
      '',
    ].join('\n'),
    'chapters/chapter_02/_chapter.yaml':
      'chapter: 2\ntitle: Flashback\nsummary: The past\nintent: Reveal\nplannedScenes: 1\n',
    'chapters/chapter_02/E3.yaml': [
      'event: E3',
      'narrativeOrder: 3',
      'title: The Old Days',
      'pov: { character: narrator, type: first_person }',
      'narratorProfileRef: narrator',
      'storyTime: day_3',
      'sceneType: flashback',
      'sceneBrief: A flashback.',
      'beats: [A flashback.]',
      'preconditions: []',
      'expectedPostconditions: []',
      '',
    ].join('\n'),
  };
}

function buildFixtureSnapshot(): ProjectSourceSnapshotV1 {
  const entries = fixtureEntries();
  const documents = Object.entries(entries)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1 as const,
      logicalPath,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult: { status: 'parsed' as const, value: { value: content } },
      diagnostics: [],
    }));
  return buildSourceSnapshot(documents);
}

/** Authoring-layer snapshot: the compiled sources PLUS the scene-md documents
 * whose frontmatter carries the adoption context fingerprint (plan 9.2.5). */
function buildAuthoringSnapshot(): ProjectSourceSnapshotV1 {
  const entries = fixtureEntries();
  entries['scenes/E1.md'] = [
    '---',
    'context:',
    `  sceneHash: ${FINGERPRINT}`,
    '---',
    'Accepted prose for E1.',
    '',
  ].join('\n');
  entries['scenes/E2.md'] = 'Hand-edited prose for E2.\n';
  const documents = Object.entries(entries)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1 as const,
      logicalPath,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult: { status: 'parsed' as const, value: { value: content } },
      diagnostics: [],
    }));
  return buildSourceSnapshot(documents);
}
function memoryServices(execution: CoreExecutionRepository): CoreRuntimeServices {
  let sequence = 0;
  return {
    execution,
    renderCache: {} as RenderCacheRepository,
    stateLog: new MemoryStateLogRepository(),
    stateSnapshots: new MemoryStateSnapshotRepository(),
    promptTemplates: {
      async get() {
        return null;
      },
    },
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    ids: { next: (input) => `${input?.kind ?? 'id'}-${++sequence}` },
    llm: {} as LLMProvider,
  };
}

function derive(input: ProjectionDerivationInput): ProjectSession['projection'] {
  const diagnostics = input.snapshot?.documents.flatMap((document) => document.diagnostics) ?? [];
  return {
    version: 1,
    projectId: input.projectId,
    revision: input.revision,
    documents: input.snapshot?.documents.length ?? 0,
    events: input.snapshot?.documents.length ?? 0,
    rendered: 0,
    pending: 0,
    blocked: 0,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    diagnostics,
    presence: input.presence,
    generatedAt: input.generatedAt,
  };
}

interface Harness {
  readonly session: ProjectSession;
  readonly projection: CanonicalStateProjectionService;
  readonly execution: MemoryExecutionRepository;
  readonly snapshot: ProjectSourceSnapshotV1;
  readonly sceneMap: BrowserSceneMapSource;
}

async function harness(): Promise<Harness> {
  {
    const snap = buildFixtureSnapshot();
    try {
      compileProject(snap);
    } catch (e) {
      console.log('PROBE_ERR', (e as Error).message);
      console.log('PROBE_STACK', (e as Error).stack?.split('\n').slice(0, 12).join('\n'));
    }
  }

  const snapshot = buildFixtureSnapshot();
  const authoringSource = buildAuthoringSnapshot();
  const execution = new MemoryExecutionRepository();
  const runtime = createProjectCoreRuntime({
    projectId: PROJECT_ID,
    services: memoryServices(execution),
  });
  const session = createProjectSession({
    projectId: PROJECT_ID,
    runtime,
    capabilities: {
      checkGrant: async () => ({
        allowed: true as const,
        grant: {
          capabilityId: 'cap-1',
          userId: 'u-owner',
          projectId: PROJECT_ID,
          scopes: [],
          version: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    },
    audit: { record: () => undefined },
    derive,
    initialSource: snapshot,
    now: () => '2026-08-02T00:00:00.000Z',
  });
  const projection = createCanonicalStateProjectionService({
    projectId: PROJECT_ID,
    runtime,
    snapshotInterval: 10,
  });
  // Seed the accepted-scene hash chain: E1 matches its frontmatter fingerprint,
  // E2 is adopted (scene-md present) with a different committed sceneHash.
  await execution.compareAndSwapAcceptedScene({
    projectId: PROJECT_ID,
    eventId: 'E1',
    expectedVersion: null,
    value: {
      version: 1,
      projectId: PROJECT_ID,
      eventId: 'E1',
      sourceHash: snapshot.sourceHash,
      revisionId: 'rev-E1',
      prose: 'Accepted prose for E1.\n',
      proseHash: sha256('Accepted prose for E1.\n'),
      sceneHash: FINGERPRINT,
    },
  });
  await execution.compareAndSwapAcceptedScene({
    projectId: PROJECT_ID,
    eventId: 'E2',
    expectedVersion: null,
    value: {
      version: 1,
      projectId: PROJECT_ID,
      eventId: 'E2',
      sourceHash: snapshot.sourceHash,
      revisionId: 'rev-E2',
      prose: 'Hand-edited prose for E2.\n',
      proseHash: sha256('Hand-edited prose for E2.\n'),
      sceneHash: 'b'.repeat(64),
    },
  });
  // The port mirrors the launch wiring: session + projection + execution.
  const sceneMap: BrowserSceneMapSource = {
    loadSceneMap: async (projectId) => {
      if (projectId !== PROJECT_ID) return null;
      return loadSceneMap({ projectId, session, projection, execution, authoringSource });
    },
    loadSceneDetail: async (projectId, eventId) => {
      if (projectId !== PROJECT_ID) {
        return { ok: false, code: 'SCENE_UNAVAILABLE', message: 'no session' };
      }
      return loadSceneDetail({
        projectId,
        session,
        projection,
        execution,
        eventId,
        authoringSource,
        // Mirrors the launch wiring: the authoring runtime materializes the
        // working document by id; E3 simulates "no working document".
        workingContent: async (documentId) =>
          documentId === 'chapters/chapter_02/E3.yaml'
            ? null
            : (snapshot.documents.find((document) => document.logicalPath === documentId)
                ?.content ?? null),
      });
    },
  };
  return { session, projection, execution, snapshot, sceneMap };
}

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'u-owner',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function browserOptions(sceneMap: BrowserSceneMapSource): BrowserReadApiOptions {
  const resolver: BrowserPrincipalResolver = {
    resolve: async (request) => {
      const sessionId = request.headers.get(BROWSER_SESSION_HEADER);
      if (sessionId === 'expired') return { ok: false, failure: 'SESSION_EXPIRED' };
      if (sessionId !== 'session-1') return { ok: false, failure: 'SESSION_NOT_FOUND' };
      return { ok: true, principal };
    },
  };
  const authorization: BrowserProjectAuthorization = {
    canAccessProject: async (_userId, projectId) => projectId !== 'secret-project',
  };
  const catalog: BrowserProjectCatalog = {
    listProjects: async () => [
      {
        version: 1,
        projectId: PROJECT_ID,
        displayName: 'Scenes',
        createdAt: '',
        updatedAt: '',
        open: true,
      },
    ],
  };
  return { principal: resolver, authorization, catalog, sceneMap };
}

const authHeaders = { [BROWSER_SESSION_HEADER]: 'session-1' };

async function expectError(
  response: Response,
  status: number,
  code: BrowserApiErrorV1['error']['code'],
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as BrowserApiErrorV1;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

// ─── Route + projection assertions ───────────────────────────────────────────

describe('browser scene map surface (plan 9.2)', () => {
  it('registers GET /scene-map and groups scenes by chapter', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SceneMapViewV1;
    expect(body.version).toBe(1);
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.chapters.map((chapter) => chapter.chapterId)).toEqual(['chapter_01', 'chapter_02']);
    const [first, second] = body.chapters;
    expect(first?.title).toBe('Opening');
    expect(first?.summary).toBe('The start');
    expect(first?.plannedScenes).toBe(2);
    expect(first?.scenes.map((scene) => scene.eventId)).toEqual(['E1', 'E2']);
    expect(second?.title).toBe('Flashback');
    expect(second?.scenes.map((scene) => scene.eventId)).toEqual(['E3']);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('exposes per-scene summary fields including changed/intro counts', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
      { headers: authHeaders },
    );
    const body = (await res.json()) as SceneMapViewV1;
    const e1 = body.chapters[0]?.scenes.find((scene) => scene.eventId === 'E1');
    expect(e1).toMatchObject({
      title: 'Encounter',
      sceneType: 'linear',
      discourseMode: 'action',
      storyTime: 'day_1',
      coordinate: { chapter: 1, narrativeOrder: 1 },
    });
    // E1 writes narrator.knowledge → at least one changed world-state key.
    expect(e1?.changedCount).toBeGreaterThanOrEqual(1);
    // E2 introduces the sidekick character.
    const e2 = body.chapters[0]?.scenes.find((scene) => scene.eventId === 'E2');
    expect(e2?.introCount).toBe(1);
    expect(e2?.changedCount).toBeGreaterThanOrEqual(1);
    // E3 changes nothing.
    const e3 = body.chapters[1]?.scenes.find((scene) => scene.eventId === 'E3');
    expect(e3).toMatchObject({ sceneType: 'flashback', discourseMode: null });
    expect(e3?.changedCount).toBe(0);
  });

  it('computes the 9.2.5 context-fingerprint stale flag per adopted scene', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
      { headers: authHeaders },
    );
    const body = (await res.json()) as SceneMapViewV1;
    const byId = new Map(
      body.chapters.flatMap((chapter) => chapter.scenes.map((scene) => [scene.eventId, scene])),
    );
    // E1: fingerprint matches the execution-repo sceneHash → adopted · current.
    const e1 = byId.get('E1');
    expect(e1?.adoptedSceneHash).toBe(FINGERPRINT);
    expect(e1?.currentSceneHash).toBe(FINGERPRINT);
    expect(e1?.proseHash).toBe(sha256('Accepted prose for E1.\n'));
    expect(e1?.revisionId).toBe('rev-E1');
    expect(e1?.stale).toBe(false);
    expect(e1?.renderStatus).toBe('adopted_current');
    // E2: adopted (scene-md present) but no readable fingerprint → stale.
    const e2 = byId.get('E2');
    expect(e2?.adoptedSceneHash).toBeNull();
    expect(e2?.currentSceneHash).toBe('b'.repeat(64));
    expect(e2?.stale).toBe(true);
    expect(e2?.renderStatus).toBe('adopted_stale');
    // E3: never adopted.
    const e3 = byId.get('E3');
    expect(e3?.adoptedSceneHash).toBeNull();
    expect(e3?.currentSceneHash).toBeNull();
    expect(e3?.stale).toBe(false);
    expect(e3?.renderStatus).toBe('unadopted');
  });

  it('projects cross-chapter strips: threadProgress, emotional valence, grey lines', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
      { headers: authHeaders },
    );
    const body = (await res.json()) as SceneMapViewV1;
    // Thread progress: E1 advances T1 in canonical order.
    expect(body.strips.threadProgress).toHaveLength(1);
    const point = body.strips.threadProgress[0];
    expect(point?.eventId).toBe('E1');
    expect(point?.thread).toBe('T1');
    expect(point?.advancement).toBe('The main thread advances.');
    expect(typeof point?.runId).toBe('string');
    expect(point?.runId.length).toBeGreaterThan(0);
    // Thread transactions may carry a compiler-defaulted status; only
    // explicitly absent fields read as null.
    expect(point?.status ?? null).toBeDefined();
    // Emotional valence: only scenes that declare one.
    expect(body.strips.emotionalValence).toEqual([{ eventId: 'E1', valence: 'tension' }]);
    // Grey lines: cumulative appearance list.
    expect(body.strips.greyLines).toHaveLength(1);
    const line = body.strips.greyLines[0];
    expect(line?.greyLineId).toBe('gl_flower');
    expect(line?.imagery).toBe('花');
    expect(line?.appearances).toEqual([
      { eventId: 'E1', narrativeOrder: 1, semanticAccumulation: 'First appearance.' },
    ]);
  });

  it('serves the scene detail with diff, entities, graph edges, hashes and discourse', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_PATH.replace(':projectId', PROJECT_ID).replace(':eventId', 'E1'),
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SceneDetailViewV1;
    expect(body.eventId).toBe('E1');
    // Diff: narrator.knowledge written by E1.
    expect(body.diff.changed).toContain('entity:narrator');
    expect(body.diff.before['entity:narrator']).toBeDefined();
    expect(body.diff.after['entity:narrator']).toBeDefined();
    // Affected entities carry full state.
    const narrator = body.entities.find((entity) => entity.id === 'narrator');
    expect(narrator).toBeDefined();
    expect(typeof narrator?.state).toBe('object');
    // Graph position: E1 precedes E2 (E2 preconditions narrator.knowledge).
    const edge = body.graphEdges.find(
      (candidate) => candidate.predecessor === 'E1' && candidate.dependent === 'E2',
    );
    expect(edge).toBeDefined();
    // Hash chain: boundary hash identity + execution chain.
    expect(body.hashes.stateBeforeHash).toBe(body.hashes.worldStateHash);
    expect(body.hashes.sceneHash).toBe(FINGERPRINT);
    expect(body.hashes.proseHash).toBe(sha256('Accepted prose for E1.\n'));
    expect(body.hashes.sourceHash).toBe(h.snapshot.sourceHash);
    // Discourse projection: the fixture authors a ledger, so the identity is
    // the authored ledger and the assertion list reflects its E1 entries.
    expect(body.discourse.ledgerId).toBe('scenes_fixture_ledger');
    expect(body.discourse.discourseMode).toBe('action');
    expect(body.discourse.discoursePosition).toBe(0);
    expect(body.discourse.assertions.length).toBeGreaterThan(0);
    expect(body.renderStatus).toBe('adopted_current');
    expect(body.stale).toBe(false);
    // Working event YAML (plan Step 5): the scene card edits this exact text.
    expect(body.eventDocumentId).toBe('chapters/chapter_01/E1.yaml');
    expect(typeof body.eventYaml).toBe('string');
    const eventYaml = YAML.parse(body.eventYaml as string) as Record<string, unknown>;
    expect(eventYaml.event).toBe('E1');
    expect(eventYaml.title).toBe('Encounter');
    expect(eventYaml.pov).toEqual({ character: 'narrator', type: 'first_person' });
  });

  it('nulls the working event YAML when the working document is unavailable', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    // E3's working document is unavailable in the harness port.
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_PATH.replace(':projectId', PROJECT_ID).replace(':eventId', 'E3'),
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SceneDetailViewV1;
    expect(body.eventId).toBe('E3');
    // The document identity is still derivable (the event file exists); the
    // working content is not.
    expect(body.eventDocumentId).toBe('chapters/chapter_02/E3.yaml');
    expect(body.eventYaml).toBeNull();
  });

  it('404s unknown scenes and 503s when the port is absent', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const missing = await server.app.request(
      BROWSER_PROJECT_SCENE_PATH.replace(':projectId', PROJECT_ID).replace(':eventId', 'E99'),
      { headers: authHeaders },
    );
    await expectError(missing, 404, 'SCENE_NOT_FOUND');
    const unlisted = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', 'proj-b'),
      { headers: authHeaders },
    );
    await expectError(unlisted, 404, 'PROJECT_NOT_FOUND');

    const bare = trackServer(
      createHostServer({
        port: 0,
        browser: { ...browserOptions(h.sceneMap), sceneMap: undefined },
      }),
    );
    await bare.start();
    const unavailable = await bare.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
      { headers: authHeaders },
    );
    // Without the sceneMap port the route is not mounted: an unknown route.
    expect(unavailable.status).toBe(404);
  });

  it('rejects unauthenticated scene reads before any port work', async () => {
    const h = await harness();
    const server = trackServer(createHostServer({ port: 0, browser: browserOptions(h.sceneMap) }));
    await server.start();
    const res = await server.app.request(
      BROWSER_PROJECT_SCENE_MAP_PATH.replace(':projectId', PROJECT_ID),
    );
    await expectError(res, 401, 'SESSION_NOT_FOUND');
  });
});

describe('sceneFingerprint (9.2.5 frontmatter)', () => {
  it('reads context.sceneHash from a frontmatter block and nulls without one', () => {
    expect(sceneFingerprint(`---\ncontext:\n  sceneHash: ${FINGERPRINT}\n---\nProse.`)).toBe(
      FINGERPRINT,
    );
    expect(sceneFingerprint('Plain prose without frontmatter.')).toBeNull();
    expect(sceneFingerprint('---\ncontext: {}\n---\nProse.')).toBeNull();
  });
});
