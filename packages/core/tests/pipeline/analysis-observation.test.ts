// ============================================================================
// Pass 2 Observation Contract — produced/abstained/ambiguous pairing, protocol
// fail-closed matching, exact-quote evidence, retry feedback, prompt preimage
// identity, sentinel absence, and hard state-isolation proofs.
//
// The observation map is the companion measurement record of AnalysisResult:
//   - produced  ⇒ canonical payload present and schema-valid
//   - abstained ⇒ no canonical payload, non-empty reason
//   - ambiguous ⇒ no canonical payload, ≥2 alternatives each with exact quotes
// Every active top-level analysis field carries exactly one observation.
// Evidence quotes must be exact substrings of the measured prose
// (protocol.proseHash). The protocol itself is compared field-by-field,
// fail-closed, against the expected protocol from the prompt.
//
// Pass 2 measurement NEVER mutates WorldState, DiscourseState, the epistemic
// ledger, the PropositionCatalog, or the reference index — proven here by
// byte-equivalence of canonical JSON before/after parse + evaluate.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  type BuildAnalysisPromptResult,
  buildAnalysisPrompt,
  extractExpectedProtocol,
  type RenderAnalysisInput,
  type ValidationKeyMaterial,
} from '../../src/ai/prompts/render-analysis.ts';
import { type MockPass2Entry, MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { canonicalJson } from '../../src/cache/render-cache.ts';
import { InteractionManager } from '../../src/pipeline/interaction-gate.ts';
import { evaluateReleaseDecision } from '../../src/pipeline/release-decision.ts';
import { type RenderJob, RenderPipeline } from '../../src/pipeline/render.ts';
import {
  analysisObservationSchema,
  parseAnalysisJSON,
  parseAnalysisJSONWithErrors,
} from '../../src/schemas/analysis.ts';
import { narratorAssertionSchema } from '../../src/schemas/discourse.ts';
import { compilePlannedDiscourseLedger } from '../../src/state/discourse-ledger.ts';
import { replayDiscourseState } from '../../src/state/discourse-replay.ts';
import { computeReferenceIndex } from '../../src/state/reference-index.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  AnalysisObservation,
  AnalysisResult,
  ContextPackage,
  DiscourseState,
  EpistemicLedger,
  KnowledgeBoundary,
  NarrativeEvent,
  NarratorAssertion,
  PlannedDiscourseLedgerSource,
  PropositionCatalog,
  SceneSpecification,
  SystemContext,
  ValidationKey,
  WorldState,
} from '../../src/types/index.ts';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ============================================================================
// Shared fixtures
// ============================================================================

const PROSE =
  '旧历的年底毕竟最像年底，村镇上不必说，就在天空中也显出将到新年的气象来。' +
  '我是正在这一夜回到我的故乡鲁镇的。她分明已经纯乎是一个乞丐了。';

/** Full canonical payload for all 14 required analysis blocks. */
function makePayload(): Record<string, unknown> {
  return {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: [],
      weaknesses: [],
      estimatedWordCount: 120,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  };
}

function makeResult(
  observations: Record<string, AnalysisObservation>,
  payload: Record<string, unknown>,
  prose: string,
  eventId = 'E0',
): AnalysisResult {
  return { eventId, protocol: makeProtocol(prose), observations, analysis: payload };
}

function makeProducedResult(prose: string, eventId = 'E0'): AnalysisResult {
  const payload = makePayload();
  payload['checklistResults'] = []; // checklistResults is required by the combined schema
  return makeResult(makeObservations(payload, prose), payload, prose, eventId);
}

/**
 * Every active field abstained — no canonical payload at all. The field set
 * is taken from the aggregator's combined schema (which includes
 * checklistResults) so the entry parses under both the default content
 * schema and the pipeline's combined schema.
 */
function makeAllAbstainedResult(prose: string, eventId = 'E0'): AnalysisResult {
  const fields = Object.keys(new ResultAggregator().getCombinedValidationSchema().shape);
  const observations: Record<string, AnalysisObservation> = {};
  for (const field of fields) {
    observations[field] = {
      disposition: 'abstained',
      reason: `cannot measure ${field} from this prose`,
      evidence: [],
    };
  }
  return makeResult(observations, {}, prose, eventId);
}

/**
 * One field ambiguous (two alternatives), everything else produced, and
 * checklistResults abstained (it is required by the combined schema but has
 * no canonical payload here).
 */
function makeAmbiguousResult(prose: string, eventId = 'E0'): AnalysisResult {
  const payload = makePayload();
  const { conflictAnalysis: _dropped, ...rest } = payload;
  const observations = makeObservations(rest, prose);
  observations['conflictAnalysis'] = {
    disposition: 'ambiguous',
    alternatives: [
      {
        summary: 'person vs self — the narrator wrestles with guilt',
        evidence: [PROSE.slice(0, 10)],
      },
      {
        summary: 'person vs society — the town excludes the woman',
        evidence: [PROSE.slice(0, 10)],
      },
    ],
    evidence: [PROSE.slice(0, 10)],
  };
  observations['checklistResults'] = {
    disposition: 'abstained',
    reason: 'no narrative checklist was declared for this scene',
    evidence: [],
  };
  return makeResult(observations, { ...rest }, prose, eventId);
}

// ============================================================================
// Parser helpers
// ============================================================================

function parseWithErrors(
  result: AnalysisResult,
  opts: { expectedProtocol?: ValidationKey | null; prose?: string | null } = {},
) {
  return parseAnalysisJSONWithErrors(
    JSON.stringify(result),
    undefined,
    opts.expectedProtocol ?? null,
    opts.prose ?? null,
  );
}

/** Collect every top-level issue message produced by the parser. */
function issueMessages(parse: {
  result: AnalysisResult | null;
  parseError?: string | null;
  zodErrors?: { issues: Array<{ message: string }> } | null;
}): string[] {
  if (parse.result) return [];
  if (parse.parseError) return [parse.parseError];
  return (parse.zodErrors?.issues ?? []).map((i) => i.message);
}

// ============================================================================
// Event / context / job / pipeline helpers (pipeline-level tests)
// ============================================================================

function makeEvent(id: string): NarrativeEvent {
  return {
    id,
    event: 'Test event',
    narrativeOrder: 1,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: 'start' },
    sceneType: 'linear',
    pov: { character: 'entity_1', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' as const },
    participants: { entities: ['entity_1'] },
    styleGuidance: undefined,
  };
}

function makeContext(eventId: string): ContextPackage {
  return {
    eventId,
    systemContext: {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    } satisfies SystemContext,
    sceneSpec: {
      goal: 'Advance plot',
      beats: ['Advance plot'],
      povType: 'third_person',
      povCharacter: 'narrator',
      conflict: 'none',
      expectedOutcome: 'Scene rendered',
    } satisfies SceneSpecification,
    characterSnapshots: [],
    relationshipContext: [],
    worldFacts: [],
    knowledgeBoundary: {
      entityId: 'narrator',
      knownFacts: [],
      restrictedEntities: [],
    } satisfies KnowledgeBoundary,
    activeThreads: [],
    markdown: '',
    narrativeTechniques: [],
  };
}

function makeJob(id: string): RenderJob {
  return {
    event: makeEvent(id),
    stateBefore: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    context: makeContext(id),
    graphHash: 'a00',
    chapter: 1,
    contract: {
      sceneId: id,
      branch: { decisions: [] },
      discoursePosition: 0,
      worldStateHash: 'a00',
      knowledgeStateHash: 'a00',
      narratorProfileHash: 'a00',
      plannedDiscourseHash: 'a00',
      styleProfile: {
        profileId: 'default',
        resolutionPrecedence: { projectStyle: 'default' },
      },
      continuityPacket: { transition: 'continuous' },
      promptContractHash: 'a00',
    },
    surfaceDependency: {
      groupId: 'default',
      policy: 'parallel' as const,
      manifestHash: 'a00',
    },
  };
}

function buildPipeline(entry: MockPass2Entry, maxRetries = 1): RenderPipeline {
  const provider = new MockPass2Provider({ entries: { test: entry } });
  const aggregator = new ResultAggregator();
  return new RenderPipeline({
    provider,
    model: 'mock-pass2',
    cacheDir: '/tmp/test-cache',
    storage: new MemoryStorage(),
    skipCache: true,
    maxRetries,
    aggregator,
    validatorPolicyId: 'test-policy-v1',
  });
}

// ============================================================================
// Tests — observation ↔ payload pairing
// ============================================================================

describe('observation ↔ payload pairing', () => {
  it('accepts produced observations with schema-valid payloads and exact quotes', () => {
    const result = makeProducedResult(PROSE);
    const parse = parseWithErrors(result, { expectedProtocol: result.protocol, prose: PROSE });
    expect(parse.result).not.toBeNull();
    expect(parse.result!.eventId).toBe('E0');
    expect(parse.result!.observations['tenseDetected']).toEqual({
      disposition: 'produced',
      evidence: [PROSE.slice(0, 24)],
    });
  });

  it('rejects a produced observation whose canonical payload is missing', () => {
    const result = makeProducedResult(PROSE);
    delete result.analysis['tenseDetected']; // produced claims a payload it does not deliver
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('requires a schema-valid payload');
  });

  it('accepts abstained observations (reason, no payload) on first parse', () => {
    const result = makeAllAbstainedResult(PROSE);
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).not.toBeNull();
    expect(parse.result!.analysis).toEqual({});
    for (const obs of Object.values(parse.result!.observations)) {
      expect(obs.disposition).toBe('abstained');
      if (obs.disposition === 'abstained') {
        expect(obs.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an abstained observation while a canonical payload is present', () => {
    const result = makeAllAbstainedResult(PROSE);
    result.analysis['quality'] = makePayload()['quality']; // abstained but payload present
    result.observations['quality'] = {
      disposition: 'abstained',
      reason: 'cannot measure',
      evidence: [],
    };
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain(
      'requires the canonical payload to be absent',
    );
  });

  it('accepts an ambiguous observation (two alternatives, no payload) on first parse', () => {
    const result = makeAmbiguousResult(PROSE);
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).not.toBeNull();
    const obs = parse.result!.observations['conflictAnalysis'];
    expect(obs.disposition).toBe('ambiguous');
    if (obs.disposition === 'ambiguous') {
      expect(obs.alternatives.length).toBeGreaterThanOrEqual(2);
    }
    expect(parse.result!.analysis['conflictAnalysis']).toBeUndefined();
  });

  it('rejects an ambiguous observation with a single alternative', () => {
    const result = makeAmbiguousResult(PROSE);
    result.observations['conflictAnalysis'] = {
      disposition: 'ambiguous',
      alternatives: [{ summary: 'only one reading', evidence: [PROSE.slice(0, 10)] }],
      evidence: [],
    };
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
  });

  it('rejects an ambiguous observation while a canonical payload is present', () => {
    const result = makeAmbiguousResult(PROSE);
    result.analysis['conflictAnalysis'] = { primaryType: 'none', resolutionAchieved: true };
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain(
      'requires the canonical payload to be absent',
    );
  });

  it('rejects an observation for an unknown analysis field', () => {
    const result = makeProducedResult(PROSE);
    result.observations['bogusField'] = { disposition: 'produced', evidence: [PROSE.slice(0, 10)] };
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('unknown analysis field');
  });

  it('rejects a payload field without a matching observation', () => {
    const result = makeProducedResult(PROSE);
    delete result.observations['pov']; // payload still carries pov
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('no matching observations');
  });

  it('rejects a missing observation for a required active field', () => {
    const result = makeProducedResult(PROSE);
    delete result.observations['pov'];
    delete result.analysis['pov']; // field absent entirely — still must carry an observation
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('Missing observation for active field');
  });
});

// ============================================================================
// Tests — exact-quote evidence
// ============================================================================

describe('exact-quote evidence', () => {
  it('rejects an evidence quote that is not an exact substring of the prose', () => {
    const result = makeProducedResult(PROSE);
    result.observations['pov'] = {
      disposition: 'produced',
      evidence: ['this paraphrase is not in the prose at all'],
    };
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('not an exact substring');
  });

  it('checks every alternative evidence in an ambiguous observation', () => {
    const result = makeAmbiguousResult(PROSE);
    const obs = result.observations['conflictAnalysis'];
    if (obs.disposition === 'ambiguous') {
      obs.alternatives[0].evidence = ['fabricated quote that never appears'];
    }
    const parse = parseWithErrors(result, { prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain('not an exact substring');
  });

  it('does not require exact quotes when the parser has no prose', () => {
    const result = makeProducedResult(PROSE);
    result.observations['pov'] = {
      disposition: 'produced',
      evidence: ['any string at all is fine without prose'],
    };
    const parse = parseWithErrors(result, { expectedProtocol: null, prose: null });
    expect(parse.result).not.toBeNull();
  });
});

// ============================================================================
// Tests — expected protocol fail-closed matching
// ============================================================================

describe('expected protocol fail-closed matching', () => {
  it('accepts an analysis whose protocol matches every expected field', () => {
    const result = makeProducedResult(PROSE);
    const parse = parseWithErrors(result, {
      expectedProtocol: result.protocol,
      prose: PROSE,
    });
    expect(parse.result).not.toBeNull();
  });

  it.each([
    'proseHash',
    'analysisSchema',
    'model',
    'provider',
    'analysisPromptHash',
    'samplingConfigHash',
    'validatorPolicy',
    'referencePolicy',
  ] as const)('rejects a protocol whose "%s" field differs', (field) => {
    const result = makeProducedResult(PROSE);
    const expected: ValidationKey = { ...result.protocol };
    result.protocol = { ...result.protocol, [field]: `tampered-${field}` };
    const parse = parseWithErrors(result, { expectedProtocol: expected, prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain(
      'does not match the expected measurement protocol',
    );
  });

  it('rejects a protocol carrying an extra field not present in the expected protocol', () => {
    const result = makeProducedResult(PROSE);
    const expected = { ...result.protocol };
    // Extra protocol dimension: shape is intentionally wider than ValidationKey.
    const tampered: ValidationKey = {
      ...result.protocol,
      extraDimension: 'x',
    } as unknown as ValidationKey;
    result.protocol = tampered;
    const parse = parseWithErrors(result, { expectedProtocol: expected, prose: PROSE });
    expect(parse.result).toBeNull();
    expect(issueMessages(parse).join('\n')).toContain(
      'does not match the expected measurement protocol',
    );
  });

  it('rejects a protocol missing a required field', () => {
    const result = makeProducedResult(PROSE);
    const expected = { ...result.protocol };
    const { model: _model, ...withoutModel } = result.protocol;
    // Missing model field: shape is intentionally narrower than ValidationKey.
    const incomplete: ValidationKey = withoutModel as unknown as ValidationKey;
    result.protocol = incomplete;
    const parse = parseWithErrors(result, { expectedProtocol: expected, prose: PROSE });
    expect(parse.result).toBeNull();
  });
});

// ============================================================================
// Tests — retry-with-feedback for protocol/pairing/evidence failures
// ============================================================================

describe('retry-with-feedback', () => {
  it('exhausts 4 sub-attempts with Zod feedback and blocks when the entry never fixes', async () => {
    // Produced observation for tenseDetected, but the canonical payload is
    // missing — pairing fails on every sub-attempt no matter the feedback.
    const result = makeProducedResult(PROSE);
    delete result.analysis['tenseDetected'];
    const entry: MockPass2Entry = { prose: PROSE, analysis: result };

    const pipeline = buildPipeline(entry, 1);
    const rendered = await pipeline.renderScene(makeJob('test'));

    expect(rendered.analysis).toBeNull();
    expect(rendered.pass2Rejection).toBe('validation');
    expect(rendered.needsReview).toBe(true);
    expect(rendered.errors.join('\n')).toContain('Pass 2 exhausted: schema validation failed');

    const pass2Records = rendered.requestRecords.filter((r) => r.phase === 'pass2');
    expect(pass2Records.length).toBe(4);
    // Every retry carries the previous Zod errors as feedback — never a blind retry.
    for (const record of pass2Records.slice(1)) {
      const text = record.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      expect(text).toContain('Previous Validation Errors');
    }
  });

  it('accepts abstained/ambiguous entries on the first parse — no retry', async () => {
    const pipeline = buildPipeline(
      makeCustomEntry('test', PROSE, makeAllAbstainedResult(PROSE, 'test')),
      1,
    );
    const rendered = await pipeline.renderScene(makeJob('test'));
    expect(rendered.analysis).not.toBeNull();
    expect(rendered.pass2Rejection).toBeUndefined();
    expect(rendered.errors).toEqual([]);
    const pass2Records = rendered.requestRecords.filter((r) => r.phase === 'pass2');
    expect(pass2Records.length).toBe(1);
  });
});

// ============================================================================
// Tests — prompt preimage identity (analysisPromptHash)
// ============================================================================

describe('prompt preimage identity', () => {
  function material(prose: string): ValidationKeyMaterial {
    const full = makeProtocol(prose);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(full)) {
      if (key !== 'analysisPromptHash') out[key] = value as string;
    }
    return out as ValidationKeyMaterial;
  }

  function input(overrides: Partial<RenderAnalysisInput> = {}): RenderAnalysisInput {
    const aggregator = new ResultAggregator();
    return {
      event: makeEvent('E0'),
      prose: PROSE,
      context: makeContext('E0'),
      analysisRequirements: aggregator.getAnalysisRequirements(),
      ...overrides,
    };
  }

  it('is deterministic for identical inputs', () => {
    const a = buildAnalysisPrompt(input(), material(PROSE));
    const b = buildAnalysisPrompt(input(), material(PROSE));
    expect(a.analysisPromptHash).toBe(b.analysisPromptHash);
    expect(a.protocol.analysisPromptHash).toBe(b.protocol.analysisPromptHash);
  });

  it('changes when plugin decorations are added', () => {
    const base = buildAnalysisPrompt(input(), material(PROSE));
    const decorated = buildAnalysisPrompt(
      input({
        pluginDecorations: [
          {
            id: 'deco-1',
            cacheKey: 'k1',
            content: 'Additional literary guidance: keep the tone restrained.',
          },
        ],
      }),
      material(PROSE),
    );
    expect(decorated.analysisPromptHash).not.toBe(base.analysisPromptHash);
  });

  it('changes when previous-error feedback is added', () => {
    const base = buildAnalysisPrompt(input(), material(PROSE));
    const withFeedback = buildAnalysisPrompt(
      input({ previousErrors: ['Validation error at "pov": inconsistent point of view'] }),
      material(PROSE),
    );
    expect(withFeedback.analysisPromptHash).not.toBe(base.analysisPromptHash);
  });

  it('decorations and feedback change the preimage independently and together', () => {
    const base = buildAnalysisPrompt(input(), material(PROSE));
    const decorated = buildAnalysisPrompt(
      input({ pluginDecorations: [{ id: 'deco-1', cacheKey: 'k1', content: 'd' }] }),
      material(PROSE),
    );
    const withFeedback = buildAnalysisPrompt(
      input({ previousErrors: ['some error feedback'] }),
      material(PROSE),
    );
    const both = buildAnalysisPrompt(
      input({
        pluginDecorations: [{ id: 'deco-1', cacheKey: 'k1', content: 'd' }],
        previousErrors: ['some error feedback'],
      }),
      material(PROSE),
    );
    expect(both.analysisPromptHash).not.toBe(base.analysisPromptHash);
    expect(both.analysisPromptHash).not.toBe(decorated.analysisPromptHash);
    expect(both.analysisPromptHash).not.toBe(withFeedback.analysisPromptHash);
  });

  it('embeds decorations and feedback in the final prompt messages', () => {
    const decorated = buildAnalysisPrompt(
      input({
        pluginDecorations: [{ id: 'deco-1', cacheKey: 'k1', content: 'restrained tone' }],
        previousErrors: ['pov inconsistency detected'],
      }),
      material(PROSE),
    );
    const text = decorated.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(text).toContain('deco-1');
    expect(text).toContain('restrained tone');
    expect(text).toContain('Previous Validation Errors');
    expect(text).toContain('pov inconsistency detected');
  });
});

// ============================================================================
// Tests — sentinel absence from final messages
// ============================================================================

describe('sentinel absence', () => {
  function material(prose: string): ValidationKeyMaterial {
    const full = makeProtocol(prose);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(full)) {
      if (key !== 'analysisPromptHash') out[key] = value as string;
    }
    return out as ValidationKeyMaterial;
  }

  function input(): RenderAnalysisInput {
    const aggregator = new ResultAggregator();
    return {
      event: makeEvent('E0'),
      prose: PROSE,
      context: makeContext('E0'),
      analysisRequirements: aggregator.getAnalysisRequirements(),
    };
  }

  it('never leaks the sentinel into the final prompt', () => {
    const built: BuildAnalysisPromptResult = buildAnalysisPrompt(input(), material(PROSE));
    const text = built.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(text).not.toContain('<analysis-prompt-hash>');
    expect(built.protocol.analysisPromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.protocol.analysisPromptHash).not.toBe('<analysis-prompt-hash>');
  });

  it('the model-echoed protocol carries the real hash, never the sentinel', () => {
    const built: BuildAnalysisPromptResult = buildAnalysisPrompt(input(), material(PROSE));
    const echoed = extractExpectedProtocol(built.messages);
    expect(echoed).not.toBeNull();
    expect(echoed!.analysisPromptHash).toBe(built.protocol.analysisPromptHash);
    expect(echoed!.analysisPromptHash).not.toBe('<analysis-prompt-hash>');
    expect(echoed).toEqual(built.protocol);
  });
});

// ============================================================================
// Tests — hard state isolation (byte-equivalence)
// ============================================================================

describe('Pass 2 isolation from knowledge/state', () => {
  function isolationWorld(): WorldState {
    return {
      entities: {
        narrator: { lifecycle: 'active', location: 'luzhen' },
        xianglins_wife: { lifecycle: 'active', status: 'employed_maid' },
      },
      relationships: {},
      knowledge: { narrator: { knownFacts: ['f1'] } },
      epistemicLedger: {
        claims: {
          'narrator:f1': {
            subject: 'narrator',
            propositionId: 'f1',
            assessment: { type: 'settled', grade: 'know', polarity: 'affirmative' },
            evidence: [
              {
                source: 'direct_experience',
                provenance: ['E0'],
                acquiredAt: { type: 'absolute', value: 'winter' },
              },
            ],
          },
        },
        bySubject: { narrator: ['f1'] },
        byProposition: { f1: ['narrator'] },
        actLog: [],
      },
      propositionCatalog: {
        version: 1,
        propositions: {
          f1: {
            kind: 'grounded',
            id: 'f1',
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'employed_maid',
          },
        },
        dependencyGraph: { f1: [] },
      },
      threads: {},
      rules: {},
      facts: [
        {
          id: 'f1',
          entityId: 'xianglins_wife',
          attribute: 'status',
          value: 'employed_maid',
          validity: {
            temporal: { start: { type: 'absolute', value: 'winter' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    };
  }

  function isolationDiscourse(): DiscourseState {
    return {
      position: 1,
      reveals: ['r1'],
      openClaims: [],
      retractions: [],
      corrections: [],
      hints: [],
      activeWithholds: [],
      narratorProfiles: {},
      assertions: {},
      providerIndex: {},
      branch: 'main',
      ledgerHash: 'hash_test',
    };
  }

  function bundleSnapshot(
    world: WorldState,
    discourse: DiscourseState,
    ledger: EpistemicLedger,
    catalog: PropositionCatalog,
  ): string {
    return canonicalJson({
      world,
      discourse,
      ledger,
      catalog,
      referenceIndex: computeReferenceIndex(world),
    });
  }

  it('parse + evaluate leave WorldState, DiscourseState, ledger, catalog and reference index byte-equivalent', () => {
    const aggregator = new ResultAggregator();
    const event = makeEvent('E0');

    for (const result of [
      makeProducedResult(PROSE),
      makeAllAbstainedResult(PROSE),
      makeAmbiguousResult(PROSE),
    ]) {
      const world = isolationWorld();
      const discourse = isolationDiscourse();
      const ledger = world.epistemicLedger as EpistemicLedger;
      const catalog = world.propositionCatalog as PropositionCatalog;
      const before = bundleSnapshot(world, discourse, ledger, catalog);

      const parse = parseAnalysisJSON(JSON.stringify(result), undefined, result.protocol, PROSE);
      expect(parse).not.toBeNull();
      const validation = aggregator.validateRender(PROSE, event, world, parse);
      expect(validation).toBeDefined();

      const after = bundleSnapshot(world, discourse, ledger, catalog);
      expect(after).toBe(before);
    }
  });

  it('analysis measurement never appears in state: no model subjects, no dispositions, no claim kinds', () => {
    const world = isolationWorld();
    const discourse = isolationDiscourse();
    const ledger = world.epistemicLedger as EpistemicLedger;
    const catalog = world.propositionCatalog as PropositionCatalog;

    // Only authored story characters are knowledge subjects — never the model.
    expect(Object.keys(ledger.bySubject).sort()).toEqual(['narrator']);
    expect(Object.keys(ledger.claims).sort()).toEqual(['narrator:f1']);

    const flat = canonicalJson({ world, discourse, ledger, catalog });
    expect(flat).not.toContain('model:mock-pass2');
    expect(flat).not.toContain('disposition');
    expect(flat).not.toContain('produced');
    expect(flat).not.toContain('abstained');
    expect(flat).not.toContain('ambiguous');
    expect(flat).not.toContain('ClaimKind');
    expect(flat).not.toContain('EpistemicStatus');
  });
});

// ============================================================================
// Tests — schema separation: NarratorAssertion vs AnalysisObservation
// ============================================================================

describe('NarratorAssertion / AnalysisObservation schema separation', () => {
  it('rejects every observation disposition as a narrator assertion', () => {
    const observations: AnalysisObservation[] = [
      { disposition: 'produced', evidence: ['quote'] },
      { disposition: 'abstained', reason: 'cannot measure', evidence: [] },
      {
        disposition: 'ambiguous',
        alternatives: [
          { summary: 'a', evidence: ['q'] },
          { summary: 'b', evidence: ['q'] },
        ],
        evidence: [],
      },
    ];
    for (const observation of observations) {
      expect(narratorAssertionSchema.safeParse(observation).success).toBe(false);
    }
  });

  it('rejects every narrator status as an analysis observation', () => {
    for (const status of ['asserted', 'unknown', 'contested'] as const) {
      const assertion: NarratorAssertion = {
        id: 'a1',
        narrator: 'narrator_1',
        proposition: 'prop',
        polarity: 'affirmative',
        type: 'claim',
        status,
        narrationBoundary: { narratorId: 'narrator_1' },
      };
      expect(analysisObservationSchema.safeParse(assertion).success).toBe(false);
    }
  });
});

// ============================================================================
// Tests — disposition semantics: disclosure vs validation/release
// ============================================================================

describe('disposition semantics', () => {
  function makeAssertion(
    id: string,
    status: NarratorAssertion['status'],
    type: NarratorAssertion['type'],
  ): NarratorAssertion {
    return {
      id,
      narrator: 'narrator_1',
      proposition: `prop_${id}`,
      polarity: 'affirmative',
      type,
      status,
      narrationBoundary: { narratorId: 'narrator_1' },
    };
  }

  it('unknown/contested assertions affect only disclosure — reveal is rejected, claim works', () => {
    const chapters: PlannedDiscourseLedgerSource['chapters'] = [
      { branch: 'main', chapter: 1, sceneIds: ['s1'] },
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'ledger',
      chapters,
      entries: [
        {
          id: 'e1',
          sceneId: 's1',
          branch: 'main',
          discoursePosition: 1,
          action: { type: 'reveal', assertionId: 'a_uncertain', discoursePosition: 1 },
        },
      ],
    });
    expect(() =>
      replayDiscourseState(ledger, 1, 'main', {
        a_uncertain: makeAssertion('a_uncertain', 'unknown', 'conjecture'),
      }),
    ).toThrow('Reveal requires status=asserted');

    const claimLedger = compilePlannedDiscourseLedger({
      id: 'ledger2',
      chapters,
      entries: [
        {
          id: 'e1',
          sceneId: 's1',
          branch: 'main',
          discoursePosition: 1,
          action: { type: 'claim', assertionId: 'a_uncertain', discoursePosition: 1 },
        },
      ],
    });
    const state = replayDiscourseState(claimLedger, 1, 'main', {
      a_uncertain: makeAssertion('a_uncertain', 'contested', 'conjecture'),
    });
    expect(state.openClaims).toContain('a_uncertain');
  });

  it('abstained/ambiguous affect only validation/release — uncertainty warnings, pending waiver, waiver accepted', () => {
    const aggregator = new ResultAggregator();
    const event = makeEvent('E0');
    const world: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    for (const result of [makeAllAbstainedResult(PROSE), makeAmbiguousResult(PROSE)]) {
      const validation = aggregator.validateRender(PROSE, event, world, result);
      expect(validation.errors).toEqual([]);
      expect(validation.warnings.length).toBeGreaterThan(0);
      for (const warning of validation.warnings) {
        expect(warning.kind).toBe('analysis_uncertainty');
        expect(warning.severity).toBe('warning');
        expect(warning.observationRef?.field).toBeDefined();
        expect(warning.observationRef?.analysisPointer).toBeUndefined();
      }

      // Default release: warnings without a waiver → pending_waiver.
      const manager = new InteractionManager();
      const candidate = {
        eventId: 'E0',
        prose: PROSE,
        analysis: result,
        validation,
        needsReview: false,
        errors: [],
      };
      const pending = evaluateReleaseDecision(
        candidate,
        'scope-hash',
        'validation-identity',
        manager,
      );
      expect(pending.status).toBe('pending_waiver');

      // Exact waiver → accepted, and the observation map is untouched.
      const observationsBefore = canonicalJson(result.observations);
      manager.recordWaiver('gate:E0:validation', 'author accepts measurement uncertainty');
      const accepted = evaluateReleaseDecision(
        candidate,
        'scope-hash',
        'validation-identity',
        manager,
      );
      expect(accepted.status).toBe('accepted');
      expect(accepted.waiverId).toBe('gate:E0:validation');
      expect(canonicalJson(result.observations)).toBe(observationsBefore);
    }
  });

  it('severity of analysis_uncertainty comes from explicit overrides, never from disposition', () => {
    const aggregator = new ResultAggregator();
    const event = makeEvent('E0');
    const world: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };
    const result = makeAllAbstainedResult(PROSE);
    const validation = aggregator.validateRender(PROSE, event, world, result, { pov: 'error' });
    const povIssue = validation.errors.find((e) => e.validator === 'pov');
    expect(povIssue).toBeDefined();
    expect(povIssue!.kind).toBe('analysis_uncertainty');
    expect(validation.warnings.length).toBeGreaterThan(0);
    for (const warning of validation.warnings) {
      expect(warning.severity).toBe('warning');
    }
  });
});
