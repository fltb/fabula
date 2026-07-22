// ============================================================================
// Unit Tests — Deferred-fact resolution
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveDeferredFacts } from '../../src/validator/deferred-resolver.js';
import type { NarrativeEvent, AnalysisResult, ValidationIssue } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

/** Minimal NarrativeEvent factory with sensible defaults */
function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    event: overrides.id,
    narrativeOrder: 1,
    title: 'Test Scene',
    storyTime: { type: 'relative', anchor: 'day_1', offset: 0 },
    sceneType: 'linear',
    pov: { character: 'char_hero', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

/** Create an AnalysisResult with the given narrativeChecks */
function makeAnalysis(narrativeChecks: Array<{
  entityId: string;
  attribute: string;
  matchLevel: string;
  hint?: string;
  evidence?: string;
}>): AnalysisResult {
  return {
    eventId: 'evt_test',
    analysis: {
      narrativeChecks: narrativeChecks.map((nc) => ({
        entityId: nc.entityId,
        attribute: nc.attribute,
        hint: nc.hint ?? '',
        evidence: nc.evidence ?? '',
        matchLevel: nc.matchLevel,
      })),
      // Other analysis fields are optional for this test
    },
  };
}

/** Make a narrativeHint-only fact (no deterministic value) */
function narrativeHintFact(
  entityId: string,
  attribute: string,
  hint: string,
) {
  return {
    id: `${entityId}.${attribute}`,
    entityId,
    attribute,
    narrativeHint: hint,
    // No value — this makes it a deferred fact
    validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
  };
}

/** Make a deterministic fact with a concrete value */
function deterministicFact(
  entityId: string,
  attribute: string,
  value: unknown,
) {
  return {
    id: `${entityId}.${attribute}`,
    entityId,
    attribute,
    value,
    validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveDeferredFacts', () => {
  it('should NOT flag a narrativeHint precondition when Pass 2 confirms it (matchLevel=exact)', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Jinx should be anxious and wary'),
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'exact' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(0);
  });

  it('should NOT flag when matchLevel=similar (close enough)', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Jinx should be anxious and wary'),
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'similar' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(0);
  });

  it('should emit error when narrativeHint precondition has matchLevel=absent', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Jinx should be anxious and wary'),
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'absent' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(1);
    expect(deferredIssues[0].severity).toBe('error');
    expect(deferredIssues[0].message).toContain('absent');
    expect(deferredIssues[0].entity).toBe('jinx');
  });

  it('should emit error when narrativeHint precondition has matchLevel=contradicted', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Jinx should be anxious and wary'),
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'contradicted' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(1);
    expect(deferredIssues[0].severity).toBe('error');
    expect(deferredIssues[0].message).toContain('contradicted');
    expect(deferredIssues[0].entity).toBe('jinx');
  });

  it('should emit error when narrativeHint precondition is absent from narrativeChecks entirely', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Jinx should be anxious and wary'),
      ],
    });
    // narrativeChecks array doesn't contain jinx.mood
    const analysis = makeAnalysis([
      { entityId: 'other_char', attribute: 'status', matchLevel: 'exact' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(1);
    expect(deferredIssues[0].message).toContain('unverified');
    expect(deferredIssues[0].entity).toBe('jinx');
  });

  it('should NOT flag deterministic preconditions (value present)', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        deterministicFact('jinx', 'has_key', true),
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'has_key', matchLevel: 'absent' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    // Deterministic facts are skipped because pc.value !== undefined
    expect(deferredIssues).toHaveLength(0);
  });

  it('should NOT flag preconditions without narrativeHint', () => {
    // A precondition with neither value nor narrativeHint is malformed,
    // but we guard by checking narrativeHint explicitly
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        {
          id: 'jinx.mood',
          entityId: 'jinx',
          attribute: 'mood',
          validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
        },
      ],
    });
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'absent' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(0);
  });

  it('should return empty array when analysis is null', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Anxious'),
      ],
    });

    const issues = resolveDeferredFacts(event, null);
    expect(issues).toHaveLength(0);
  });

  it('should return empty array when analysis has no narrativeChecks', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Anxious'),
      ],
    });
    const analysis: AnalysisResult = {
      eventId: 'E1',
      analysis: {}, // no narrativeChecks
    };

    const issues = resolveDeferredFacts(event, analysis);
    expect(issues).toHaveLength(0);
  });

  it('should handle multiple narrativeHint preconditions in one event', () => {
    const event = makeEvent({
      id: 'E1',
      preconditions: [
        narrativeHintFact('jinx', 'mood', 'Anxious'),
        narrativeHintFact('jinx', 'location', 'Should be in the garden'),
        narrativeHintFact('victor', 'status', 'Should appear healthy'),
      ],
    });
    // Only jinx.mood is confirmed — jinx.location is absent, victor.status is contradicted
    const analysis = makeAnalysis([
      { entityId: 'jinx', attribute: 'mood', matchLevel: 'exact' },
      { entityId: 'jinx', attribute: 'location', matchLevel: 'absent' },
      { entityId: 'victor', attribute: 'status', matchLevel: 'contradicted' },
    ]);

    const issues = resolveDeferredFacts(event, analysis);
    const deferredIssues = issues.filter((i) => i.validator === 'DeferredResolver');
    expect(deferredIssues).toHaveLength(2);
    expect(deferredIssues.find((i) => i.entity === 'jinx' && i.attribute === 'location')).toBeTruthy();
    expect(deferredIssues.find((i) => i.entity === 'victor' && i.attribute === 'status')).toBeTruthy();
  });
});
