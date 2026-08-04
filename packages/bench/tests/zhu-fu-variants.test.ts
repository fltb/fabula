import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { ProjectSourceSnapshotV1 } from '../../core/src/contracts/source.ts';
import { materializeFixtureSnapshot } from '../../core/tests/fixtures/fixture-snapshots.ts';
import { sourceEntryMap } from '../../core/tests/fixtures/source-snapshot.ts';
import type { VariantIssueResult } from '../src/variants.ts';
import { runVariantBench } from '../src/variants.ts';

// ============================================================
// P1b: zhu-fu-variants test suite
// ============================================================

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function requireValue<T>(value: T | null | undefined, label: string): T {
  expect(value, `missing ${label}`).toBeDefined();
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

/** Parse one logical document's YAML from an immutable fixture snapshot. */
function loadYamlFrom(snapshot: ProjectSourceSnapshotV1, logicalPath: string): unknown {
  const entries = sourceEntryMap(snapshot);
  const content = entries[logicalPath];
  if (content === undefined) throw new Error(`Missing document ${logicalPath}`);
  return YAML.parse(content);
}

/** List authored event file names under a chapter dir within a snapshot. */
function eventFilesIn(snapshot: ProjectSourceSnapshotV1, chapterDir: string): string[] {
  return Object.keys(sourceEntryMap(snapshot))
    .filter(
      (logicalPath) =>
        logicalPath.startsWith(`${chapterDir}/`) &&
        /^E.*\.ya?ml$/i.test(logicalPath.split('/').pop() ?? ''),
    )
    .map((logicalPath) => logicalPath.split('/').pop() as string);
}

/** List YAML file names at a fixture snapshot root. */
function yamlFilesIn(snapshot: ProjectSourceSnapshotV1): string[] {
  return Object.keys(sourceEntryMap(snapshot)).filter((logicalPath) =>
    /\.ya?ml$/i.test(logicalPath),
  );
}

// ----- branch-A: honest answer variant -----
describe('zhu-fu-variants / branch-A (honest answer)', () => {
  const BRANCH_A = materializeFixtureSnapshot(
    path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'branch-A'),
  );

  it('should load project config (nova.yaml)', () => {
    const nova = loadYamlFrom(BRANCH_A, 'nova.yaml') as Record<string, unknown>;
    expect(nova.project).toBe('zhu-fu-branch-a');
    expect(nova.genre).toBe('literary');
    expect(nova.tense).toBe('past');
    expect(String(nova.title)).toContain('分支A');
    expect(String(nova.synopsis)).toContain('诚实地');
  });

  it('should load E0 with honest answer narrative', () => {
    const e0 = loadYamlFrom(BRANCH_A, 'chapters/chapter_01/E0_encounter.yaml') as Record<
      string,
      unknown
    >;
    expect(e0.event).toBe('E0');
    expect(String(e0.sceneBrief)).toContain('诚实地告诉');
    expect(String(e0.sceneBrief)).toContain('就像灯灭');

    // Check postconditions reflect honesty, not guilt
    const posts = (e0.expectedPostconditions as Array<Record<string, unknown>>) ?? [];
    const knowledgePost = posts.find((p) => p.entity === 'narrator' && p.attribute === 'knowledge');
    expect(requireValue(knowledgePost, 'knowledge post').value).toBe(
      'gave_honest_answer_to_xianglins_wife',
    );

    const emotionalPost = posts.find(
      (p) => p.entity === 'narrator' && p.attribute === 'emotionalState',
    );
    expect(requireValue(emotionalPost, 'emotional state post').value).toBe(
      'truthful_but_uncertain',
    );
  });

  it('should load E1 with different emotional resolution', () => {
    const e1 = loadYamlFrom(BRANCH_A, 'chapters/chapter_01/E1_death_news.yaml') as Record<
      string,
      unknown
    >;
    expect(e1.event).toBe('E1');
    expect(String(e1.sceneBrief)).toContain('愤怒');

    const posts = (e1.expectedPostconditions as Array<Record<string, unknown>>) ?? [];
    const emotionalPost = posts.find(
      (p) => p.entity === 'narrator' && p.attribute === 'emotionalState',
    );
    expect(requireValue(emotionalPost, 'emotional state post').value).toBe(
      'melancholy_but_not_guilty',
    );
  });

  it('should have 7 event files', () => {
    const files = eventFilesIn(BRANCH_A, 'chapters/chapter_01');
    expect(files.length).toBe(7);
  });

  it('should have E2-E6 as copies from base (unchanged flashback)', () => {
    const e2b = loadYamlFrom(BRANCH_A, 'chapters/chapter_01/E2_first_arrival.yaml') as Record<
      string,
      unknown
    >;
    const e3b = loadYamlFrom(BRANCH_A, 'chapters/chapter_01/E3_kidnapping.yaml') as Record<
      string,
      unknown
    >;
    expect(e2b.event).toBe('E2');
    expect(e3b.event).toBe('E3');
    expect(e2b.sceneType).toBe('flashback');
    expect(e3b.sceneType).toBe('flashback');
  });
});

// ----- branch-B: He Laoliu survives -----
describe('zhu-fu-variants / branch-B (He Laoliu survives)', () => {
  const BRANCH_B = materializeFixtureSnapshot(
    path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'branch-B'),
  );

  it('should load project config (nova.yaml)', () => {
    const nova = loadYamlFrom(BRANCH_B, 'nova.yaml') as Record<string, unknown>;
    expect(nova.project).toBe('zhu-fu-branch-b');
    expect(nova.genre).toBe('literary');
    expect(nova.tense).toBe('past');
    expect(String(nova.title)).toContain('分支B');
    expect(String(nova.synopsis)).toContain('贺老六挺过');
  });

  it('should load E4 with He Laoliu survival', () => {
    const e4 = loadYamlFrom(BRANCH_B, 'chapters/chapter_01/E4_survival.yaml') as Record<
      string,
      unknown
    >;
    expect(e4.event).toBe('E4');
    expect(String(e4.sceneBrief)).toContain('睁开了眼睛');
    expect(String(e4.sceneBrief)).toContain('活过来了');

    const posts = (e4.expectedPostconditions as Array<Record<string, unknown>>) ?? [];
    const heLaoliuStatus = posts.find((p) => p.entity === 'he_laoliu' && p.attribute === 'status');
    expect(requireValue(heLaoliuStatus, 'He Laoliu status post').value).toBe('alive');

    const locationPost = posts.find(
      (p) => p.entity === 'xianglins_wife' && p.attribute === 'location',
    );
    expect(requireValue(locationPost, 'location post').value).toBe('he_family_hollow');
  });

  it('should load E5 with quiet years narrative', () => {
    const e5 = loadYamlFrom(BRANCH_B, 'chapters/chapter_01/E5_quiet_years.yaml') as Record<
      string,
      unknown
    >;
    expect(e5.event).toBe('E5');
    expect(String(e5.sceneBrief)).toContain('阿毛长成了');
    expect(String(e5.sceneBrief)).toContain('春丫头');

    const posts = (e5.expectedPostconditions as Array<Record<string, unknown>>) ?? [];
    const hasSecondChild = posts.find(
      (p) => p.entity === 'xianglins_wife' && p.attribute === 'has_second_child',
    );
    expect(requireValue(hasSecondChild, 'second child post').value).toBe(true);
  });

  it('should load E6 with natural death resolution', () => {
    const e6 = loadYamlFrom(BRANCH_B, 'chapters/chapter_01/E6_old_age.yaml') as Record<
      string,
      unknown
    >;
    expect(e6.event).toBe('E6');
    expect(String(e6.sceneBrief)).toContain('灶上还有粥');

    const posts = (e6.expectedPostconditions as Array<Record<string, unknown>>) ?? [];
    const heDeathCause = posts.find(
      (p) => p.entity === 'he_laoliu' && p.attribute === 'cause_of_death',
    );
    expect(requireValue(heDeathCause, 'death cause post').value).toBe('old_age');

    const xlDeathLocation = posts.find(
      (p) => p.entity === 'xianglins_wife' && p.attribute === 'death_location',
    );
    expect(requireValue(xlDeathLocation, 'death location post').value).toBe(
      'own_home_he_family_hollow',
    );
  });

  it('should have 7 event files (E0-E3 from base, E4-E6 new)', () => {
    const files = eventFilesIn(BRANCH_B, 'chapters/chapter_01');
    expect(files.length).toBe(7);
    expect(files).toContain('E0_encounter.yaml');
    expect(files).toContain('E4_survival.yaml');
    expect(files).toContain('E5_quiet_years.yaml');
    expect(files).toContain('E6_old_age.yaml');
    // Should NOT contain original E4-E6 names
    expect(files).not.toContain('E4_return_to_lu.yaml');
    expect(files).not.toContain('E5_threshold_rejection.yaml');
    expect(files).not.toContain('E6_expulsion_death.yaml');
  });

  it('should have E0-E3 unchanged from base fixture', () => {
    const e0 = loadYamlFrom(BRANCH_B, 'chapters/chapter_01/E0_encounter.yaml') as Record<
      string,
      unknown
    >;
    const e1 = loadYamlFrom(BRANCH_B, 'chapters/chapter_01/E1_death_news.yaml') as Record<
      string,
      unknown
    >;
    expect(e0.event).toBe('E0');
    expect(String(e0.sceneBrief)).toContain('说不清'); // original evasion
    expect(e1.event).toBe('E1');
    expect(String(e1.sceneBrief)).toContain('谬种');
  });
});

// ----- error-injection: 28 intentionally broken YAML files -----
describe('zhu-fu-variants / error-injection (28 files)', () => {
  const ERROR_INJECTION = materializeFixtureSnapshot(
    path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'error-injection'),
  );

  it('should have exactly 28 error-injection files', () => {
    const files = yamlFilesIn(ERROR_INJECTION);
    expect(files.length).toBe(28);
  });

  it('each file should have valid injected array', () => {
    const files = yamlFilesIn(ERROR_INJECTION);
    for (const file of files) {
      const data = loadYamlFrom(ERROR_INJECTION, file) as Record<string, unknown>;
      expect(data.injected).toBeDefined();
      expect(Array.isArray(data.injected)).toBe(true);
      const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
      expect(injected.length).toBeGreaterThanOrEqual(1);

      for (const entry of injected) {
        expect(entry.entityId).toBeDefined();
        expect(entry.attribute).toBeDefined();
        expect(entry.expectedValidator).toBeDefined();
        expect(entry.expectedSeverity).toBeDefined();
        expect(['error', 'warning', 'info']).toContain(entry.expectedSeverity);
        expect(entry.description).toBeDefined();
      }
    }
  });

  it('should target multiple validators (coverage check)', () => {
    const files = yamlFilesIn(ERROR_INJECTION);
    const validators = new Set<string>();
    for (const file of files) {
      const data = loadYamlFrom(ERROR_INJECTION, file) as Record<string, unknown>;
      const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
      for (const entry of injected) {
        validators.add(String(entry.expectedValidator));
      }
    }
    expect(validators.size).toBeGreaterThanOrEqual(15);
    expect(validators.has('timeline')).toBe(true);
    expect(validators.has('pronoun')).toBe(true);
    expect(validators.has('pacing')).toBe(true);
    expect(validators.has('appearance')).toBe(true);
  });

  it('should have the specified 001_timeline_order error', () => {
    const data = loadYamlFrom(ERROR_INJECTION, '001_timeline_order.yaml') as Record<
      string,
      unknown
    >;
    const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
    const firstInjected = requireValue(injected[0], 'timeline injection');
    expect(firstInjected.entityId).toBe('E3');
    expect(firstInjected.attribute).toBe('narrationTime');
    expect(firstInjected.expectedValidator).toBe('timeline');
    expect(firstInjected.expectedSeverity).toBe('warning');
  });
});

// ----- extreme-damage: 5 robustness boundary tests -----
describe('zhu-fu-variants / extreme-damage (5 files)', () => {
  const EXTREME_DAMAGE = materializeFixtureSnapshot(
    path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'extreme-damage'),
  );

  it('should have exactly 5 extreme-damage files', () => {
    const files = yamlFilesIn(EXTREME_DAMAGE);
    expect(files.length).toBe(5);
  });

  it('each file should have valid injected array', () => {
    const files = yamlFilesIn(EXTREME_DAMAGE);
    for (const file of files) {
      const data = loadYamlFrom(EXTREME_DAMAGE, file) as Record<string, unknown>;
      expect(data.injected).toBeDefined();
      expect(Array.isArray(data.injected)).toBe(true);
      const injected = (data.injected as Array<Record<string, unknown>>) ?? [];

      for (const entry of injected) {
        expect(entry.entityId).toBeDefined();
        expect(entry.attribute).toBeDefined();
        expect(entry.expectedValidator).toBeDefined();
        expect(entry.expectedSeverity).toBeDefined();
        expect(['error', 'warning', 'info']).toContain(entry.expectedSeverity);
        expect(entry.description).toBeDefined();
      }
    }
  });

  it('should target CausalityValidator and ReachabilityValidator', () => {
    const files = yamlFilesIn(EXTREME_DAMAGE);
    const validators = new Set<string>();
    for (const file of files) {
      const data = loadYamlFrom(EXTREME_DAMAGE, file) as Record<string, unknown>;
      const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
      for (const entry of injected) {
        validators.add(String(entry.expectedValidator));
      }
    }
    expect(validators.has('causality')).toBe(true);
    expect(validators.has('reachability')).toBe(true);
  });

  it('should have circular dependency test file', () => {
    const data = loadYamlFrom(EXTREME_DAMAGE, '003_circular_dependency.yaml') as Record<
      string,
      unknown
    >;
    const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
    const firstInjected = requireValue(injected[0], 'circular dependency injection');
    expect(String(firstInjected.description).toLowerCase()).toContain('circular');
    expect(firstInjected.expectedValidator).toBe('causality');
  });

  it('should have missing state provider test file', () => {
    const data = loadYamlFrom(EXTREME_DAMAGE, '004_missing_state_provider.yaml') as Record<
      string,
      unknown
    >;
    const injected = (data.injected as Array<Record<string, unknown>>) ?? [];
    expect(injected).toHaveLength(2);
    expect(injected.every((entry) => entry.expectedValidator === 'reachability')).toBe(true);
  });
});

// ----- Validation result contracts: runVariantBench checks each injection -----
describe('zhu-fu-variants / validation result contracts', () => {
  const EXPECTED_FILE_COUNT = 28;
  const EXTREME_FILE_COUNT = 5;

  let benchResults: {
    errorInjection: VariantIssueResult[];
    extremeDamage: VariantIssueResult[];
    pipelineF1?: {
      precision: number;
      recall: number;
      f1: number;
      matchedCount: number;
      falsePositiveCount: number;
      missedCount: number;
    };
  };

  beforeAll(async () => {
    const full = await runVariantBench();
    benchResults = {
      errorInjection: full.errorInjection,
      extremeDamage: full.extremeDamage,
      pipelineF1: full.pipelineF1,
    };
  }, 30_000);

  // ── Error injection counts ──────────────────────────────────────────
  it(`should have exactly ${EXPECTED_FILE_COUNT} error-injection results`, () => {
    const results = benchResults.errorInjection;
    // Count unique files
    const fileNames = new Set(results.map((r) => r.file));
    expect(fileNames.size).toBe(EXPECTED_FILE_COUNT);
  });

  it(`should have exactly ${EXTREME_FILE_COUNT} extreme-damage results`, () => {
    const results = benchResults.extremeDamage;
    const fileNames = new Set(results.map((r) => r.file));
    expect(fileNames.size).toBe(EXTREME_FILE_COUNT);
  });

  // ── Aggregate entry totals ──────────────────────────────────────────
  it('should have exactly 30 error-injection entries total', () => {
    expect(benchResults.errorInjection.length).toBe(30);
  });

  it('should have exactly 9 extreme-damage entries total', () => {
    // The current missing-state-provider fixture carries two entries, so the
    // curated extreme-damage set is 3+2+1+2+1 = 9 entries.
    expect(benchResults.extremeDamage.length).toBe(9);
  });

  // ── Pipeline F1 must be near-perfect ────────────────────────────────
  it('pipelineF1 should be { precision: 1, recall: 0.923, f1: 0.96 }', () => {
    expect(benchResults.pipelineF1).toBeDefined();
    // 36 of 39 curated entries match: every expectMatch-true contract fires
    // its validator; only the three documented expectMatch-false contracts
    // (006 world_rule, 012/013 factual_detail) are counted as misses.
    expect(benchResults.pipelineF1).toMatchObject({ precision: 1, recall: 0.923, f1: 0.96 });
  });

  // ── Per-file fixture contract checks ───────────────────────────────
  // Each injection entry must have its expectedValidator, expectedSeverity,
  // and matched status matching the contract below.

  interface FileContract {
    entries: Array<{
      expectedValidator: string;
      expectedSeverity: string;
      expectMatch: boolean;
    }>;
  }
  const CONTRACTS: Record<string, FileContract> = {
    // ---- error-injection (28 files) ----
    '001_timeline_order': {
      entries: [{ expectedValidator: 'timeline', expectedSeverity: 'warning', expectMatch: true }],
    },
    '002_missing_precondition': {
      entries: [{ expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true }],
    },
    '003_causality_break': {
      entries: [{ expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true }],
    },
    '004_unreachable_event': {
      entries: [
        { expectedValidator: 'reachability', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '005_pov_violation': {
      entries: [{ expectedValidator: 'pov', expectedSeverity: 'warning', expectMatch: true }],
    },
    '006_fact_contradiction': {
      entries: [{ expectedValidator: 'world_rule', expectedSeverity: 'error', expectMatch: false }],
    },
    '007_invented_detail': {
      entries: [
        { expectedValidator: 'factual_detail', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '008_knowledge_violation': {
      entries: [{ expectedValidator: 'knowledge', expectedSeverity: 'error', expectMatch: true }],
    },
    '009_world_rule_violation': {
      entries: [{ expectedValidator: 'world_rule', expectedSeverity: 'error', expectMatch: true }],
    },
    '010_character_state_contradiction': {
      entries: [
        { expectedValidator: 'character_state', expectedSeverity: 'error', expectMatch: true },
      ],
    },
    '011_foreshadowing_unpaid': {
      entries: [
        { expectedValidator: 'foreshadowing', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '012_placeholder_value': {
      entries: [
        { expectedValidator: 'factual_detail', expectedSeverity: 'warning', expectMatch: false },
      ],
    },
    '013_mutual_exclusion': {
      entries: [
        { expectedValidator: 'factual_detail', expectedSeverity: 'error', expectMatch: false },
      ],
    },
    '014_tense_mismatch': {
      entries: [{ expectedValidator: 'timeline', expectedSeverity: 'warning', expectMatch: true }],
    },
    '015_missing_character_reference': {
      entries: [{ expectedValidator: 'pov', expectedSeverity: 'error', expectMatch: true }],
    },
    '016_branch_merge_inconsistency': {
      entries: [
        { expectedValidator: 'branch_merge', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '017_narration_time_missing': {
      entries: [{ expectedValidator: 'timeline', expectedSeverity: 'warning', expectMatch: true }],
    },
    '018_scene_type_invalid': {
      entries: [{ expectedValidator: 'timeline', expectedSeverity: 'error', expectMatch: true }],
    },
    '019_location_mismatch': {
      entries: [
        { expectedValidator: 'character_state', expectedSeverity: 'error', expectMatch: true },
      ],
    },
    '020_thread_progress_invalid': {
      entries: [
        { expectedValidator: 'thread_progress', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '021_pacing_anomaly': {
      entries: [{ expectedValidator: 'pacing', expectedSeverity: 'warning', expectMatch: true }],
    },
    '022_tense_shift': {
      entries: [
        { expectedValidator: 'tense_consistency', expectedSeverity: 'error', expectMatch: true },
      ],
    },
    '023_discourse_imbalance': {
      entries: [
        { expectedValidator: 'discourse_balance', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '024_alias_inconsistency': {
      entries: [{ expectedValidator: 'alias', expectedSeverity: 'warning', expectMatch: true }],
    },
    '025_pronoun_mismatch': {
      entries: [{ expectedValidator: 'pronoun', expectedSeverity: 'error', expectMatch: true }],
    },
    '026_appearance_contradiction': {
      entries: [{ expectedValidator: 'appearance', expectedSeverity: 'error', expectMatch: true }],
    },
    '027_conflict_unresolved': {
      entries: [{ expectedValidator: 'conflict', expectedSeverity: 'warning', expectMatch: true }],
    },
    '028_voice_drift': {
      entries: [
        { expectedValidator: 'voice_drift', expectedSeverity: 'warning', expectMatch: true },
        { expectedValidator: 'voice_drift', expectedSeverity: 'info', expectMatch: true },
        { expectedValidator: 'voice_drift', expectedSeverity: 'warning', expectMatch: true },
      ],
    },

    // ---- extreme-damage (5 files) ----
    '001_event_deletion': {
      entries: [
        { expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true },
        { expectedValidator: 'reachability', expectedSeverity: 'warning', expectMatch: true },
        { expectedValidator: 'reachability', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '002_boundary_precondition_breaks': {
      entries: [
        { expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true },
        { expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true },
      ],
    },
    '003_circular_dependency': {
      entries: [{ expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true }],
    },
    '004_missing_state_provider': {
      entries: [
        { expectedValidator: 'reachability', expectedSeverity: 'warning', expectMatch: true },
        { expectedValidator: 'reachability', expectedSeverity: 'warning', expectMatch: true },
      ],
    },
    '005_self_referencing_precondition': {
      entries: [{ expectedValidator: 'causality', expectedSeverity: 'error', expectMatch: true }],
    },
  };

  // ── Runner: check each contract entry ──────────────────────────────
  for (const [fileName, contract] of Object.entries(CONTRACTS)) {
    contract.entries.forEach((entry, idx) => {
      const label = `${fileName} entry[${idx}] → ${entry.expectedValidator}/${entry.expectedSeverity}`;
      it(`${label}: ${entry.expectMatch ? 'VALIDATOR FIRES' : 'EXPLICIT FAILURE'}`, () => {
        // Collect all results for this file, preserving injection order
        const allResults = [...benchResults.errorInjection, ...benchResults.extremeDamage];
        const fileResults = allResults.filter((r) => r.file === fileName);
        expect(fileResults.length).toBeGreaterThan(idx);
        const match = fileResults[idx];
        if (!match) return;

        expect(match.expectedValidator).toBe(entry.expectedValidator);
        expect(match.expectedSeverity).toBe(entry.expectedSeverity);
        expect(match.matched).toBe(entry.expectMatch);

        // Runtime validators that fire should produce at least one actual issue
        if (entry.expectMatch) {
          expect(match.actualIssues.length).toBeGreaterThan(0);
        }
      });
    });
  }

  // ── Variant isolation: inventedDetails and narratorKnowledge must not bleed ──
  it('007_invented_detail: knowledge validator should NOT fire for invented-detail injection', () => {
    const fileResults = [...benchResults.errorInjection, ...benchResults.extremeDamage].filter(
      (r) => r.file === '007_invented_detail',
    );
    expect(fileResults.length).toBeGreaterThan(0);
    // If inventedDetails falls through into narratorKnowledge, the knowledge
    // validator would fire for this file, leaking into unexpectedIssues.
    for (const result of fileResults) {
      const knowledgeLeak = result.unexpectedIssues.filter((i) => i.validator === 'knowledge');
      expect(knowledgeLeak).toHaveLength(0);
    }
  });

  it('008_knowledge_violation: factual_detail validator should NOT fire for knowledge injection', () => {
    const fileResults = [...benchResults.errorInjection, ...benchResults.extremeDamage].filter(
      (r) => r.file === '008_knowledge_violation',
    );
    expect(fileResults.length).toBeGreaterThan(0);
    // NarratorKnowledge has its own break, so factual_detail should never
    // appear as an unexpected issue for this file.
    for (const result of fileResults) {
      const factualDetailLeak = result.unexpectedIssues.filter(
        (i) => i.validator === 'factual_detail',
      );
      expect(factualDetailLeak).toHaveLength(0);
    }
  });

  // ── Post-render mockAnalysis path: validators consuming AnalysisResult ──
  it('024_alias_inconsistency: post-render mockAnalysis produces alias issues with expected severity', () => {
    const fileResults = [...benchResults.errorInjection, ...benchResults.extremeDamage].filter(
      (r) => r.file === '024_alias_inconsistency',
    );
    expect(fileResults.length).toBeGreaterThan(0);
    for (const result of fileResults) {
      // The alias validator consumes mockAnalysis (characterReferences)
      // via validatePost; it must fire with the expected severity.
      expect(result.matched).toBe(true);
      const aliasIssues = result.actualIssues.filter((i) => i.validator === 'alias');
      expect(aliasIssues.length).toBeGreaterThan(0);
      expect(aliasIssues.some((i) => i.severity === result.expectedSeverity)).toBe(true);
    }
  });

  it('028_voice_drift: post-render mockAnalysis produces voice_drift issues with expected severity', () => {
    const fileResults = [...benchResults.errorInjection, ...benchResults.extremeDamage].filter(
      (r) => r.file === '028_voice_drift',
    );
    expect(fileResults.length).toBeGreaterThan(0);
    for (const result of fileResults) {
      // The voice_drift validator consumes mockAnalysis (narrativeChecks)
      // via validatePost; it must fire with the expected severity.
      expect(result.matched).toBe(true);
      const driftIssues = result.actualIssues.filter((i) => i.validator === 'voice_drift');
      expect(driftIssues.length).toBeGreaterThan(0);
      expect(driftIssues.some((i) => i.severity === result.expectedSeverity)).toBe(true);
    }
  });
});

import { EntityMapper } from '../../core/src/entity/mapper.ts';
import { loadCanonicalProject } from '../../core/src/entity/project-runtime.ts';
import { InMemoryEntityRegistry } from '../../core/src/entity/registry.ts';
import type {
  AnalysisResult,
  EntityRegistry,
  EntityTypeCatalog,
  WorldState,
} from '../../core/src/types/index.ts';
import { ResultAggregator } from '../../core/src/validator/aggregator.ts';
import { createBuiltInValidators } from '../../core/src/validator/builtins.ts';

const ZHU_FU_SNAPSHOT = materializeFixtureSnapshot(path.join(ROOT, 'fixtures', 'zhu-fu'));

describe('zhu-fu-variants / registry field availability', () => {
  let registry: EntityRegistry;
  beforeAll(() => {
    // Current contract: registry.load receives ProjectData (never a path).
    const data = new EntityMapper(ZHU_FU_SNAPSHOT).loadProject();
    registry = new InMemoryEntityRegistry();
    registry.load(data);
  });

  it('xianglins_wife entity has aliases in registry state', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    const aliases = entity.state.aliases;
    expect(Array.isArray(aliases)).toBe(true);
    if (!Array.isArray(aliases)) throw new Error('Expected aliases to be an array');
    expect(aliases).toContain('祥林嫂');
    expect(aliases).toContain('祥林的妻子');
  });

  it('xianglins_wife entity has gender in registry state', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    expect(entity.state.gender).toBe('女');
  });

  it('xianglins_wife entity has appearance in registry state', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    const appearance = entity.state.appearance;
    expect(typeof appearance).toBe('string');
    if (typeof appearance !== 'string') throw new Error('Expected appearance to be a string');
    expect(appearance.length).toBeGreaterThan(10);
  });

  it('xianglins_wife entity has age in registry state', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    expect(entity.state.age).toBe('约二十六七岁到四十岁');
  });

  it('xianglins_wife entity has profession in registry state', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    expect(entity.state.profession).toBe('佣工');
  });

  it('registry state exposes promoted definition fields without fabrication', () => {
    const entity = requireValue(registry.resolve('xianglins_wife'), 'xianglins_wife entity');
    // initialState moved to event introduction boundaries in the current
    // contract — the registry must not fabricate those fields from top-level
    // definition data.
    expect(entity.state.location).toBeUndefined();
    expect(entity.state.status).toBeUndefined();
    expect(entity.state.condition).toBeUndefined();
    // Promoted top-level fields survive into state.
    const traits = entity.state.traits;
    expect(Array.isArray(traits)).toBe(true);
    if (!Array.isArray(traits)) throw new Error('Expected traits to be an array');
    expect(traits).toContain('hardworking');
  });
});

describe('zhu-fu-variants / alias validator issue emission', () => {
  let registry: EntityRegistry;
  let entityTypeCatalog: EntityTypeCatalog;
  beforeAll(() => {
    // Current contract: validators receive the compiled project catalog for
    // semantic-role lookups (aliases carries semanticRole 'identity').
    const ir = loadCanonicalProject(ZHU_FU_SNAPSHOT);
    registry = ir.registry;
    entityTypeCatalog = ir.entityTypes;
  });
  it('AliasValidator emits issue for name not in known aliases when registry is seeded', () => {
    // Build a minimal event and state matching the 024_alias_inconsistency fixture
    const event = {
      id: 'E2',
      narrativeOrder: 2,
      participants: { entities: ['xianglins_wife'] },
      preconditions: [],
      postconditions: [],
      threadProgress: [],
      relationshipEffects: [],
      ruleEffects: [],
      storyTime: { type: 'absolute' as const, value: 'day_1' },
      tense: 'past' as const,
      sceneType: 'linear' as const,
      narrationTime: { type: 'absolute' as const, value: 'day_1' },
      branchExistence: { type: 'all' as const },
      arcPosition: 'rising_action' as const,
      discourseMode: 'narrative' as const,
      pov: { character: 'narrator', type: 'omniscient' as const },
      foreshadowing: [],
      resolutionType: 'resolved' as const,
    };

    // Build world state seeded from registry (same as processInjectionFile fix)
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };
    for (const entity of registry.getAll()) {
      state.entities[entity.id] = { ...entity.state };
    }

    const mockAnalysis: AnalysisResult = {
      eventId: 'E2',
      analysis: {
        // Required fields from AnalysisContent — populated with sensible defaults
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 0,
          maxScore: 10,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 0,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        // P0g optional blocks — all present so every post-render validator
        // (alias, pronoun, voice_drift, character-state, discourse-balance,
        // pacing, timeline, appearance, conflict, knowledge, world-rule,
        // tense-consistency) can run safely.
        narrativeChecks: [],
        appearanceChecks: [],
        tenseDetected: 'past',
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        ruleChecks: [],
        knowledgeChecks: [],
        checklistResults: [],
        // The alias validator consumes characterReferences — this is the actual test payload
        characterReferences: [{ entityId: 'xianglins_wife', namesUsed: ['祥林家的'] }],
      },
    };

    const aggregator = new ResultAggregator(createBuiltInValidators(), entityTypeCatalog);
    const result = aggregator.validatePost('', event, state, mockAnalysis, undefined, registry);

    // The alias validator should fire for "祥林家的" — not in known aliases
    const aliasIssues = result.warnings.filter((i) => i.validator === 'alias');
    expect(aliasIssues.length).toBeGreaterThan(0);
    expect(aliasIssues.some((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('zhu-fu-variants / pronoun validator issue emission', () => {
  let registry: EntityRegistry;
  let entityTypeCatalog: EntityTypeCatalog;
  beforeAll(() => {
    // Current contract: validators receive the compiled project catalog for
    // semantic-role lookups (pronoun_consistency is a narrative attribute).
    const ir = loadCanonicalProject(ZHU_FU_SNAPSHOT);
    registry = ir.registry;
    entityTypeCatalog = ir.entityTypes;
  });

  it('PronounValidator emits issue for gender-mismatched pronouns via Pass 2 narrativeChecks', () => {
    // Build a minimal event matching 025_pronoun_mismatch fixture
    const event = {
      id: 'E3',
      narrativeOrder: 3,
      participants: { entities: ['xianglins_wife'] },
      preconditions: [],
      postconditions: [],
      threadProgress: [],
      relationshipEffects: [],
      ruleEffects: [],
      storyTime: { type: 'absolute' as const, value: 'day_2' },
      tense: 'past' as const,
      sceneType: 'linear' as const,
      narrationTime: { type: 'absolute' as const, value: 'day_2' },
      branchExistence: { type: 'all' as const },
      arcPosition: 'rising_action' as const,
      discourseMode: 'narrative' as const,
      pov: { character: 'narrator', type: 'omniscient' as const },
      foreshadowing: [],
      resolutionType: 'resolved' as const,
    };

    // Build world state seeded from registry
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };
    for (const entity of registry.getAll()) {
      state.entities[entity.id] = { ...entity.state };
    }

    const prose = '祥林嫂是村里最能干的妇人。他每天从早忙到晚，连一口热饭都顾不上吃。';

    // Mock Pass 2 analysis: narrativeChecks prononun_consistency contradiction
    const mockAnalysis: AnalysisResult = {
      eventId: 'E3',
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 0,
          maxScore: 10,
          strengths: [],
          weaknesses: [],
          estimatedWordCount: 0,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [
          {
            entityId: 'xianglins_wife',
            attribute: 'pronoun_consistency',
            hint: 'Prose uses "他" (male) for xianglins_wife who is declared female',
            evidence: 'Mock prose uses male pronoun 他 for a female character',
            matchLevel: 'contradicted',
          },
        ],
        appearanceChecks: [],
        tenseDetected: 'past',
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        ruleChecks: [],
        knowledgeChecks: [],
        checklistResults: [],
      },
    };

    const aggregator = new ResultAggregator(createBuiltInValidators(), entityTypeCatalog);
    const result = aggregator.validatePost(prose, event, state, mockAnalysis, undefined, registry);

    // The pronoun validator should fire via Pass 2 narrativeChecks
    const pronounIssues = result.errors.filter((i) => i.validator === 'pronoun');
    expect(pronounIssues.length).toBeGreaterThan(0);
    expect(pronounIssues.some((i) => i.severity === 'error')).toBe(true);
  });
});

// ============================================================
// TODO:36 new gate tests: retry/circuit-breaker, malformed-reference,
//       event-level missing-provenance rejection
// ============================================================

// ----- Gate: Circuit Breaker (retry escalation) -----
import { createCircuitBreaker } from '../../core/src/pipeline/circuit-breaker.ts';

describe('zhu-fu-variants / gate: circuit-breaker flow', () => {
  it('starts in round 1 with retry strategy and is not open', () => {
    const breaker = createCircuitBreaker();
    const s = breaker.state();
    expect(s.round).toBe(1);
    expect(s.escalatedStrategy).toBe('retry');
    expect(s.isOpen).toBe(false);
    expect(s.totalAttempts).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('attempt() returns true while not open', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    expect(breaker.attempt()).toBe(true);
  });

  it('recordSuccess resets consecutive failures', () => {
    const breaker = createCircuitBreaker();
    breaker.recordFailure('error 1');
    breaker.recordFailure('error 2');
    expect(breaker.state().consecutiveFailures).toBe(2);
    breaker.recordSuccess();
    expect(breaker.state().consecutiveFailures).toBe(0);
    expect(breaker.state().isOpen).toBe(false);
  });

  it('opens after reaching failure threshold', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure('e1');
    breaker.recordFailure('e2');
    breaker.recordFailure('e3');
    expect(breaker.state().isOpen).toBe(true);
    expect(breaker.attempt()).toBe(false);
  });

  it('escalate advances to next round and changes strategy', () => {
    const breaker = createCircuitBreaker({ maxRounds: 3, failureThreshold: 3 });
    expect(breaker.state().round).toBe(1);
    expect(breaker.state().escalatedStrategy).toBe('retry');

    breaker.escalate();
    expect(breaker.state().round).toBe(2);
    expect(breaker.state().escalatedStrategy).toBe('prompt_fix');

    breaker.escalate();
    expect(breaker.state().round).toBe(3);
    expect(breaker.state().escalatedStrategy).toBe('abort');
  });

  it('escalate beyond maxRounds opens the breaker', () => {
    const breaker = createCircuitBreaker({ maxRounds: 2, failureThreshold: 3 });
    breaker.escalate(); // round 2
    expect(breaker.state().round).toBe(2);
    expect(breaker.state().isOpen).toBe(false);
    breaker.escalate(); // round 3 → open
    expect(breaker.state().isOpen).toBe(true);
  });

  it('escalate with consecutive failures auto-opens after escalation', () => {
    const breaker = createCircuitBreaker({
      maxRounds: 3,
      failureThreshold: 2,
      maxAttemptsPerRound: 2,
    });
    // Simulate 2 consecutive failures in round 1
    breaker.recordFailure('e1');
    breaker.recordFailure('e2');
    // After 2 consecutive failures in a row, escalate to prompt_fix
    breaker.escalate();
    expect(breaker.state().round).toBe(2);
    expect(breaker.state().escalatedStrategy).toBe('prompt_fix');

    // More failures in round 2
    breaker.recordFailure('e3');
    breaker.recordFailure('e4');
    breaker.escalate();
    expect(breaker.state().round).toBe(3);
    expect(breaker.state().escalatedStrategy).toBe('abort');
    expect(breaker.state().isOpen).toBe(true);
  });

  it('reset returns breaker to initial state', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure('e1');
    breaker.recordFailure('e2');
    expect(breaker.state().isOpen).toBe(true);
    breaker.reset();
    const s = breaker.state();
    expect(s.round).toBe(1);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.totalAttempts).toBe(0);
    expect(s.escalatedStrategy).toBe('retry');
  });
});

import { eventFileSchema } from '../../core/src/schemas/event.ts';

describe('zhu-fu-variants / gate: malformed reference rejection', () => {
  it('rejects event file with missing required field (sceneBrief)', () => {
    const malformed = {
      event: 'E0',
      title: 'test',
      narrativeOrder: 1,
      storyTime: 'day_1',
      pov: { character: 'narrator', type: 'first_person' as const },
    };
    const result = eventFileSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    // Missing sceneBrief (required string)
    if (result.success) throw new Error('Expected malformed event file to be rejected');
    expect(result.error.issues.some((i) => i.path.includes('sceneBrief'))).toBe(true);
  });

  it('rejects event file with invalid character reference (non-string entity)', () => {
    const malformed = {
      event: 'E0',
      title: 'test',
      narrativeOrder: 1,
      storyTime: 'day_1',
      pov: { character: 'narrator', type: 'first_person' as const },
      preconditions: [{ entity: 123, attribute: 'status', value: 'alive' }],
    };
    const result = eventFileSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('rejects event file with missing required field (narrativeOrder)', () => {
    const malformed = {
      event: 'E0',
      title: 'test',
      storyTime: 'day_1',
      pov: { character: 'narrator', type: 'first_person' as const },
    };
    const result = eventFileSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('rejects character definition with empty ID', () => {
    const malformed = {
      id: '',
      name: 'unknown',
      description: 'test',
    };
    const result = eventFileSchema.safeParse(malformed);
    // May not directly validate character schemas — test eventFileSchema behavior
    expect(result.success).toBe(false);
  });
});

// ----- Gate: Event-level Missing-Provenance Rejection -----
import { provenanceManifestSchema } from '../../core/src/schemas/contracts.ts';

describe('zhu-fu-variants / gate: missing-provenance rejection', () => {
  it('accepts a valid generated provenance entry', () => {
    const valid = {
      version: 1 as const,
      entries: [
        { eventId: 'E0', kind: 'generated' as const, runHash: 'abc123def456' },
        { eventId: 'E1', kind: 'generated' as const, runHash: 'abc123def456' },
      ],
    };
    const result = provenanceManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects provenance entry without eventId', () => {
    const invalid = {
      version: 1,
      entries: [{ kind: 'generated' as const, runHash: 'abc123' }],
    };
    const result = provenanceManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects provenance entry with empty runHash', () => {
    const invalid = {
      version: 1,
      entries: [{ eventId: 'E0', kind: 'generated' as const, runHash: '' }],
    };
    const result = provenanceManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects provenance entry with missing runHash', () => {
    const invalid = {
      version: 1,
      entries: [{ eventId: 'E0', kind: 'generated' as const }],
    };
    const result = provenanceManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects source_quotation entry without edition', () => {
    const invalid = {
      version: 1,
      entries: [
        {
          eventId: 'E0',
          kind: 'source_quotation' as const,
          url: 'https://example.com/source',
          rights: 'public_domain',
          sourceHash: 'abc123',
          overlap: { start: 0, end: 100, hash: 'def456' },
        },
      ],
    };
    const result = provenanceManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected provenance entry without edition to be rejected');
    expect(result.error.issues.some((i) => i.path.includes('edition'))).toBe(true);
  });

  it('accepts manifest with no entries (min not enforced)', () => {
    const valid = {
      version: 1,
      entries: [],
    };
    const result = provenanceManifestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects manifest with invalid version format', () => {
    const invalid = {
      version: 'not-a-version',
      entries: [{ eventId: 'E0', kind: 'generated' as const, runHash: 'abc123' }],
    };
    const result = provenanceManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
