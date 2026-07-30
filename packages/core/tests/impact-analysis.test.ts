// ============================================================================
// Novalistically — Impact Analysis Tests (D10)
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProjectImpact } from '../src/api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProjectDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nova-impact-${name}-`));
  // nova.yaml
  writeFileSync(join(dir, 'nova.yaml'), 'project: test\ntitle: "Test"\nauthor: "Tester"\n');
  // definitions
  mkdirSync(join(dir, 'definitions'), { recursive: true });
  writeFileSync(
    join(dir, 'definitions', 'state_initial.yaml'),
    `info:
  currentEra: modern
  politicalSituation: stable
threads: []
worldFacts: []
`,
  );
  // chapters
  mkdirSync(join(dir, 'chapters', 'chapter_01'), { recursive: true });
  // _chapter.yaml
  writeFileSync(
    join(dir, 'chapters', 'chapter_01', '_chapter.yaml'),
    'chapter: 1\ntitle: "Chapter 1"\nsummary: "Test"\nintent: "Test intent"\nplannedScenes: 5\n',
  );
  // discourse-ledger.yaml (mandatory reader-order source)
  writeFileSync(
    join(dir, 'definitions', 'discourse-ledger.yaml'),
    [
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
  );
  return dir;
}

function writeEvent(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, 'chapters', 'chapter_01', filename), content);
}

function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
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
    const oldDir = createProjectDir('green-old');
    const newDir = createProjectDir('green-new');

    // Same event except narrativeOrder differs
    const eventYaml = baseE0Yaml();
    writeEvent(oldDir, 'E0.yaml', eventYaml);
    writeEvent(newDir, 'E0.yaml', eventYaml.replace('narrativeOrder: 1', 'narrativeOrder: 2'));

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events).toHaveProperty('E0');
      expect(result.events.E0).toBe('green');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Yellow: event description changed ──────────────────────────────────
  it('should classify as yellow when event data changes but pre/post remain same', () => {
    const oldDir = createProjectDir('yellow-old');
    const newDir = createProjectDir('yellow-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    // Change title and sceneBrief only
    writeEvent(
      newDir,
      'E0.yaml',
      baseE0Yaml()
        .replace('title: "Original Title"', 'title: "Updated Title"')
        .replace('sceneBrief: "Original brief"', 'sceneBrief: "Updated brief"'),
    );

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events).toHaveProperty('E0');
      expect(result.events.E0).toBe('yellow');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Red: precondition changed ──────────────────────────────────────────
  it('should classify as red when a precondition changes', () => {
    const oldDir = createProjectDir('red-pre-old');
    const newDir = createProjectDir('red-pre-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    // Change precondition value
    writeEvent(newDir, 'E0.yaml', baseE0Yaml().replace('value: town', 'value: village'));

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events).toHaveProperty('E0');
      expect(result.events.E0).toBe('red');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Red: postcondition changed ─────────────────────────────────────────
  it('should classify as red when a postcondition changes', () => {
    const oldDir = createProjectDir('red-post-old');
    const newDir = createProjectDir('red-post-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    // Change postcondition value
    writeEvent(
      newDir,
      'E0.yaml',
      baseE0Yaml().replace('value: met_character', 'value: met_stranger'),
    );

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events).toHaveProperty('E0');
      expect(result.events.E0).toBe('red');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Downstream detection ───────────────────────────────────────────────
  it('should detect downstream events when postcondition changes affect other events', () => {
    const oldDir = createProjectDir('down-old');
    const newDir = createProjectDir('down-new');

    // Old: E0 sets narrator.knowledge=met_character, E1 preconditions on it
    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(oldDir, 'E1.yaml', baseE1Yaml());

    // New: E0 postcondition changes, so E1 (which preconditions on
    // narrator.knowledge) should be flagged as downstream
    writeEvent(
      newDir,
      'E0.yaml',
      baseE0Yaml().replace('value: met_character', 'value: met_stranger'),
    );
    writeEvent(newDir, 'E1.yaml', baseE1Yaml());

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      // E0 should be red (postcondition changed)
      expect(result.events.E0).toBe('red');
      // E1 should be in the downstream of E0 because E1's precondition
      // references narrator.knowledge which E0's postcondition changed
      expect(result.downstream).toHaveProperty('E0');
      expect(result.downstream.E0).toContain('E1');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Multiple events, mixed levels ──────────────────────────────────────
  it('should classify multiple events with different impact levels', () => {
    const oldDir = createProjectDir('mixed-old');
    const newDir = createProjectDir('mixed-new');

    // E0: postcondition changes → Red
    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(
      newDir,
      'E0.yaml',
      baseE0Yaml().replace('value: met_character', 'value: met_stranger'),
    );

    // E1: title changes → Yellow
    writeEvent(oldDir, 'E1.yaml', baseE1Yaml());
    writeEvent(
      newDir,
      'E1.yaml',
      baseE1Yaml().replace('title: "Event One"', 'title: "Revised One"'),
    );

    // E2: narrativeOrder changes → Green
    writeEvent(oldDir, 'E2.yaml', baseE2Yaml());
    writeEvent(newDir, 'E2.yaml', baseE2Yaml().replace('narrativeOrder: 3', 'narrativeOrder: 4'));

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events.E0).toBe('red');
      expect(result.events.E1).toBe('yellow');
      expect(result.events.E2).toBe('green');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Empty diff: no changes ─────────────────────────────────────────────
  it('should produce empty result when projects are identical', () => {
    const oldDir = createProjectDir('empty-old');
    const newDir = createProjectDir('empty-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(newDir, 'E0.yaml', baseE0Yaml());

    writeEvent(oldDir, 'E1.yaml', baseE1Yaml());
    writeEvent(newDir, 'E1.yaml', baseE1Yaml());

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      // No changes → no event should be classified
      expect(Object.keys(result.events).length).toBe(0);
      expect(Object.keys(result.downstream).length).toBe(0);
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Event added in new version ─────────────────────────────────────────
  it('should classify added events as red', () => {
    const oldDir = createProjectDir('add-old');
    const newDir = createProjectDir('add-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(newDir, 'E0.yaml', baseE0Yaml());
    // E1 only in new version
    writeEvent(newDir, 'E1.yaml', baseE1Yaml());

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events.E1).toBe('red');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Event removed from new version ─────────────────────────────────────
  it('should classify removed events as red', () => {
    const oldDir = createProjectDir('remove-old');
    const newDir = createProjectDir('remove-new');

    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(oldDir, 'E1.yaml', baseE1Yaml());
    writeEvent(newDir, 'E0.yaml', baseE0Yaml());
    // E1 not in new version

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events.E1).toBe('red');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });

  // ── Downstream: chain E0→E1→E2 affected ───────────────────────────────
  it('should detect downstream events in a chain', () => {
    const oldDir = createProjectDir('chain-old');
    const newDir = createProjectDir('chain-new');

    // Chain: E0 sets narrator.knowledge=met_character
    //        E1 preconditions on narrator.knowledge and sets hero.location=forest
    //        E2 preconditions on hero.location
    writeEvent(oldDir, 'E0.yaml', baseE0Yaml());
    writeEvent(oldDir, 'E1.yaml', baseE1Yaml());
    writeEvent(oldDir, 'E2.yaml', baseE2Yaml());

    // Change E0's postcondition → E1 and E2 should be downstream
    writeEvent(
      newDir,
      'E0.yaml',
      baseE0Yaml().replace('value: met_character', 'value: met_stranger'),
    );
    writeEvent(newDir, 'E1.yaml', baseE1Yaml());
    writeEvent(newDir, 'E2.yaml', baseE2Yaml());

    try {
      const result = analyzeProjectImpact(oldDir, newDir);
      expect(result.events.E0).toBe('red');
      expect(result.downstream.E0).toBeDefined();

      // E1 preconditions on narrator.knowledge → downstream
      expect(result.downstream.E0).toContain('E1');
      // E2 does NOT directly precondition on narrator.knowledge,
      // so it shouldn't be in E0's direct downstream
      expect(result.downstream.E0).not.toContain('E2');
    } finally {
      cleanupDir(oldDir);
      cleanupDir(newDir);
    }
  });
});
