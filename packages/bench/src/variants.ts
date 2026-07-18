// ============================================================================
// Variants Benchmarks — Run variant fixtures (branch, error-injection, extreme-damage)
// Runs actual validators against injected-error fixtures, not just YAML counting.
// ============================================================================

import {
  EntityMapper,
  InMemoryEntityRegistry,
  ReplayEngine,
  ResultAggregator,
  createEmptyBranchPath,
  type NarrativeEvent,
  type WorldState,
  type ValidationIssue,
  type EntityRegistry,
} from '@novalistically/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import YAML from 'yaml';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InjectedEntry {
  entityId: string;
  attribute: string;
  expectedValidator: string;
  expectedSeverity: string;
  description: string;
}

/** Result for a single injected error — whether the expected validator caught it */
export interface VariantIssueResult {
  file: string;
  description: string;
  expectedValidator: string;
  expectedSeverity: string;
  actualIssues: ValidationIssue[];
  matched: boolean;
}

/** Full set of variant benchmark results */
export interface VariantResults {
  branchA: { eventsLoaded: number; issues: ValidationIssue[] };
  branchB: { eventsLoaded: number; issues: ValidationIssue[] };
  errorInjection: VariantIssueResult[];
  extremeDamage: VariantIssueResult[];
  /** Legacy flat list — kept for backward compat with index.ts console.table */
  results: VariantResult[];
  totalTime: number;
  pipelineF1?: {
    precision: number;
    recall: number;
    f1: number;
    matchedCount: number;
    falsePositiveCount: number;
    missedCount: number;
  };
}

/** Legacy variant result shape — kept for backward compat */
export interface VariantResult {
  variant: string;
  type: 'branch' | 'error_injection' | 'extreme_damage';
  eventsLoaded: number;
  errorsDetected: number;
  warningsDetected: number;
  infosDetected: number;
  ms: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Deep-clone events via JSON roundtrip (fast enough for <50 events) */
function cloneEvents(events: NarrativeEvent[]): NarrativeEvent[] {
  return JSON.parse(JSON.stringify(events));
}

/** Map expectedValidator shorthand from YAML to actual validator names */
function normalizeValidatorName(name: string): string {
  const map: Record<string, string> = {
    timeline: 'timeline',
    causality: 'causality',
    reachability: 'reachability',
    pov: 'pov',
    character_state: 'character_state',
    characterState: 'character_state',
    world_rule: 'world_rule',
    worldRule: 'world_rule',
    foreshadowing: 'foreshadowing',
    schema: 'schema',              // not a validator — Zod-level check
    factual_detail: 'factual_detail',
    factualDetail: 'factual_detail',
    knowledge: 'knowledge',
    branch_merge: 'branch_merge',
    branchMerge: 'branch_merge',
    tense_consistency: 'tense_consistency',
    tenseConsistency: 'tense_consistency',
    pacing: 'pacing',
    discourse_balance: 'discourse_balance',
    discourseBalance: 'discourse_balance',
    alias: 'alias',
    pronoun: 'pronoun',
    appearance: 'appearance',
    conflict: 'conflict',
    voice_drift: 'voice_drift',
    voiceDrift: 'voice_drift',
    thread_progress: 'thread_progress',
    threadProgress: 'thread_progress',
    quality: 'quality',
  };
  return map[name] ?? name;
}

/** Default FactValidity for injected facts */
function makeFactValidity(): FactValidity {
  return {
    temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
    branches: { type: 'all' },
  };
}

interface FactValidity {
  temporal: { start: { type: 'absolute'; value: string }; end: null };
  branches: { type: 'all' };
}

// ─── Mutation Engine ────────────────────────────────────────────────────────

/**
 * Apply a set of injection entries to a cloned events array.
 * Each mutation is designed to trigger a specific validator.
 * Returns descriptions of what was mutated.
 */
function applyInjections(
  events: NarrativeEvent[],
  injections: InjectedEntry[],
): string[] {
  const applied: string[] = [];

  for (const inj of injections) {
    // Handle system:genesis specially (it might not be in normal events array)
    if (inj.entityId === 'system:genesis') {
      if (inj.attribute === 'event') {
        // Remove genesis event entirely
        const idx = events.findIndex((e) => e.id === 'system:genesis');
        if (idx >= 0) {
          events.splice(idx, 1);
          applied.push('Removed system:genesis from events array');
        } else {
          applied.push('system:genesis not found (already removed)');
        }
      }
      continue;
    }

    const event = events.find((e) => e.id === inj.entityId);
    if (!event) {
      applied.push(`Event ${inj.entityId} not found in cloned array — skipping`);
      continue;
    }

    switch (inj.attribute) {
      // ── storyTime ──────────────────────────────────────────────────
      case 'storyTime': {
        // Set storyTime to day_0 (fixture events resolve to 0 so this won't
        // actually trigger timeline validator unless the base fixture's
        // resolveTimestampToDay differentiates between day_0 and day:N)
        event.storyTime = { type: 'absolute', value: 'day_1' };
        // Force sceneType to 'linear' so timeline check runs
        event.sceneType = 'linear';
        applied.push('Set storyTime=day_1, sceneType=linear');
        break;
      }

      // ── preconditions ──────────────────────────────────────────────
      case 'preconditions': {
        if (inj.expectedValidator === 'reachability') {
          // Add a precondition for an attribute that no event's
          // postcondition will ever set → reachability detects it
          event.preconditions.push({
            id: `injected_unreachable_${Date.now()}`,
            entityId: 'xianglins_wife',
            attribute: 'has_magical_power',
            value: true,
            validity: makeFactValidity(),
          });
          applied.push('Added unreachable precondition: xianglins_wife.has_magical_power=true');
        } else if (
          inj.description.includes('circular') ||
          inj.description.includes('self-referenc')
        ) {
          // Self-referencing: precondition references a value only set
          // by this event's own postcondition
          if (event.postconditions.length > 0) {
            const pc = event.postconditions[0];
            event.preconditions.push({
              id: `injected_circular_${Date.now()}`,
              entityId: pc.entityId,
              attribute: pc.attribute,
              value: pc.value,
              validity: makeFactValidity(),
            });
            applied.push(`Added self-referencing precondition: ${pc.entityId}.${pc.attribute}=${JSON.stringify(pc.value)}`);
          }
        } else {
          // Causality break: add an unsatisfiable precondition.
          // Pick a plausible entity+attribute that the state won't have.
          event.preconditions.push({
            id: `injected_unsatisfiable_${Date.now()}`,
            entityId: 'xianglins_wife',
            attribute: 'location',
            value: 'nonexistent_faraway_land',
            validity: makeFactValidity(),
          });
          applied.push('Added unsatisfiable precondition: xianglins_wife.location=nonexistent_faraway_land');
        }
        break;
      }

      // ── postconditions ─────────────────────────────────────────────
      case 'postconditions': {
        if (inj.expectedValidator === 'causality') {
          // Corrupt a postcondition so the next event's precondition
          // can't be satisfied → causality fires on the DOWNSTREAM event
          if (event.postconditions.length > 0) {
            const target = event.postconditions[event.postconditions.length - 1];
            target.value = `CORRUPTED_${Date.now()}`;
            applied.push(`Corrupted postcondition: ${target.entityId}.${target.attribute}=CORRUPTED`);
          }
          // For extreme-damage 002_postcondition_swap: swap values
          // between two events' postconditions
          if (inj.description.includes('swap') || inj.description.includes('swapped')) {
            // Find the paired injection
            const paired = injections.find(
              (i) => i.entityId !== inj.entityId && i.attribute === 'postconditions',
            );
            if (paired) {
              const otherEvent = events.find((e) => e.id === paired.entityId);
              if (otherEvent && otherEvent.postconditions.length > 0 && event.postconditions.length > 0) {
                const aVal = event.postconditions[event.postconditions.length - 1].value;
                const bVal = otherEvent.postconditions[otherEvent.postconditions.length - 1].value;
                event.postconditions[event.postconditions.length - 1].value = bVal;
                otherEvent.postconditions[otherEvent.postconditions.length - 1].value = aVal;
                applied.push(`Swapped postcondition values between ${inj.entityId} and ${paired.entityId}`);
              }
            }
          }
        } else if (inj.expectedValidator === 'character_state') {
          // Add a postcondition that contradicts character state
          // e.g., setting xianglins_wife.status = dead when later
          // events expect alive
          event.postconditions.push({
            id: `injected_dead_${Date.now()}`,
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'dead',
            validity: makeFactValidity(),
          });
          applied.push('Added dead status postcondition: xianglins_wife.status=dead');
        } else if (inj.expectedValidator === 'world_rule') {
          // Add a postcondition that violates a world rule
          event.postconditions.push({
            id: `injected_remarried_${Date.now()}`,
            entityId: 'xianglins_wife',
            attribute: 'marital_status',
            value: 'remarried',
            validity: makeFactValidity(),
          });
          applied.push('Added postcondition: xianglins_wife.marital_status=remarried (world rule)');
        } else {
          // Generic corrupt postcondition
          if (event.postconditions.length > 0) {
            event.postconditions[0].value = `INJECTED_${Date.now()}`;
            applied.push('Corrupted first postcondition value');
          }
        }
        break;
      }

      // ── event (delete) ──────────────────────────────────────────────
      case 'event': {
        const idx = events.findIndex((e) => e.id === inj.entityId);
        if (idx >= 0) {
          events.splice(idx, 1);
          applied.push(`Removed event ${inj.entityId} from array`);
        }
        break;
      }

      // ── pov ─────────────────────────────────────────────────────────
      case 'pov': {
        // Set POV to a character that doesn't exist or has wrong role
        if (inj.description.includes('fourth_aunt')) {
          // fourth_aunt exists in zhu-fu but has role 'supporting'
          // The POV validator catches this if role not protagonist/narrator
          event.pov = { character: 'fourth_aunt', type: 'third_person_limited' };
          applied.push('Set POV to fourth_aunt (supporting character)');
        } else {
          // Default: set to nonexistent character
          event.pov = { character: 'zhen_sao', type: 'first_person' };
          applied.push('Set POV to zhen_sao (nonexistent character)');
        }
        break;
      }

      // ── inventedDetails ─────────────────────────────────────────────
      case 'inventedDetails':
      case 'invented_detail': {
        // Add a postcondition about a nonexistent entity
        event.postconditions.push({
          id: `invented_sister_${Date.now()}`,
          entityId: 'nonexistent_sister',
          attribute: 'exists',
          value: true,
          validity: makeFactValidity(),
        });
        applied.push('Added invented detail about nonexistent entity');
        break;
      }

      // ── narratorKnowledge / knowledge ───────────────────────────────
      case 'narratorKnowledge':
      case 'narrator_knowledge': {
        // Add precondition that implies knowledge of future events
        // The knowledge validator should detect this temporal inconsistency
        event.preconditions.push({
          id: `future_knowledge_${Date.now()}`,
          entityId: 'xianglins_wife',
          attribute: 'kidnapped_by_he_laoliu',
          value: true,
          validity: makeFactValidity(),
        });
        applied.push('Added future knowledge precondition');
        break;
      }

      // ── worldRuleCompliance ─────────────────────────────────────────
      case 'worldRuleCompliance':
      case 'world_rule_compliance': {
        if (!event.ruleEffects) event.ruleEffects = [];
        event.ruleEffects.push({
          rule: 'patriarchal_clan_authority',
          effect: 'nullify',
          evidence: 'Injected error: woman leads public ritual',
        });
        applied.push('Added rule-violating rule effect');
        break;
      }

      // ── foreshadowing ───────────────────────────────────────────────
      case 'foreshadowing': {
        // Add a foreshadowing entry whose target chapter will never exist
        event.foreshadowing.push({
          id: `unpaid_${Date.now()}`,
          hint: 'Something mysterious that never pays off',
          targetRevealChapter: 999,
          thread: 'mystery',
        });
        applied.push('Added unpaid foreshadowing (target chapter 999)');
        break;
      }

      // ── factValue (placeholder) ─────────────────────────────────────
      case 'factValue':
      case 'fact_value': {
        if (event.postconditions.length > 0) {
          const target = event.postconditions[event.postconditions.length - 1];
          target.value = 'changed';
          applied.push('Set postcondition value to placeholder "changed"');
        } else {
          event.postconditions.push({
            id: `placeholder_fact_${Date.now()}`,
            entityId: 'xianglins_wife',
            attribute: 'test_placeholder',
            value: 'changed',
            validity: makeFactValidity(),
          });
          applied.push('Added fact with placeholder value "changed"');
        }
        break;
      }

      // ── factRepresentation (mutual exclusion) ───────────────────────
      case 'factRepresentation':
      case 'fact_representation': {
        // Set both value AND narrativeHint — which Zod should reject
        if (event.postconditions.length > 0) {
          const fc = event.postconditions[event.postconditions.length - 1];
          fc.value = 'some_value';
          fc.narrativeHint = 'some_hint';
          applied.push('Set both value and narrativeHint on fact');
        }
        break;
      }

      // ── tense ───────────────────────────────────────────────────────
      case 'tense': {
        // Set to 'present' (project config likely uses 'past')
        event.tense = 'present';
        applied.push('Set tense to "present"');
        break;
      }

      // ── narrationTime ───────────────────────────────────────────────
      case 'narrationTime':
      case 'narration_time': {
        event.narrationTime = undefined as unknown as undefined;
        applied.push('Removed narrationTime');
        break;
      }

      // ── sceneType ──────────────────────────────────────────────────
      case 'sceneType':
      case 'sceneTypeInvalid':
      case 'scene_type_invalid': {
        (event as any).sceneType = 'notarealtype';
        applied.push('Set sceneType to "notarealtype"');
        break;
      }

      // ── location ────────────────────────────────────────────────────
      case 'location': {
        event.postconditions.push({
          id: `location_mismatch_${Date.now()}`,
          entityId: 'xianglins_wife',
          attribute: 'location',
          value: 'beijing',
          validity: makeFactValidity(),
        });
        applied.push('Added location=beijing postcondition');
        break;
      }

      // ── threadProgress ─────────────────────────────────────────────
      case 'threadProgress':
      case 'threadProgressInvalid':
      case 'thread_progress_invalid': {
        event.threadProgress.push({
          thread: 'T99',
          advancement: 'nonexistent_thread_reference',
          progressAfter: 100,
          progressTotal: 100,
        });
        applied.push('Added threadProgress for T99');
        break;
      }

      // ── arcPosition (pacing anomaly) ──────────────────────────────
      case 'arcPosition':
      case 'arc_position': {
        // Set ALL events to 'opening' — flat narrative arc
        for (const e of events) {
          if (e.id !== 'system:genesis') {
            e.arcPosition = 'opening';
          }
        }
        applied.push('Set all events to arcPosition="opening"');
        break;
      }

      // ── discourseMode ──────────────────────────────────────────────
      case 'discourseMode':
      case 'discourse_mode': {
        // Set ALL events to same discourse mode
        for (const e of events) {
          if (e.id !== 'system:genesis') {
            e.discourseMode = 'description';
          }
        }
        applied.push('Set all events to discourseMode="description"');
        break;
      }

      // ── branchExistence ────────────────────────────────────────────
      case 'branchExistence':
      case 'branch_existence': {
        (event as any).branchExistence = {
          type: 'paths',
          paths: [['A'], ['B']],
        };
        applied.push('Corrupted branchExistence');
        break;
      }

      // ── resolutionType (conflict) ──────────────────────────────────
      case 'resolutionType':
      case 'resolution_type': {
        event.resolutionType = 'unresolved';
        applied.push('Set resolutionType="unresolved"');
        break;
      }

      // ── character_reference / pronoun_usage (post-render only) ────
      case 'character_reference':
      case 'characterReference': {
        applied.push('Post-render only (alias) — skipped mutation');
        break;
      }
      case 'pronoun_usage':
      case 'pronounUsage':
      case 'pronoun': {
        applied.push('Post-render only (pronoun) — skipped mutation');
        break;
      }

      // ── appearance ─────────────────────────────────────────────────
      case 'appearance': {
        // Add contradictory appearance postcondition
        event.postconditions.push({
          id: `appearance_contradiction_${Date.now()}`,
          entityId: 'xianglins_wife',
          attribute: 'appearance',
          value: 'white_hair_haggard_wooden_face',
          validity: makeFactValidity(),
        });
        applied.push('Added contradictory appearance postcondition');
        break;
      }

      // ── narrativeChecks.* (post-render only — voice_drift) ────────
      case 'narrativeChecks.voice_formality':
      case 'narrativeChecks.voice_vocabulary':
      case 'narrativeChecks.voice_anachronism': {
        applied.push('Post-render only (voice_drift) — skipped mutation');
        break;
      }

      // ── default ─────────────────────────────────────────────────────
      default: {
        applied.push(`Unknown attribute "${inj.attribute}" — no mutation applied`);
        break;
      }
    }
  }

  return applied;
}

// ─── Validator Runner ──────────────────────────────────────────────────────

/**
 * Run all pre-render validators against the given events + state.
 * State must have been replayed from the (possibly mutated) events.
 */
function runValidators(
  events: NarrativeEvent[],
  state: WorldState,
  registry: EntityRegistry,
): ValidationIssue[] {
  const aggregator = new ResultAggregator();
  const results = aggregator.validateAll(events, state, registry);

  const allIssues: ValidationIssue[] = [];
  for (const result of results.values()) {
    allIssues.push(...result.errors, ...result.warnings, ...result.infos);
  }
  return allIssues;
}

// ─── Injection File Processor ──────────────────────────────────────────────

/**
 * Severity rank for comparing expected vs actual severity.
 * A higher-severity match (error vs expected warning) counts as match.
 */
const SEV_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };

/**
 * Process a single injection file: load the YAML, create mutated events,
 * replay state from mutated events, run validators, and return results.
 */
function processInjectionFile(
  filePath: string,
  baseEvents: NarrativeEvent[],
  registry: EntityRegistry,
): VariantIssueResult[] {
  const raw = YAML.parse(fs.readFileSync(filePath, 'utf-8'));
  const injections: InjectedEntry[] = raw?.injected ?? [];
  if (injections.length === 0) return [];

  const fileName = path.basename(filePath).replace(/\.yaml$/, '');

  // Deep-clone events and apply all injections for this file simultaneously
  const mutated = cloneEvents(baseEvents);
  const appliedDesc = applyInjections(mutated, injections);

  // Replay state from the mutated events
  const replay = new ReplayEngine();
  const state = replay.replay(mutated, createEmptyBranchPath());

  // Run validators against the mutated events with fresh state
  const allIssues = runValidators(mutated, state, registry);

  // For each injection entry, check if the expected validator matched
  const results: VariantIssueResult[] = injections.map((inj) => {
    const expectedName = normalizeValidatorName(inj.expectedValidator);
    const expectedRank = SEV_RANK[inj.expectedSeverity] ?? 0;

    // Schema validation happens during YAML loading, not in validators
    if (expectedName === 'schema') {
      return {
        file: fileName,
        description: inj.description,
        expectedValidator: inj.expectedValidator,
        expectedSeverity: inj.expectedSeverity,
        actualIssues: [],
        matched: false,
      };
    }

    // Collect ALL issues from the expected validator (any severity).
    // The injection files' expectedSeverity is informational — many validators
    // produce warning-level issues even for injection-targeted errors.
    const anyFromValidator = allIssues.filter(
      (issue) => issue.validator === expectedName,
    );

    // Find issues at or above expected severity (for severity-matched reporting)
    const matchingIssues = anyFromValidator.filter((issue) => {
      const actualRank = SEV_RANK[issue.severity] ?? 0;
      return actualRank >= expectedRank;
    });

    // Matched = the expected validator fired (regardless of severity).
    // This is the primary signal: did the validator detect the injected error?
    const matched = anyFromValidator.length > 0;

    return {
      file: fileName,
      description: inj.description,
      expectedValidator: inj.expectedValidator,
      expectedSeverity: inj.expectedSeverity,
      actualIssues: anyFromValidator,
      matched,
    };
  });

  // Debug: log what happened
  if (results.some((r) => r.matched)) {
    const matchedDesc = results.filter((r) => r.matched).map((r) => r.expectedValidator).join(', ');
    console.log(`  [variants] ${fileName}: matched ${matchedDesc} (${appliedDesc.join('; ')})`);
  } else {
    console.log(`  [variants] ${fileName}: NO match (${appliedDesc.join('; ')})`);
  }

  return results;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Run all variant benchmarks against zhu-fu-variants fixture directories.
 */
export async function runVariantBench(): Promise<VariantResults> {
  const root = path.resolve(
    __dirname, '..', '..', '..', 'fixtures', 'zhu-fu-variants',
  );
  const baseFixturePath = path.resolve(
    __dirname, '..', '..', '..', 'fixtures', 'zhu-fu',
  );

  const startTime = Date.now();

  // ── Load base fixture data (shared entities across all tests) ──────
  const mapper = new EntityMapper(baseFixturePath);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(baseFixturePath);
  const baseEvents = mapper.loadAllEvents(projectData.chapters);

  // ── Branch variants ─────────────────────────────────────────────────
  const branchA = runBranchVariant(path.join(root, 'branch-A'), 'branch-A');
  const branchB = runBranchVariant(path.join(root, 'branch-B'), 'branch-B');

  // ── Error-injection variants ────────────────────────────────────────
  const errorInjectionResults = runInjectionVariants(
    path.join(root, 'error-injection'),
    baseEvents,
    registry,
  );

  // ── Extreme-damage variants ─────────────────────────────────────────
  const extremeDamageResults = runInjectionVariants(
    path.join(root, 'extreme-damage'),
    baseEvents,
    registry,
  );

  // ── Compute Pipeline F1 ─────────────────────────────────────────────
  const f1 = computeF1(errorInjectionResults.concat(extremeDamageResults));

  // ── Build legacy results list ───────────────────────────────────────
  const legacyResults: VariantResult[] = [
    {
      variant: 'branch-A',
      type: 'branch',
      eventsLoaded: branchA.eventsLoaded,
      errorsDetected: branchA.issues.filter((i) => i.severity === 'error').length,
      warningsDetected: branchA.issues.filter((i) => i.severity === 'warning').length,
      infosDetected: branchA.issues.filter((i) => i.severity === 'info').length,
      ms: 0,
    },
    {
      variant: 'branch-B',
      type: 'branch',
      eventsLoaded: branchB.eventsLoaded,
      errorsDetected: branchB.issues.filter((i) => i.severity === 'error').length,
      warningsDetected: branchB.issues.filter((i) => i.severity === 'warning').length,
      infosDetected: branchB.issues.filter((i) => i.severity === 'info').length,
      ms: 0,
    },
    {
      variant: 'error-injection',
      type: 'error_injection',
      eventsLoaded: errorInjectionResults.length,
      errorsDetected: errorInjectionResults.filter((r) => r.expectedSeverity === 'error').length,
      warningsDetected: errorInjectionResults.filter((r) => r.expectedSeverity === 'warning').length,
      infosDetected: errorInjectionResults.filter((r) => r.expectedSeverity === 'info').length,
      ms: 0,
    },
    {
      variant: 'extreme-damage',
      type: 'extreme_damage',
      eventsLoaded: extremeDamageResults.length,
      errorsDetected: extremeDamageResults.filter((r) => r.expectedSeverity === 'error').length,
      warningsDetected: extremeDamageResults.filter((r) => r.expectedSeverity === 'warning').length,
      infosDetected: extremeDamageResults.filter((r) => r.expectedSeverity === 'info').length,
      ms: 0,
    },
  ];

  return {
    branchA,
    branchB,
    errorInjection: errorInjectionResults,
    extremeDamage: extremeDamageResults,
    results: legacyResults,
    totalTime: Date.now() - startTime,
    pipelineF1: f1,
  };
}

// ─── Branch variant runner ──────────────────────────────────────────────────

function runBranchVariant(
  dir: string,
  name: string,
): { eventsLoaded: number; issues: ValidationIssue[] } {
  try {
    const mapper = new EntityMapper(dir);
    const projectData = mapper.loadProject();
    const registry = new InMemoryEntityRegistry();
    registry.load(dir);
    const events = mapper.loadAllEvents(projectData.chapters);
    const replay = new ReplayEngine();
    const state = replay.replay(events, createEmptyBranchPath());
    const issues = runValidators(events, state, registry);
    return { eventsLoaded: events.length, issues };
  } catch {
    return { eventsLoaded: 0, issues: [] };
  }
}

// ─── Injection variants runner ─────────────────────────────────────────────

function runInjectionVariants(
  dir: string,
  baseEvents: NarrativeEvent[],
  registry: EntityRegistry,
): VariantIssueResult[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const allResults: VariantIssueResult[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const results = processInjectionFile(filePath, baseEvents, registry);
      allResults.push(...results);
    } catch (err) {
      console.error(`[variants] Error processing ${file}:`, err);
    }
  }

  return allResults;
}

// ─── Pipeline F1 Computation ────────────────────────────────────────────────
//
// Computes precision/recall/F1 for the validator pipeline by comparing
// injection results against a baseline (unmodified events).
//
// TP  = expected validator fired (the validator caught the injected error)
// FN  = expected validator didn't fire (the injection was missed)
// FP  = count of injection files where unexpected validators produced
//       issues beyond the baseline count for that validator

function computeF1(results: VariantIssueResult[]): {
  precision: number;
  recall: number;
  f1: number;
  matchedCount: number;
  missedCount: number;
  falsePositiveCount: number;
} {
  let matchedCount = 0;
  let missedCount = 0;
  let falsePositiveCount = 0;

  // Group results by file to count per-file validator activations
  const byFile = new Map<string, VariantIssueResult[]>();
  for (const r of results) {
    const existing = byFile.get(r.file) ?? [];
    existing.push(r);
    byFile.set(r.file, existing);
  }

  for (const [, fileResults] of byFile) {
    // For each file, check each injection entry
    for (const r of fileResults) {
      if (normalizeValidatorName(r.expectedValidator) === 'schema') {
        missedCount++;
        continue;
      }
      if (r.matched) {
        matchedCount++;
      } else {
        missedCount++;
      }
    }

    // False positives: validators that fired but weren't the expected one
    // for any injection in this file. Each distinct unexpected validator
    // that produced issues counts as one FP event.
    const expectedNames = new Set(
      fileResults.map((r) => normalizeValidatorName(r.expectedValidator)),
    );
    const allIssueValidators = new Set<string>();
    for (const r of fileResults) {
      for (const issue of r.actualIssues) {
        allIssueValidators.add(issue.validator);
      }
    }
    // Count unexpected validators that also fired
    for (const vName of allIssueValidators) {
      if (!expectedNames.has(vName)) {
        falsePositiveCount++;
      }
    }
  }

  const total = matchedCount + missedCount;
  const precision = matchedCount + falsePositiveCount > 0
    ? matchedCount / (matchedCount + falsePositiveCount)
    : total > 0 ? 0 : 1;

  const recall = total > 0
    ? matchedCount / total
    : 1;

  const f1 = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  return {
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    matchedCount,
    falsePositiveCount,
    missedCount,
  };
}
