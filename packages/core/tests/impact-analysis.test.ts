// ============================================================================
// Novalistically — Impact Analysis Tests (D10)
// ============================================================================

import { describe, expect, it } from 'vitest';
import { analyzeProjectImpact } from '../src/api.js';
import type { ProjectSourceSnapshotV1 } from '../src/contracts/source.ts';
import { createSourceSnapshot } from './fixtures/source-snapshot.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an immutable source snapshot with the canonical project skeleton plus
 * the given event documents (`{ logicalPath: content }`). No storage, no
 * project directory — only ProjectSourceSnapshotV1 values.
 */
function project(events: Record<string, string> = {}): ProjectSourceSnapshotV1 {
  const base: Record<string, string> = {
    'nova.yaml': 'project: test\ntitle: "Test"\nauthor: "Tester"\n',
    'definitions/state_initial.yaml':
      'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/entity-types.yaml': [
      'types:',
      '  narrator:',
      '    typeId: narrator',
      '    kind: character',
      '    attributes:',
      '      location:',
      '        attributeId: location',
      '        valueType: string',
      '        requiredAt: never',
      '        writePolicy: mutable',
      '        unsetAllowed: true',
      '      knowledge:',
      '        attributeId: knowledge',
      '        valueType: string',
      '        requiredAt: never',
      '        writePolicy: mutable',
      '        unsetAllowed: true',
      '    lifecyclePolicy:',
      '      allowedTransitions: []',
      '    referenceCapabilities:',
      '      defaultEligibility: live',
      '    typedInvariants: []',
      '  hero:',
      '    typeId: hero',
      '    kind: character',
      '    attributes:',
      '      location:',
      '        attributeId: location',
      '        valueType: string',
      '        requiredAt: never',
      '        writePolicy: mutable',
      '        unsetAllowed: true',
      '      status:',
      '        attributeId: status',
      '        valueType: string',
      '        requiredAt: never',
      '        writePolicy: mutable',
      '        unsetAllowed: true',
      '    lifecyclePolicy:',
      '      allowedTransitions: []',
      '    referenceCapabilities:',
      '      defaultEligibility: live',
      '    typedInvariants: []',
    ].join('\n'),
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: "Chapter 1"\nsummary: "Test"\nintent: "Test intent"\nplannedScenes: 5\n',
    'definitions/discourse-ledger.yaml': [
      'id: impact-ledger',
      'chapters:',
      '  - branch: main',
      '    chapter: 1',
      '    sceneIds:',
      '      - E0',
      '      - E1',
      '      - E2',
      'entries: []',
    ].join('\n'),
  };
  return createSourceSnapshot({ ...base, ...events });
}

// ---------------------------------------------------------------------------
// Fixture helpers — produce YAML event strings
// ---------------------------------------------------------------------------

function baseE0Yaml(): string {
  return `event: E0
title: "Original Title"
narrativeOrder: 1
sceneType: linear
storyTime: day_1
pov:
  character: narrator
  type: first_person
sceneBrief: "Original brief"
beats:
  - "Original brief"
preconditions:
  - entity: narrator
    attribute: location
    value: town
expectedPostconditions:
  - entity: narrator
    attribute: knowledge
    value: met_character
`;
}

function baseE1Yaml(): string {
  return `event: E1
title: "Event One"
narrativeOrder: 2
sceneType: linear
storyTime: day_2
pov:
  character: hero
  type: third_person_limited
sceneBrief: "First event"
beats:
  - "First event"
preconditions:
  - entity: narrator
    attribute: knowledge
    value: met_character
expectedPostconditions:
  - entity: hero
    attribute: location
    value: forest
`;
}

function baseE2Yaml(): string {
  return `event: E2
title: "Event Two"
narrativeOrder: 3
sceneType: linear
storyTime: day_3
pov:
  character: hero
  type: third_person_limited
sceneBrief: "Second event"
beats:
  - "Second event"
preconditions:
  - entity: hero
    attribute: location
    value: forest
expectedPostconditions:
  - entity: hero
    attribute: status
    value: victorious
`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analyzeProjectImpact', () => {
  // ── Green: only narrativeOrder changed ─────────────────────────────────
  it('should classify as green when only narrativeOrder changes', () => {
    // Same event except narrativeOrder differs
    const oldSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace('narrativeOrder: 1', 'narrativeOrder: 2'),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events).toHaveProperty('E0');
    expect(result.events.E0).toBe('green');
  });

  // ── Yellow: event description changed ──────────────────────────────────
  it('should classify as yellow when event data changes but pre/post remain same', () => {
    const oldSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });
    // Change title and sceneBrief only
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml()
        .replace('title: "Original Title"', 'title: "Updated Title"')
        .replace('sceneBrief: "Original brief"', 'sceneBrief: "Updated brief"'),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events).toHaveProperty('E0');
    expect(result.events.E0).toBe('yellow');
  });

  // ── Red: precondition changed ──────────────────────────────────────────
  it('should classify as red when a precondition changes', () => {
    const oldSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });
    // Change precondition value
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace('value: town', 'value: village'),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events).toHaveProperty('E0');
    expect(result.events.E0).toBe('red');
  });

  // ── Red: postcondition changed ─────────────────────────────────────────
  it('should classify as red when a postcondition changes', () => {
    const oldSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });
    // Change postcondition value
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace(
        'value: met_character',
        'value: met_stranger',
      ),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events).toHaveProperty('E0');
    expect(result.events.E0).toBe('red');
  });

  // ── Downstream detection ───────────────────────────────────────────────
  it('should detect downstream events when postcondition changes affect other events', () => {
    // Old: E0 sets narrator.knowledge=met_character, E1 preconditions on it
    const oldSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });

    // New: E0 postcondition changes, so E1 (which preconditions on
    // narrator.knowledge) should be flagged as downstream
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace(
        'value: met_character',
        'value: met_stranger',
      ),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    // E0 should be red (postcondition changed)
    expect(result.events.E0).toBe('red');
    // E1 should be in the downstream of E0 because E1's precondition
    // references narrator.knowledge which E0's postcondition changed
    expect(result.downstream).toHaveProperty('E0');
    expect(result.downstream.E0).toContain('E1');
  });

  // ── Multiple events, mixed levels ──────────────────────────────────────
  it('should classify multiple events with different impact levels', () => {
    // E0: postcondition changes → Red
    const oldSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
      'chapters/chapter_01/E2.yaml': baseE2Yaml(),
    });
    const newSnapshot = project({
      // E0: postcondition changes → Red
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace(
        'value: met_character',
        'value: met_stranger',
      ),
      // E1: title changes → Yellow
      'chapters/chapter_01/E1.yaml': baseE1Yaml().replace(
        'title: "Event One"',
        'title: "Revised One"',
      ),
      // E2: narrativeOrder changes → Green
      'chapters/chapter_01/E2.yaml': baseE2Yaml().replace('narrativeOrder: 3', 'narrativeOrder: 4'),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events.E0).toBe('red');
    expect(result.events.E1).toBe('yellow');
    expect(result.events.E2).toBe('green');
  });

  // ── Empty diff: no changes ─────────────────────────────────────────────
  it('should produce empty result when projects are identical', () => {
    const oldSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    // No changes → no event should be classified
    expect(Object.keys(result.events).length).toBe(0);
    expect(Object.keys(result.downstream).length).toBe(0);
  });

  // ── Event added in new version ─────────────────────────────────────────
  it('should classify added events as red', () => {
    const oldSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });
    // E1 only in new version
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events.E1).toBe('red');
  });

  // ── Event removed from new version ─────────────────────────────────────
  it('should classify removed events as red', () => {
    const oldSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
    });
    // E1 not in new version
    const newSnapshot = project({ 'chapters/chapter_01/E0.yaml': baseE0Yaml() });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events.E1).toBe('red');
  });

  // ── Downstream: chain E0→E1→E2 affected ───────────────────────────────
  it('should detect downstream events in a chain', () => {
    // Chain: E0 sets narrator.knowledge=met_character
    //        E1 preconditions on narrator.knowledge and sets hero.location=forest
    //        E2 preconditions on hero.location
    const oldSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml(),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
      'chapters/chapter_01/E2.yaml': baseE2Yaml(),
    });

    // Change E0's postcondition → E1 and E2 should be downstream
    const newSnapshot = project({
      'chapters/chapter_01/E0.yaml': baseE0Yaml().replace(
        'value: met_character',
        'value: met_stranger',
      ),
      'chapters/chapter_01/E1.yaml': baseE1Yaml(),
      'chapters/chapter_01/E2.yaml': baseE2Yaml(),
    });

    const result = analyzeProjectImpact(oldSnapshot, newSnapshot);
    expect(result.events.E0).toBe('red');
    expect(result.downstream.E0).toBeDefined();

    // E1 preconditions on narrator.knowledge → downstream
    expect(result.downstream.E0).toContain('E1');
    // E2 does NOT directly precondition on narrator.knowledge,
    // so it shouldn't be in E0's direct downstream
    expect(result.downstream.E0).not.toContain('E2');
  });
});
