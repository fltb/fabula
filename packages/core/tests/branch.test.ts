import { describe, it, expect } from 'vitest';
import type { BranchSet, BranchPoint, Condition } from '../src/types/index.js';
import {
  createEmptyBranchPath,
  branchPathsEqual,
  evaluateCondition,
  includesPath,
  branchPathToString,
  isLinearNarrative,
  createBranchPoint,
  getAvailableChoices,
} from '../src/branch/index.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────

const linearPath = createEmptyBranchPath();

const pathA = {
  decisions: [
    { atEventId: 'evt_1', choiceId: 'trust_seraphine', narrativeOrder: 1 },
    { atEventId: 'evt_2', choiceId: 'attack', narrativeOrder: 2 },
  ],
};

const pathB = {
  decisions: [
    { atEventId: 'evt_1', choiceId: 'trust_seraphine', narrativeOrder: 1 },
    { atEventId: 'evt_2', choiceId: 'flee', narrativeOrder: 2 },
  ],
};

const pathC = {
  decisions: [
    { atEventId: 'evt_1', choiceId: 'trust_seraphine', narrativeOrder: 1 },
    { atEventId: 'evt_2', choiceId: 'attack', narrativeOrder: 2 },
  ],
};

// ─── 1. createEmptyBranchPath ───────────────────────────────────────────────

describe('createEmptyBranchPath', () => {
  it('returns a BranchPath with an empty decisions array', () => {
    const bp = createEmptyBranchPath();
    expect(bp).toEqual({ decisions: [] });
  });

  it('returns a new object each call', () => {
    const a = createEmptyBranchPath();
    const b = createEmptyBranchPath();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ─── 4. branchPathsEqual ────────────────────────────────────────────────────

describe('branchPathsEqual', () => {
  it('returns true for identical paths', () => {
    expect(branchPathsEqual(pathA, pathC)).toBe(true);
  });

  it('returns false for different paths', () => {
    expect(branchPathsEqual(pathA, pathB)).toBe(false);
  });

  it('returns true for two empty paths', () => {
    expect(branchPathsEqual(linearPath, createEmptyBranchPath())).toBe(true);
  });

  it('returns false when one path has more decisions', () => {
    const short = { decisions: [{ atEventId: 'evt_1', choiceId: 'trust_seraphine', narrativeOrder: 1 }] };
    expect(branchPathsEqual(short, pathA)).toBe(false);
  });
});

// ─── 3. evaluateCondition ───────────────────────────────────────────────────

describe('evaluateCondition', () => {
  it('equals: matches a literal field value', () => {
    const c: Condition = { type: 'equals', field: 'decisions.0.choiceId', value: 'trust_seraphine' };
    expect(evaluateCondition(c, pathA)).toBe(true);
    expect(evaluateCondition(c, linearPath)).toBe(false); // no decisions, field undefined
  });

  it('not_equals: negates equality', () => {
    // pathA.decisions[0].choiceId = 'trust_seraphine' (≠ 'flee')
    const c: Condition = { type: 'not_equals', field: 'decisions.0.choiceId', value: 'flee' };
    expect(evaluateCondition(c, pathA)).toBe(true);
    // pathB.decisions[1].choiceId = 'flee'
    const c2: Condition = { type: 'not_equals', field: 'decisions.1.choiceId', value: 'flee' };
    expect(evaluateCondition(c2, pathB)).toBe(false);
  });

  it('greater_than: numeric comparison', () => {
    const c: Condition = { type: 'greater_than', field: 'decisions.length', value: 1 };
    expect(evaluateCondition(c, pathA)).toBe(true);  // length 2
    expect(evaluateCondition(c, linearPath)).toBe(false); // length 0
  });

  it('less_than: numeric comparison', () => {
    const c: Condition = { type: 'less_than', field: 'decisions.length', value: 2 };
    expect(evaluateCondition(c, linearPath)).toBe(true);  // length 0
    expect(evaluateCondition(c, pathA)).toBe(false); // length 2
  });

  it('contains: array inclusion', () => {
    const c: Condition = { type: 'contains', field: 'decisions.0.choiceId', value: 'trust' };
    // "trust_seraphine".includes("trust") — but contains on a string, not array, so false
    expect(evaluateCondition(c, pathA)).toBe(false);
    // A proper array case
    const arrCheck: Condition = { type: 'contains', field: 'decisions', value: pathA.decisions[0] };
    expect(evaluateCondition(arrCheck, pathA)).toBe(true);
  });

  it('and: all sub-conditions satisfied', () => {
    const c: Condition = {
      type: 'and',
      conditions: [
        { type: 'equals', field: 'decisions.0.choiceId', value: 'trust_seraphine' },
        { type: 'equals', field: 'decisions.1.choiceId', value: 'attack' },
      ],
    };
    expect(evaluateCondition(c, pathA)).toBe(true);
    expect(evaluateCondition(c, pathB)).toBe(false);
  });

  it('and: empty conditions is vacuous truth', () => {
    const c: Condition = { type: 'and', conditions: [] };
    expect(evaluateCondition(c, pathA)).toBe(true);
  });

  it('or: at least one sub-condition satisfied', () => {
    const c: Condition = {
      type: 'or',
      conditions: [
        { type: 'equals', field: 'decisions.1.choiceId', value: 'attack' },
        { type: 'equals', field: 'decisions.1.choiceId', value: 'flee' },
      ],
    };
    expect(evaluateCondition(c, pathA)).toBe(true);  // matches "attack"
    expect(evaluateCondition(c, pathB)).toBe(true);  // matches "flee"
  });

  it('or: empty conditions is false', () => {
    const c: Condition = { type: 'or', conditions: [] };
    expect(evaluateCondition(c, pathA)).toBe(false);
  });

  it('greater_than/less_than with non-numeric values returns false', () => {
    const c1: Condition = { type: 'greater_than', field: 'decisions.0.choiceId', value: 1 };
    expect(evaluateCondition(c1, pathA)).toBe(false);
    const c2: Condition = { type: 'less_than', field: 'decisions.0.choiceId', value: 'attack' };
    expect(evaluateCondition(c2, pathA)).toBe(false);
  });

  it('unknown type returns false', () => {
    const c = { type: 'unknown' as Condition['type'], field: 'decisions.length', value: 0 };
    expect(evaluateCondition(c, pathA)).toBe(false);
  });
});

// ─── 2. includesPath ────────────────────────────────────────────────────────

describe('includesPath', () => {
  // --- empty branch path rule ---
  it('empty branch path returns true for { type: "all" }', () => {
    expect(includesPath({ type: 'all' }, linearPath)).toBe(true);
  });

  it('empty branch path returns true for { type: "paths" }', () => {
    expect(includesPath({ type: 'paths', paths: [pathA] }, linearPath)).toBe(true);
  });

  it('empty branch path returns true for { type: "except" }', () => {
    const bs: BranchSet = { type: 'except', branches: { type: 'all' } };
    expect(includesPath(bs, linearPath)).toBe(true);
  });

  it('empty branch path returns true for { type: "condition" }', () => {
    const bs: BranchSet = {
      type: 'condition',
      condition: { type: 'equals', field: 'decisions.length', value: 5 },
    };
    expect(includesPath(bs, linearPath)).toBe(true);
  });

  // --- "all" ---
  it('all: always true for any non-empty path', () => {
    expect(includesPath({ type: 'all' }, pathA)).toBe(true);
    expect(includesPath({ type: 'all' }, pathB)).toBe(true);
  });

  // --- "paths" ---
  it('paths: matches when path is in the list', () => {
    const bs: BranchSet = { type: 'paths', paths: [pathA, pathB] };
    expect(includesPath(bs, pathA)).toBe(true);
    expect(includesPath(bs, pathC)).toBe(true);  // deep equal to pathA
  });

  it('paths: does not match when path is not in the list', () => {
    const bs: BranchSet = { type: 'paths', paths: [pathA] };
    expect(includesPath(bs, pathB)).toBe(false);
  });

  it('paths: empty list never matches non-empty path', () => {
    const bs: BranchSet = { type: 'paths', paths: [] };
    expect(includesPath(bs, pathA)).toBe(false);
  });

  // --- "except" ---
  it('except: negates the inner BranchSet', () => {
    const inner: BranchSet = { type: 'paths', paths: [pathA] };
    const bs: BranchSet = { type: 'except', branches: inner };
    expect(includesPath(bs, pathA)).toBe(false);  // inner says yes → negated
    expect(includesPath(bs, pathB)).toBe(true);   // inner says no → negated → yes
  });

  // --- "condition" ---
  it('condition: delegates to evaluateCondition', () => {
    const bs: BranchSet = {
      type: 'condition',
      condition: { type: 'equals', field: 'decisions.0.choiceId', value: 'trust_seraphine' },
    };
    expect(includesPath(bs, pathA)).toBe(true);
    expect(includesPath(bs, pathB)).toBe(true);   // both trust_seraphine
    // path with different first decision
    const pathDiff = { decisions: [{ atEventId: 'evt_1', choiceId: 'distrust', narrativeOrder: 1 }] };
    expect(includesPath(bs, pathDiff)).toBe(false);
  });
});

// ─── 5. branchPathToString ──────────────────────────────────────────────────

describe('branchPathToString', () => {
  it('formats a multi-decision path', () => {
    expect(branchPathToString(pathA)).toBe('BP1:trust_seraphine → BP2:attack');
  });

  it('returns "Linear" for an empty path', () => {
    expect(branchPathToString(linearPath)).toBe('Linear');
  });

  it('formats a single-decision path', () => {
    const single = { decisions: [{ atEventId: 'evt_1', choiceId: 'flee', narrativeOrder: 3 }] };
    expect(branchPathToString(single)).toBe('BP3:flee');
  });
});

// ─── 6. isLinearNarrative ──────────────────────────────────────────────────

describe('isLinearNarrative', () => {
  it('returns true for empty decisions', () => {
    expect(isLinearNarrative(linearPath)).toBe(true);
  });

  it('returns false when decisions exist', () => {
    expect(isLinearNarrative(pathA)).toBe(false);
  });
});

// ─── 7. createBranchPoint ───────────────────────────────────────────────────

describe('createBranchPoint', () => {
  it('creates a BranchPoint with the provided fields', () => {
    const bp = createBranchPoint('bp_cave', 'evt_enter_cave', 'Enter the cave', [
      { choiceId: 'light_torch', label: 'Light a torch', narrativeOrder: 1 },
      { choiceId: 'stay_dark', label: 'Proceed in darkness', narrativeOrder: 2 },
    ]);

    expect(bp.branchPointId).toBe('bp_cave');
    expect(bp.atEventId).toBe('evt_enter_cave');
    expect(bp.description).toBe('Enter the cave');
    expect(bp.choices).toHaveLength(2);
  });

  it('defaults existenceCondition to { type: "all" }', () => {
    const bp = createBranchPoint('bp_test', 'evt_test', 'Test', []);
    expect(bp.existenceCondition).toEqual({ type: 'all' });
  });

  it('choices are passed through as-is', () => {
    const choices = [
      { choiceId: 'a', label: 'A', condition: { type: 'equals' as const, field: 'decisions.length', value: 1 }, narrativeOrder: 1 },
    ];
    const bp = createBranchPoint('bp', 'evt', 'desc', choices);
    expect(bp.choices[0].condition).toEqual({ type: 'equals', field: 'decisions.length', value: 1 });
  });
});

// ─── 8. getAvailableChoices ─────────────────────────────────────────────────

describe('getAvailableChoices', () => {
  it('returns all choices when none have conditions', () => {
    const bp = createBranchPoint('bp', 'evt', 'desc', [
      { choiceId: 'a', label: 'A', narrativeOrder: 1 },
      { choiceId: 'b', label: 'B', narrativeOrder: 2 },
    ]);
    expect(getAvailableChoices(bp, pathA)).toHaveLength(2);
  });

  it('filters choices whose conditions are not satisfied', () => {
    const bp = createBranchPoint('bp', 'evt', 'desc', [
      { choiceId: 'open', label: 'Open the door', narrativeOrder: 1 },
      {
        choiceId: 'unlock',
        label: 'Pick the lock',
        condition: { type: 'equals', field: 'decisions.0.choiceId', value: 'has_lockpicks' },
        narrativeOrder: 2,
      },
    ]);

    const pathNoPicks = { decisions: [{ atEventId: 'evt_prev', choiceId: 'search_room', narrativeOrder: 1 }] };
    const pathWithPicks = { decisions: [{ atEventId: 'evt_prev', choiceId: 'has_lockpicks', narrativeOrder: 1 }] };

    const avail1 = getAvailableChoices(bp, pathNoPicks);
    expect(avail1).toHaveLength(1);
    expect(avail1[0].choiceId).toBe('open');

    const avail2 = getAvailableChoices(bp, pathWithPicks);
    expect(avail2).toHaveLength(2);
  });

  it('returns empty array when all choices are conditional and none match', () => {
    const bp = createBranchPoint('bp', 'evt', 'desc', [
      {
        choiceId: 'secret',
        label: 'Secret path',
        condition: { type: 'equals', field: 'decisions.0.choiceId', value: 'found_secret' },
        narrativeOrder: 1,
      },
    ]);
    expect(getAvailableChoices(bp, pathA)).toHaveLength(0);
  });
});
