// ============================================================================
// End-to-End Tests: Novalistically Narrative Engineering System
//
// Verifies the full pipeline works: loading fixtures, building entity registry
// and event log, replaying state, compiling context, calling LLM providers,
// and validating results. All LLM interactions use MockProvider; no actual
// network calls are made.
// ============================================================================

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const FIXTURE_PATH = path.resolve('fixtures/arcane-aftermath');

import {
  buildSceneRenderPrompt,
  buildThreadStatusPrompt,
  ContextCompiler,
  EntityMapper,
  InMemoryEntityRegistry,
  LLMError,
  MockProvider,
  ReplayEngine,
  StateManager,
} from '../src/index.js';
import type {
  CompletionResponse,
  NarrativeEvent,
  ProjectData,
  SceneRenderInput,
  StyleGuidance,
  WorldState,
} from '../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'test:evt',
    event: 'test_event',
    narrativeOrder: 1,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: 'Test event',
    beats: ['Test event'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

function makeGenesisEvent(): NarrativeEvent {
  return makeEvent({
    id: 'system:genesis',
    event: 'system:genesis',
    narrativeOrder: 0,
    title: 'World Genesis',
    storyTime: { type: 'absolute', value: 'day_-1' },
    source: 'system',
    postconditions: [
      ['world', 'status', 'post_arcane_s1'],
      ['world', 'day', 0],
      ['world', 'has_crystal_inventory', true],
      ['seraphine', 'location', 'piltover_enforcer_headquarters'],
      ['seraphine', 'status', 'alive'],
      ['camille', 'location', 'piltover_enforcer_headquarters'],
      ['camille', 'status', 'alive'],
      ['camille', 'condition', 'healthy'],
    ].map(([entityId, attribute, value]) => ({
      id: `${entityId}.${attribute}`,
      entityId,
      attribute,
      value,
      confidence: 1.0,
      validity: {
        temporal: { start: { type: 'absolute' as const, value: 'day_-1' }, end: null },
        branches: { type: 'all' as const },
      },
    })),
  });
}

describe('1. Full Pipeline with MockProvider', () => {
  let mapper: EntityMapper;
  let projectData: ProjectData;
  let registry: InMemoryEntityRegistry;
  let allEvents: NarrativeEvent[];
  let e1aEvent: NarrativeEvent;
  let snapDir: string;
  let sm: StateManager;

  beforeAll(() => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);

    // 1. Load fixture via EntityMapper
    mapper = new EntityMapper(FIXTURE_PATH);
    projectData = mapper.loadProject();
    expect(projectData.config).not.toBeNull();

    // 2. Build entity registry from fixture
    registry = new InMemoryEntityRegistry();
    registry.load(FIXTURE_PATH);
    const allEntities = registry.getAll();
    expect(allEntities.length).toBeGreaterThanOrEqual(5);

    // 3. Load all events (genesis + chapter events)
    allEvents = mapper.loadAllEvents(projectData.chapters);
    expect(allEvents.length).toBeGreaterThanOrEqual(2);

    // Find E1a
    const found = allEvents.find((e) => e.id === 'E1a');
    expect(found).toBeDefined();
    e1aEvent = found!;
  });

  it('1a. loads fixture and builds entity registry with expected entities', () => {
    // Project config
    expect(projectData.config!.project).toBe('arcane_aftermath');

    // Characters loaded
    const characters = registry.findByKind('character');
    expect(characters.length).toBeGreaterThanOrEqual(3);
    const charIds = characters.map((c) => c.id);
    expect(charIds).toContain('camille');
    expect(charIds).toContain('seraphine');

    // Locations loaded
    const locations = registry.findByKind('location');
    expect(locations.length).toBeGreaterThanOrEqual(2);
  });

  it('1b. loads all events with genesis + E1a', () => {
    expect(allEvents.length).toBeGreaterThanOrEqual(2);
    const ids = allEvents.map((e) => e.id);
    expect(ids).toContain('system:genesis');
    expect(ids).toContain('E1a');

    // E1a has correct properties
    expect(e1aEvent.pov.character).toBe('seraphine');
    expect(e1aEvent.pov.type).toBe('third_person_limited');
    expect(e1aEvent.narrativeOrder).toBe(1);
    expect(e1aEvent.sceneType).toBe('linear');
  });

  it('1c. commits events to StateManager and produces world state', () => {
    snapDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-e2e-'));
    sm = new StateManager(snapDir);

    // Commit genesis + E1a
    const genesis = makeGenesisEvent();
    sm.commit(genesis);
    sm.commit(e1aEvent);

    expect(sm.eventStore.count).toBe(2);

    const state = sm.getCurrentState();
    // World state should have entities from postconditions
    expect(state.entities['world']?.['status']).toBe('post_arcane_s1');
    // Seraphine should have state from E1a postconditions
    // (depends on the fixture — check has_detected_anomaly or knows_mysterious_signal)
    expect(
      state.entities['seraphine']?.['has_detected_anomaly'] ||
        state.entities['seraphine']?.['detected_anomaly'],
    ).toBeDefined();
  });

  it('1d. ReplayEngine reconstucts state at narrative order 1', () => {
    const replay = new ReplayEngine();
    const causalEvents = [makeGenesisEvent(), e1aEvent];
    const at0 = replay.getStateAt(causalEvents, 0);
    expect(at0.entities['world']?.['status']).toBe('post_arcane_s1');

    const at1 = replay.getStateAt(causalEvents, 1);
    // E1a's postconditions applied
    expect(at1.facts.length).toBeGreaterThan(0);
  });

  it('1e. compiles context for E1a via ContextCompiler', () => {
    const compiler = new ContextCompiler();
    const state = sm.getCurrentState();

    const pkg = compiler.compile(e1aEvent, state, registry);

    expect(pkg.eventId).toBe('E1a');
    expect(pkg.systemContext.genre).toBe('literary');
    expect(pkg.systemContext.style).toBe('literary');
    expect(pkg.sceneSpec.povCharacter).toBe('seraphine');
    expect(pkg.sceneSpec.povType).toBe('third_person_limited');

    // Character snapshots include seraphine
    const seraphineSnap = pkg.characterSnapshots.find((cs) => cs.id === 'seraphine');
    expect(seraphineSnap).toBeDefined();
    expect(seraphineSnap!.traits).toContain('empathetic');

    // Markdown is generated
    expect(pkg.markdown.length).toBeGreaterThan(0);
    expect(pkg.markdown).toContain('Context Package: E1a');
  });

  it('1f. builds scene render prompt from context', () => {
    const compiler = new ContextCompiler();
    const state = sm.getCurrentState();
    const pkg = compiler.compile(e1aEvent, state, registry);

    const styleGuidance: StyleGuidance = {
      tone: 'mysterious',
      scenePacing: 'slow',
      atmosphere: 'tense',
    };

    const input: SceneRenderInput = {
      context: pkg,
      styleGuidance,
      targetLengthWords: 500,
    };

    const messages = buildSceneRenderPrompt(input);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');

    // System message contains the writer instruction
    expect(messages[0].content).toContain('narrative prose writer');

    // User message contains the context JSON and writing instructions
    expect(messages[1].content).toContain('Narrative Context Package');
    expect(messages[1].content).toContain('Writing Instructions');
    expect(messages[1].content).toContain('500 words');
  });

  it('1g. sends prompt to MockProvider and receives valid prose response', async () => {
    const fixedProse = [
      'The morning light filtered through the tall windows of the converted conference room, painting golden rectangles across the scuffed wooden floor. Seraphine sat cross-legged on a cushion in the center of the room, eyes closed, hands resting on her knees. Her hextech headpiece hovered silently behind her ears, its soft pink glow the only indication that it was active.\n\nShe had been trying to clear her mind for twenty minutes. It was not going well.\n\nThe Enforcer Headquarters was a cacophony of emotional noise. Anxiety hummed through the walls like electrical current — the jittery tension of enforcers who had not slept well since the attack, the low-frequency dread of administrative staff who knew their building was a target, the sharp spikes of anger from interrogations on the floor below. Seraphine had learned to filter most of it into a distant drone, like city traffic heard through a closed window. But it was always there. Always.\n\nAnd then, for a single, heart-stopping moment, something else cut through.\n\nIt was not a feeling she could name. It arrived not as an emotion but as a rupture — a tear in the fabric of the emotional spectrum she had spent her whole life learning to read.',
    ];

    const mock = new MockProvider({ responses: fixedProse });
    const compiler = new ContextCompiler();
    const state = sm.getCurrentState();
    const pkg = compiler.compile(e1aEvent, state, registry);

    const messages = buildSceneRenderPrompt({
      context: pkg,
      targetLengthWords: 500,
    });

    const response = await mock.complete({ messages });

    // Assert: response received
    expect(response).toBeDefined();
    expect(response.id).toMatch(/^mock-/);
    expect(response.model).toBe('mock-model');
    expect(response.finishReason).toBe('stop');

    // Assert: prose is a non-empty string
    expect(typeof response.content).toBe('string');
    expect(response.content.length).toBeGreaterThan(0);

    // Assert: has reasonable length (>100 chars)
    expect(response.content.length).toBeGreaterThan(100);

    // Assert: doesn't contain obvious errors
    expect(response.content).not.toContain('[ERROR]');
    expect(response.content).not.toContain('undefined');
    expect(response.content).not.toContain('null');

    // Assert: usage info is present
    expect(response.usage.promptTokens).toBeGreaterThan(0);
    expect(response.usage.completionTokens).toBeGreaterThan(0);

    // Mock recorded the call
    expect(mock.callCount).toBe(1);
    expect(mock.lastRequest).toBeDefined();
    expect(mock.lastRequest!.messages).toEqual(messages);
  });

  it('1h. uses MockProvider generator for dynamic responses', async () => {
    const mock = new MockProvider({
      generator: (req) => {
        const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
        return `Dynamic prose generated from ${lastUser?.content.length ?? 0} chars of context.`;
      },
    });

    const response = await mock.complete({
      messages: [{ role: 'user', content: 'Write a scene.' }],
    });

    expect(response.content).toContain('Dynamic prose');
    expect(response.content.length).toBeGreaterThan(20);
    expect(mock.callCount).toBe(1);
  });

  // Cleanup
  afterEach(() => {
    if (snapDir && fs.existsSync(snapDir)) {
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// ─── 2. LLMError Class Behavior ──────────────────────────────────────────────

describe('2. LLMError class behavior', () => {
  it('2a. creates LLMError with minimal options', () => {
    const err = new LLMError('Something went wrong');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LLMError');
    expect(err.message).toBe('Something went wrong');
    expect(err.statusCode).toBeUndefined();
    expect(err.provider).toBe('unknown');
    expect(err.requestId).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('2b. creates LLMError with full options', () => {
    const cause = new Error('Underlying issue');
    const err = new LLMError('API call failed', {
      statusCode: 503,
      provider: 'opencode-zen',
      requestId: 'req_abc123',
      cause,
    });

    expect(err.name).toBe('LLMError');
    expect(err.message).toBe('API call failed');
    expect(err.statusCode).toBe(503);
    expect(err.provider).toBe('opencode-zen');
    expect(err.requestId).toBe('req_abc123');
    expect(err.cause).toBe(cause);
  });

  it('2c. isHttpError returns true when statusCode is set', () => {
    const withStatus = new LLMError('error', { statusCode: 400 });
    expect(withStatus.isHttpError).toBe(true);

    const withoutStatus = new LLMError('error');
    expect(withoutStatus.isHttpError).toBe(false);
  });

  it('2d. isRetryable returns true for network errors (no statusCode)', () => {
    const networkErr = new LLMError('Network failure');
    expect(networkErr.isRetryable).toBe(true);
  });

  it('2e. isRetryable returns true for 5xx status codes', () => {
    const err500 = new LLMError('error', { statusCode: 500 });
    expect(err500.isRetryable).toBe(true);

    const err502 = new LLMError('error', { statusCode: 502 });
    expect(err502.isRetryable).toBe(true);

    const err503 = new LLMError('error', { statusCode: 503 });
    expect(err503.isRetryable).toBe(true);
  });

  it('2f. isRetryable returns true for 429 (rate limit)', () => {
    const err429 = new LLMError('Too many requests', { statusCode: 429 });
    expect(err429.isRetryable).toBe(true);
  });

  it('2g. isRetryable returns false for 4xx other than 429', () => {
    const err400 = new LLMError('Bad request', { statusCode: 400 });
    expect(err400.isRetryable).toBe(false);

    const err401 = new LLMError('Unauthorized', { statusCode: 401 });
    expect(err401.isRetryable).toBe(false);

    const err403 = new LLMError('Forbidden', { statusCode: 403 });
    expect(err403.isRetryable).toBe(false);

    const err404 = new LLMError('Not found', { statusCode: 404 });
    expect(err404.isRetryable).toBe(false);

    const err422 = new LLMError('Unprocessable', { statusCode: 422 });
    expect(err422.isRetryable).toBe(false);
  });

  it('2h. name is always "LLMError"', () => {
    const err1 = new LLMError('a');
    const err2 = new LLMError('b', { statusCode: 500 });
    const err3 = new LLMError('c', { provider: 'test' });

    expect(err1.name).toBe('LLMError');
    expect(err2.name).toBe('LLMError');
    expect(err3.name).toBe('LLMError');
  });

  it('2i. cause is preserved when provided', () => {
    const cause = new TypeError('type mismatch');
    const err = new LLMError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });

  it('2j. provider and requestId are set correctly', () => {
    const err = new LLMError('msg', {
      provider: 'mock-provider',
      requestId: 'req_xyz',
    });
    expect(err.provider).toBe('mock-provider');
    expect(err.requestId).toBe('req_xyz');
  });
});

// ─── 4. buildThreadStatusPrompt ─────────────────────────────────────────────

describe('4. buildThreadStatusPrompt', () => {
  it('4a. returns valid Message array with empty threads', () => {
    const messages = buildThreadStatusPrompt({
      threads: [],
      currentChapter: 1,
      currentEvent: 'E1a',
    });

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');

    // Both messages have string content
    expect(typeof messages[0].content).toBe('string');
    expect(typeof messages[1].content).toBe('string');
    expect(messages[0].content.length).toBeGreaterThan(0);
    expect(messages[1].content.length).toBeGreaterThan(0);

    // Content includes standard sections
    expect(messages[0].content).toContain('narrative continuity analyst');
    expect(messages[1].content).toContain('Thread Snapshot');
    expect(messages[1].content).toContain('Current chapter: 1');
    expect(messages[1].content).toContain('Current event: E1a');
  });

  it('4b. builds prompt with 1 thread — non-empty content mentions thread', () => {
    const messages = buildThreadStatusPrompt({
      threads: [{ id: 'T1', name: 'Hextech Weapon Smuggling', progress: 0.2, lastEvent: 'E1a' }],
      currentChapter: 1,
      currentEvent: 'E1a',
    });

    expect(messages.length).toBe(2);
    const userMsg = messages[1].content;
    expect(userMsg).toContain('[T1]');
    expect(userMsg).toContain('Hextech Weapon Smuggling');
    expect(userMsg).toContain('20%');
    expect(userMsg).toContain('E1a');
  });

  it('4c. builds prompt with multiple threads — all thread names present', () => {
    const threadList = [
      { id: 'T1', name: 'Hextech Weapon Smuggling', progress: 0.2, lastEvent: 'E1a' },
      { id: 'T2', name: "Camille's Personal Dilemma", progress: 0.15, lastEvent: 'E1b' },
      { id: 'T3', name: "Seraphine's Double Burden", progress: 0.05, lastEvent: 'genesis' },
    ];

    const messages = buildThreadStatusPrompt({
      threads: threadList,
      currentChapter: 1,
      currentEvent: 'E1b',
    });

    const userMsg = messages[1].content;

    // All thread names appear in the content
    for (const t of threadList) {
      expect(userMsg).toContain(`[${t.id}]`);
      expect(userMsg).toContain(t.name);
    }

    // Chapter and event info
    expect(userMsg).toContain('Current chapter: 1');
    expect(userMsg).toContain('Current event: E1b');

    // Task section is present
    expect(userMsg).toContain('stalled or at risk');
    expect(userMsg).toContain('next actions');
  });

  it('4d. system message content is consistent regardless of input', () => {
    const msgs1 = buildThreadStatusPrompt({
      threads: [],
      currentChapter: 1,
      currentEvent: 'E1a',
    });
    const msgs2 = buildThreadStatusPrompt({
      threads: [{ id: 'T1', name: 'Test', progress: 0.5, lastEvent: 'E1' }],
      currentChapter: 2,
      currentEvent: 'E2',
    });

    // System message should be the same (it's static)
    expect(msgs1[0].content).toBe(msgs2[0].content);
  });

  it('4e. all messages have valid roles', () => {
    const messages = buildThreadStatusPrompt({
      threads: [{ id: 'T1', name: 'Test', progress: 0.5, lastEvent: 'E1' }],
      currentChapter: 1,
      currentEvent: 'E1',
    });

    for (const msg of messages) {
      expect(['system', 'user', 'assistant']).toContain(msg.role);
    }
  });
});

// ─── 5. MockProvider failOnCall Behavior ─────────────────────────────────────

describe('5. MockProvider failOnCall behavior', () => {
  it('5a. first call succeeds, second call throws, third call succeeds', async () => {
    // failOnCall: 2 means the second invocation throws BEFORE consuming a response slot,
    // so the third call gets the response that would have been the second.
    const mock = new MockProvider({
      responses: ['first', 'second', 'third'],
      failOnCall: 2,
      failMessage: 'Intentional failure on call 2',
    });

    // First call succeeds — consumes 'first'
    const r1 = await mock.complete({
      messages: [{ role: 'user', content: 'req1' }],
    });
    expect(r1.content).toBe('first');
    expect(mock.callCount).toBe(1);

    // Second call throws — does NOT consume a response
    await expect(mock.complete({ messages: [{ role: 'user', content: 'req2' }] })).rejects.toThrow(
      'Intentional failure on call 2',
    );
    expect(mock.callCount).toBe(2);

    // Third call succeeds — consumes 'second' (the next unconsumed response)
    const r3 = await mock.complete({
      messages: [{ role: 'user', content: 'req3' }],
    });
    expect(r3.content).toBe('second');
    expect(mock.callCount).toBe(3);
  });

  it('5b. failOnCall with default error message', async () => {
    const mock = new MockProvider({
      responses: ['ok'],
      failOnCall: 1,
    });

    await expect(mock.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      'Mock failure on call 1',
    );
  });

  it('5c. failOnCall beyond call count never triggers', async () => {
    const mock = new MockProvider({
      responses: ['a', 'b'],
      failOnCall: 10,
    });

    const r1 = await mock.complete({
      messages: [{ role: 'user', content: 'req1' }],
    });
    expect(r1.content).toBe('a');

    const r2 = await mock.complete({
      messages: [{ role: 'user', content: 'req2' }],
    });
    expect(r2.content).toBe('b');

    expect(mock.callCount).toBe(2);
  });
});

// ─── 6. MockProvider Latency ─────────────────────────────────────────────────

describe('6. MockProvider latency', () => {
  it('6a. complete() takes at least specified latencyMs', async () => {
    const mock = new MockProvider({
      responses: ['slow response'],
      latencyMs: 50,
    });

    const start = Date.now();
    const response = await mock.complete({
      messages: [{ role: 'user', content: 'test' }],
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow 5ms tolerance
    expect(response.content).toBe('slow response');
    expect(mock.callCount).toBe(1);
  });

  it('6b. zero latency resolves quickly', async () => {
    const mock = new MockProvider({
      responses: ['fast'],
      latencyMs: 0,
    });

    const start = Date.now();
    await mock.complete({ messages: [{ role: 'user', content: 't' }] });
    const elapsed = Date.now() - start;
    // With 0 latency it should be essentially instant
    expect(elapsed).toBeLessThan(2000);
  });

  it('6c. multiple calls with latency are sequential', async () => {
    const mock = new MockProvider({
      responses: ['a', 'b', 'c'],
      latencyMs: 30,
    });

    const start = Date.now();
    await mock.complete({ messages: [{ role: 'user', content: '1' }] });
    await mock.complete({ messages: [{ role: 'user', content: '2' }] });
    await mock.complete({ messages: [{ role: 'user', content: '3' }] });
    const elapsed = Date.now() - start;

    // Each call takes at least 30ms, so 3 calls should take >= 90ms
    expect(elapsed).toBeGreaterThanOrEqual(80); // Allow 10ms tolerance
    expect(mock.callCount).toBe(3);
  });
});
