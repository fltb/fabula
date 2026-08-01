// ============================================================================
// Finding kinds + observationRef (epistemic IR plan §5)
// ============================================================================
// Focused contract tests for the validation-finding layer:
//   - uncertainty preflight: exactly one `analysis_uncertainty` finding per
//     (validator, field) for abstained/ambiguous Pass 2 fields; severity stays
//     independently controlled (never derived from the disposition)
//   - fail-closed RFC 6901 observationRef validation: invalid refs are
//     replaced by `compiler_invariant` errors so a misattributed finding can
//     never pass the release gate
//   - deferred facts never fabricate a match level from a missing payload
//     (abstained/ambiguous narrativeChecks produce no contradicted/absent
//     findings — the aggregator preflight reports the uncertainty instead)
//   - evaluateReleaseDecision remains the sole release gate: default
//     uncertainty warning -> pending_waiver; matching waiver -> accepted with
//     the observation unchanged; promoted error -> blocked regardless
// ============================================================================

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InteractionManager } from '../../src/pipeline/interaction-gate.ts';
import { evaluateReleaseDecision } from '../../src/pipeline/release-decision.ts';
import type {
  AnalysisObservation,
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  ValidationIssue,
  ValidationResult,
  WorldState,
} from '../../src/types/index.js';
import { ResultAggregator } from '../../src/validator/aggregator.ts';
import { makeIssue } from '../../src/validator/base.ts';
import { resolveDeferredFacts } from '../../src/validator/deferred-resolver.ts';
import { makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ——— helpers ———
function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    kind: 'event',
    id: 'E0',
    event: 'E0',
    narrativeOrder: 1,
    title: 'Test event',
    storyTime: { type: 'absolute', value: 'day_1_morning' },
    sceneType: 'linear',
    pov: { character: 'rainsford', type: 'third_person_limited' },
    sceneBrief: 'Test',
    beats: ['Test'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    styleGuidance: undefined,
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

function makeWorldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
    ...overrides,
  };
}

const PROSE = 'Rainsford pulled himself onto the jagged coral shore.';

function makeAnalysis(
  observations: Record<string, AnalysisObservation>,
  analysis: Record<string, unknown>,
  eventId = 'E0',
): AnalysisResult {
  return { eventId, protocol: makeProtocol(PROSE), observations, analysis };
}

const abstained: AnalysisObservation = {
  disposition: 'abstained',
  reason: 'prose is too fragmentary for a reliable measurement',
  evidence: [],
};

const ambiguous: AnalysisObservation = {
  disposition: 'ambiguous',
  alternatives: [
    { summary: 'narration stays inside Rainsford', evidence: ['jagged coral shore'] },
    { summary: 'narration briefly enters Whitney', evidence: ['jagged coral shore'] },
  ],
  evidence: [],
};
function produced(evidence: [string, ...string[]] = ['jagged coral shore']): AnalysisObservation {
  return { disposition: 'produced', evidence };
}

/** A validator requiring the given top-level analysis fields; spies on validatePost. */
function requiringValidator(
  name: string,
  fields: string[],
): {
  validator: {
    name: string;
    category: 'prose_quality';
    validatePost: (input: PostRenderInput) => ValidationIssue[];
    getAnalysisRequirements: () => Array<{
      field: string;
      schema: z.ZodTypeAny;
      instruction: string;
    }>;
  };
  calls: PostRenderInput[];
} {
  const calls: PostRenderInput[] = [];
  return {
    validator: {
      name,
      category: 'prose_quality' as const,
      validatePost(input: PostRenderInput) {
        calls.push(input);
        return [];
      },
      getAnalysisRequirements() {
        return fields.map((field) => ({
          field,
          schema: z.object({}),
          instruction: `${field}: measure the field`,
        }));
      },
    },
    calls,
  };
}

// ============================================================================
// Uncertainty preflight
// ============================================================================

describe('uncertainty preflight — one analysis_uncertainty finding per (validator, field)', () => {
  it('abstained field -> single warning finding with observationRef.field, validator not called', () => {
    const { validator, calls } = requiringValidator('PovConsumer', ['pov.leaks']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    expect(calls).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    const issue = result.warnings[0];
    expect(issue.kind).toBe('analysis_uncertainty');
    expect(issue.severity).toBe('warning');
    expect(issue.validator).toBe('PovConsumer');
    expect(issue.observationRef).toEqual({ field: 'pov' });
    expect(issue.observationRef?.analysisPointer).toBeUndefined();
  });

  it('ambiguous field -> same finding shape', () => {
    const { validator, calls } = requiringValidator('ConflictConsumer', ['conflictAnalysis']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ conflictAnalysis: ambiguous }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    expect(calls).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe('analysis_uncertainty');
    expect(result.warnings[0].observationRef?.field).toBe('conflictAnalysis');
  });

  it('two uncertain fields -> one finding per field, never merged', () => {
    const { validator } = requiringValidator('MultiConsumer', ['pov.leaks', 'conflictAnalysis']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained, conflictAnalysis: ambiguous }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    const fields = result.warnings.map((i) => i.observationRef?.field).sort();
    expect(fields).toEqual(['conflictAnalysis', 'pov']);
    expect(result.warnings.every((i) => i.kind === 'analysis_uncertainty')).toBe(true);
  });

  it('two validators requiring the same uncertain field -> one finding per validator', () => {
    const a = requiringValidator('ConsumerA', ['narrativeChecks']);
    const b = requiringValidator('ConsumerB', ['narrativeChecks']);
    const aggregator = new ResultAggregator([a.validator, b.validator]);
    const analysis = makeAnalysis({ narrativeChecks: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    expect(result.warnings).toHaveLength(2);
    expect(new Set(result.warnings.map((i) => i.validator))).toEqual(
      new Set(['ConsumerA', 'ConsumerB']),
    );
    expect(result.warnings.every((i) => i.observationRef?.field === 'narrativeChecks')).toBe(true);
  });

  it('produced field -> validator runs normally, no uncertainty finding', () => {
    const { validator, calls } = requiringValidator('PovConsumer', ['pov.leaks']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: produced() }, { pov: { consistent: true, leaks: [] } });

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    expect(calls).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('a validator that does not require the uncertain field is unaffected', () => {
    const { validator, calls } = requiringValidator('TenseConsumer', ['tenseDetected']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);

    // tenseDetected has no observation at all here; the validator still runs
    expect(calls).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('severity is independently controlled — explicit error override promotes the finding', () => {
    const { validator } = requiringValidator('PovConsumer', ['pov.leaks']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis, {
      PovConsumer: 'error',
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('analysis_uncertainty');
    expect(result.passed).toBe(false);
  });

  it('off override suppresses the uncertainty finding entirely', () => {
    const { validator, calls } = requiringValidator('PovConsumer', ['pov.leaks']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis, {
      PovConsumer: 'off',
    });

    expect(calls).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// observationRef RFC 6901 validation (fail closed)
// ============================================================================

describe('observationRef RFC 6901 validation (fail closed)', () => {
  const payload = {
    narrativeChecks: [
      {
        entityId: 'a',
        attribute: 'location',
        matchLevel: 'exact',
        hint: '',
        evidence: 'quote',
      },
      {
        entityId: 'b',
        attribute: 'status',
        matchLevel: 'absent',
        hint: '',
        evidence: 'quote',
      },
    ],
  };
  const obs = { narrativeChecks: produced() };

  function run(
    ref: NonNullable<ValidationIssue['observationRef']>,
    observations: Record<string, AnalysisObservation> = obs,
    analysis: Record<string, unknown> = payload,
  ): ValidationResult {
    const validator: {
      name: string;
      category: 'prose_quality';
      validatePost: () => ValidationIssue[];
    } = {
      name: 'RefEmitter',
      category: 'prose_quality' as const,
      validatePost: () => [
        makeIssue(
          'RefEmitter',
          'E0',
          'system',
          'warning',
          'consumed narrativeChecks[1]',
          'fix the prose',
          'manual',
          undefined,
          undefined,
          undefined,
          'evidence_mismatch',
          ref,
        ),
      ],
    };
    const aggregator = new ResultAggregator([validator]);
    return aggregator.validateRender(
      PROSE,
      makeEvent(),
      makeWorldState(),
      makeAnalysis(observations, analysis),
    );
  }

  it('valid pointer -> finding kept with its observationRef', () => {
    const result = run({ field: 'narrativeChecks', analysisPointer: '/narrativeChecks/1' });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe('evidence_mismatch');
    expect(result.warnings[0].observationRef).toEqual({
      field: 'narrativeChecks',
      analysisPointer: '/narrativeChecks/1',
    });
  });

  it('unknown field -> replaced with a compiler_invariant error', () => {
    const result = run({ field: 'noSuchField' });
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('compiler_invariant');
    expect(result.errors[0].message).toContain('Invalid observationRef');
    expect(result.passed).toBe(false);
  });

  it('pointer without leading slash (not RFC 6901) -> compiler_invariant error', () => {
    const result = run({ field: 'narrativeChecks', analysisPointer: 'narrativeChecks/1' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('compiler_invariant');
    expect(result.errors[0].message).toContain('RFC 6901');
  });

  it('pointer whose first segment does not match the field -> compiler_invariant error', () => {
    const result = run({ field: 'narrativeChecks', analysisPointer: '/pov/leaks/0' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('compiler_invariant');
    expect(result.errors[0].message).toContain('first segment');
  });

  it('pointer that does not resolve (out of range / missing key) -> compiler_invariant error', () => {
    const outOfRange = run({ field: 'narrativeChecks', analysisPointer: '/narrativeChecks/9' });
    expect(outOfRange.errors).toHaveLength(1);
    expect(outOfRange.errors[0].kind).toBe('compiler_invariant');

    const missingKey = run({ field: 'narrativeChecks', analysisPointer: '/narrativeChecks/nope' });
    expect(missingKey.errors).toHaveLength(1);
    expect(missingKey.errors[0].kind).toBe('compiler_invariant');
  });

  it('field-only ref on a produced observation -> kept', () => {
    const result = run({ field: 'narrativeChecks' });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].observationRef).toEqual({ field: 'narrativeChecks' });
  });

  it('single-requirement single-object field finding is auto-filled with the field ref', () => {
    const validator = {
      name: 'AutoFill',
      category: 'prose_quality' as const,
      validatePost: (): ValidationIssue[] => [
        makeIssue(
          'AutoFill',
          'E0',
          'system',
          'warning',
          'pov is inconsistent',
          'review the scene',
          'edit_file',
          undefined,
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      ],
      getAnalysisRequirements() {
        return [{ field: 'pov.leaks', schema: z.object({}), instruction: 'pov: measure' }];
      },
    };
    const aggregator = new ResultAggregator([validator]);
    const result = aggregator.validateRender(
      PROSE,
      makeEvent(),
      makeWorldState(),
      makeAnalysis({ pov: produced() }, { pov: { consistent: false, leaks: ['x'] } }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].observationRef).toEqual({ field: 'pov' });
  });
});

// ============================================================================
// Deferred facts never fabricate a match level from a missing payload
// ============================================================================

describe('resolveDeferredFacts — missing payload is never a contradiction', () => {
  function eventWithHint(): NarrativeEvent {
    return makeEvent({
      id: 'E1',
      preconditions: [
        {
          id: 'jinx.mood',
          entityId: 'jinx',
          attribute: 'mood',
          narrativeHint: 'Jinx should be anxious and wary',
          validity: {
            temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
            branches: { type: 'all' as const },
          },
        },
      ],
    });
  }

  it('abstained narrativeChecks -> no findings', () => {
    const issues = resolveDeferredFacts(
      eventWithHint(),
      makeAnalysis({ narrativeChecks: abstained }, {}),
    );
    expect(issues).toHaveLength(0);
  });

  it('ambiguous narrativeChecks -> no findings', () => {
    const issues = resolveDeferredFacts(
      eventWithHint(),
      makeAnalysis({ narrativeChecks: ambiguous }, {}),
    );
    expect(issues).toHaveLength(0);
  });

  it('no narrativeChecks observation even with a payload present -> no findings', () => {
    const analysis = makeAnalysis(
      {},
      {
        narrativeChecks: [
          {
            entityId: 'jinx',
            attribute: 'mood',
            matchLevel: 'contradicted',
            hint: '',
            evidence: '',
          },
        ],
      },
    );
    const issues = resolveDeferredFacts(eventWithHint(), analysis);
    expect(issues).toHaveLength(0);
  });

  it('produced contradicted -> evidence_mismatch error with exact pointer', () => {
    const analysis = makeAnalysis(
      { narrativeChecks: produced(['quote']) },
      {
        narrativeChecks: [
          {
            entityId: 'jinx',
            attribute: 'mood',
            matchLevel: 'contradicted',
            hint: '',
            evidence: 'quote',
          },
        ],
      },
    );
    const issues = resolveDeferredFacts(eventWithHint(), analysis);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('evidence_mismatch');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].observationRef).toEqual({
      field: 'narrativeChecks',
      analysisPointer: '/narrativeChecks/0',
    });
  });

  it('produced absent -> evidence_mismatch warning with field-only ref', () => {
    const analysis = makeAnalysis(
      { narrativeChecks: produced(['quote']) },
      {
        narrativeChecks: [
          {
            entityId: 'jinx',
            attribute: 'mood',
            matchLevel: 'absent',
            hint: '',
            evidence: 'quote',
          },
        ],
      },
    );
    const issues = resolveDeferredFacts(eventWithHint(), analysis);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('evidence_mismatch');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].observationRef).toEqual({ field: 'narrativeChecks' });
  });
});

// ============================================================================
// evaluateReleaseDecision remains the sole release gate
// ============================================================================

describe('evaluateReleaseDecision — waiver/release behavior', () => {
  function uncertaintyIssue(severity: 'warning' | 'error' = 'warning'): ValidationIssue {
    return {
      validator: 'PovConsumer',
      severity,
      kind: 'analysis_uncertainty',
      event: 'E0',
      entity: 'system',
      message: 'Pass 2 measurement for analysis field "pov" is abstained',
      fixSuggestion: 'Review the measurement uncertainty or waive the finding.',
      fixAction: 'manual',
      fixTarget: { file: '' },
      observationRef: { field: 'pov' },
    };
  }

  function candidate(validation: ValidationResult): {
    eventId: string;
    prose: string;
    analysis: AnalysisResult;
    validation: ValidationResult;
    needsReview: boolean;
    errors: string[];
  } {
    return {
      eventId: 'E0',
      prose: PROSE,
      analysis: makeAnalysis({ pov: abstained }, {}),
      validation,
      needsReview: false,
      errors: [],
    };
  }

  const warningOnly: ValidationResult = {
    passed: true,
    errors: [],
    warnings: [uncertaintyIssue()],
    infos: [],
  };
  const errorOnly: ValidationResult = {
    passed: false,
    errors: [uncertaintyIssue('error')],
    warnings: [],
    infos: [],
  };

  it('default warning uncertainty -> pending_waiver without a waiver', () => {
    const decision = evaluateReleaseDecision(candidate(warningOnly), 'scope', 'identity');
    expect(decision.status).toBe('pending_waiver');
    expect(decision.waiverId).toBeUndefined();
  });

  it('matching waiver -> accepted with waiverId, observation unchanged', () => {
    const mgr = new InteractionManager();
    mgr.recordWaiver('gate:E0:validation', 'author reviewed the uncertainty and accepted');

    const decision = evaluateReleaseDecision(candidate(warningOnly), 'scope', 'identity', mgr);

    expect(decision.status).toBe('accepted');
    expect(decision.waiverId).toBe('gate:E0:validation');
    // The waiver only changes the release disposition — never the observation.
    expect(candidate(warningOnly).analysis.observations.pov).toEqual(abstained);
  });

  it('error-severity finding (promoted uncertainty) -> blocked even with a waiver', () => {
    const mgr = new InteractionManager();
    mgr.recordWaiver('gate:E0:validation', 'attempted bypass');

    const decision = evaluateReleaseDecision(candidate(errorOnly), 'scope', 'identity', mgr);

    expect(decision.status).toBe('blocked');
  });

  it('invalid observationRef replaced by compiler_invariant error -> blocked', () => {
    const blocked: ValidationResult = {
      passed: false,
      errors: [
        {
          validator: 'RefEmitter',
          severity: 'error',
          kind: 'compiler_invariant',
          event: 'E0',
          entity: 'system',
          message: 'Invalid observationRef on finding from validator "RefEmitter": no match',
          fixSuggestion: 'Fix the validator.',
          fixAction: 'manual',
          fixTarget: { file: '' },
        },
      ],
      warnings: [],
      infos: [],
    };
    const mgr = new InteractionManager();
    mgr.recordWaiver('gate:E0:validation', 'attempted bypass');

    const decision = evaluateReleaseDecision(candidate(blocked), 'scope', 'identity', mgr);

    expect(decision.status).toBe('blocked');
  });

  it('all-clear -> accepted', () => {
    const clean: ValidationResult = { passed: true, errors: [], warnings: [], infos: [] };
    const decision = evaluateReleaseDecision(candidate(clean), 'scope', 'identity');
    expect(decision.status).toBe('accepted');
  });

  it('end-to-end: aggregator uncertainty -> pending_waiver -> waiver -> accepted, observation unchanged', () => {
    const { validator } = requiringValidator('PovConsumer', ['pov.leaks']);
    const aggregator = new ResultAggregator([validator]);
    const analysis = makeAnalysis({ pov: abstained }, {});

    const result = aggregator.validateRender(PROSE, makeEvent(), makeWorldState(), analysis);
    expect(result.warnings.some((i) => i.kind === 'analysis_uncertainty')).toBe(true);

    const base = {
      eventId: 'E0',
      prose: PROSE,
      analysis,
      validation: result,
      needsReview: false,
      errors: [] as string[],
    };

    const before = evaluateReleaseDecision(base, 'scope', 'identity');
    expect(before.status).toBe('pending_waiver');

    const mgr = new InteractionManager();
    mgr.recordWaiver('gate:E0:validation', 'accepted');
    const after = evaluateReleaseDecision(base, 'scope', 'identity', mgr);
    expect(after.status).toBe('accepted');
    expect(after.waiverId).toBe('gate:E0:validation');
    expect(analysis.observations.pov).toEqual(abstained);
  });
});
