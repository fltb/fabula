// ============================================================================
// Variants Benchmarks — Run variant fixtures (branch, error-injection, extreme-damage)
// Runs actual validators against injected-error fixtures, not just YAML counting.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AnalysisResult,
  compileStoryBoundaries,
  compileStoryRuntimeGraph,
  EntityMapper,
  type EntityRegistry,
  type Fact,
  InMemoryEntityRegistry,
  type NarrativeEvent,
  ResultAggregator,
  type ThreadId,
  type ThreadRunId,
  type ThreadRuntimeState,
  type ValidationIssue,
  type WorldState,
} from '@novalistically/core';
import YAML from 'yaml';

/** Deterministic injection ID counter — replaces non-deterministic Date.now() */
let _injIdCounter = 1;
function nextInjId(): string {
  return String(_injIdCounter++);
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InjectedEntry {
  entityId: string;
  attribute: string;
  expectedValidator: string;
  expectedSeverity: string;
  description: string;
  /** Optional mock prose for post-render validation (alias, pronoun, voice_drift) */
  mockProse?: string;
  /** Optional mock analysis JSON for post-render validation */
  mockAnalysis?: Record<string, unknown>;
}

/** Result for a single injected error — whether the expected validator caught it */
export interface VariantIssueResult {
  file: string;
  description: string;
  expectedValidator: string;
  expectedSeverity: string;
  actualIssues: ValidationIssue[];
  /** Issues from validators other than the expected one — catches cross-contamination leaks */
  unexpectedIssues: ValidationIssue[];
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
    schema: 'schema', // not a validator — Zod-level check
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

/** Complete baseline analysis content — all required fields defaulted.
 *  Fixture mockAnalysis overlays ONLY the fields it provides. */
function makeBaselineAnalysisContent(): Record<string, unknown> {
  return {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: { proseScore: 0, maxScore: 10, strengths: [], weaknesses: [], estimatedWordCount: 0 },
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

// ─── Mutation Engine ────────────────────────────────────────────────────────

/**
 * Apply a set of injection entries to a cloned events array.
 * Each mutation is designed to trigger a specific validator.
 * Returns descriptions of what was mutated.
 */
function applyInjections(events: NarrativeEvent[], injections: InjectedEntry[]): string[] {
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
            id: `injected_unreachable_${nextInjId()}`,
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
              id: `injected_circular_${nextInjId()}`,
              entityId: pc.entityId,
              attribute: pc.attribute,
              value: pc.value,
              validity: makeFactValidity(),
            });
            applied.push(
              `Added self-referencing precondition: ${pc.entityId}.${pc.attribute}=${JSON.stringify(pc.value)}`,
            );
          }
        } else {
          // Causality break: add an unsatisfiable precondition.
          // Pick a plausible entity+attribute that the state won't have.
          event.preconditions.push({
            id: `injected_unsatisfiable_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'location',
            value: 'nonexistent_faraway_land',
            validity: makeFactValidity(),
          });
          applied.push(
            'Added unsatisfiable precondition: xianglins_wife.location=nonexistent_faraway_land',
          );
        }
        break;
      }

      // ── postconditions ─────────────────────────────────────────────
      case 'postconditions': {
        if (inj.expectedValidator === 'causality') {
          // Corrupt the FIRST postcondition so the next event's precondition
          // can't be satisfied → causality fires on the DOWNSTREAM event.
          // Using index 0 (not last) because downstream events' preconditions
          // typically depend on the most structurally significant postcondition.
          if (event.postconditions.length > 0) {
            const target = event.postconditions[0];
            target.value = `CORRUPTED_${nextInjId()}`;
            applied.push(
              `Corrupted postcondition: ${target.entityId}.${target.attribute}=CORRUPTED`,
            );
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
              if (
                otherEvent &&
                otherEvent.postconditions.length > 0 &&
                event.postconditions.length > 0
              ) {
                const aVal = event.postconditions[event.postconditions.length - 1].value;
                const bVal = otherEvent.postconditions[otherEvent.postconditions.length - 1].value;
                event.postconditions[event.postconditions.length - 1].value = bVal;
                otherEvent.postconditions[otherEvent.postconditions.length - 1].value = aVal;
                applied.push(
                  `Swapped postcondition values between ${inj.entityId} and ${paired.entityId}`,
                );
              }
            }
          }
        } else if (inj.expectedValidator === 'character_state') {
          // Add a postcondition that contradicts character state
          // e.g., setting xianglins_wife.status = dead when later
          // events expect alive
          event.postconditions.push({
            id: `injected_dead_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'dead',
            validity: makeFactValidity(),
          });
          // Add a conflicting precondition to this same event so the
          // CharacterStateValidator fires when checking preconditions.
          // The state already has status=dead from this event's postcondition
          // (applied during buildStateFromEvents), so the precondition check
          // will detect the dead-status contradiction.
          event.preconditions.push({
            id: `injected_alive_check_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'alive',
            validity: makeFactValidity(),
          });
          applied.push('Added dead status postcondition + alive precondition to same event');
        } else if (inj.expectedValidator === 'world_rule') {
          // Add a postcondition that violates a world rule
          event.postconditions.push({
            id: `injected_remarried_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'marital_status',
            value: 'remarried',
            validity: makeFactValidity(),
          });
          applied.push('Added postcondition: xianglins_wife.marital_status=remarried (world rule)');
        } else {
          // Generic corrupt postcondition
          if (event.postconditions.length > 0) {
            event.postconditions[0].value = `INJECTED_${nextInjId()}`;
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
        if (inj.description.includes('he_laoliu')) {
          // he_laoliu exists in zhu-fu but is not a scene participant —
          // triggers POV in-scene warning for third_person_limited
          event.pov = { character: 'he_laoliu', type: 'third_person_limited' };
          applied.push('Set POV to he_laoliu (non-participant character)');
        } else if (inj.description.includes('fourth_aunt')) {
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
          id: `invented_sister_${nextInjId()}`,
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
        // Add postcondition with 'knows' attribute about future events.
        // KnowledgeValidator.validatePre checks postconditions for temporal
        // consistency — it looks for matching postconditions in future events.
        const futureFactValue = 'kidnapped_by_he_laoliu';
        event.postconditions.push({
          id: `future_knowledge_${nextInjId()}`,
          entityId: 'narrator',
          attribute: 'knows',
          value: futureFactValue,
          validity: makeFactValidity(),
        });
        applied.push('Added future knowledge postcondition (knows attribute)');

        // Also add a matching knows postcondition to the nearest future event
        // so KnowledgeValidator detects the temporal inconsistency:
        // the current event knows something before the future event establishes it.
        const futureEvents = events
          .filter((e) => e.narrativeOrder > event.narrativeOrder)
          .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
        if (futureEvents.length > 0) {
          const nearestFuture = futureEvents[0];
          nearestFuture.postconditions.push({
            id: `establish_knowledge_${nextInjId()}`,
            entityId: 'narrator',
            attribute: 'knows',
            value: futureFactValue,
            validity: makeFactValidity(),
          });
          applied.push(`Added matching knows to future event ${nearestFuture.id}`);
        }
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
        event.foreshadowing.push({
          id: `unpaid_${nextInjId()}`,
          hint: 'Something mysterious that never pays off',
          targetRevealChapter: 0,
          thread: 'mystery',
        });
        applied.push('Added unpaid foreshadowing (target chapter 0)');
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
            id: `placeholder_fact_${nextInjId()}`,
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
          id: `location_mismatch_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'location',
          value: 'beijing',
          validity: makeFactValidity(),
        });
        // Also add dead-status postcondition + conflicting precondition
        // on the SAME event so the CharacterStateValidator fires
        event.postconditions.push({
          id: `injected_dead_loc_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'status',
          value: 'dead',
          validity: makeFactValidity(),
        });
        event.preconditions.push({
          id: `injected_alive_check_loc_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'status',
          value: 'alive',
          validity: makeFactValidity(),
        });
        applied.push('Added location=beijing postcondition + dead status injection');
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
        // Set ALL events to 'climax' — no narrative arc structure.
        // PacingValidator flags climax events outside the 60-85% window.
        for (const e of events) {
          if (e.id !== 'system:genesis') {
            e.arcPosition = 'climax';
          }
        }
        applied.push('Set all events to arcPosition="climax"');
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
        // Set earlier events to non-all branchExistence so
        // BranchMergeValidator.validatePre sees incoming branches
        for (const e of events) {
          if (e.narrativeOrder < event.narrativeOrder && e.branchExistence.type === 'all') {
            (e as any).branchExistence = { type: 'paths', paths: [['A'], ['B']] };
          }
        }
        // Add unsatisfiable precondition — compareFact will yield mismatch
        event.preconditions.push({
          id: `merge_unsat_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'non_existent_attr',
          value: 'branch_specific_value',
          validity: makeFactValidity(),
        });
        applied.push('Corrupted branchExistence and added merge-unsatisfiable precondition');
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
          id: `appearance_contradiction_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'appearance',
          value: 'white_hair_haggard_wooden_face',
          validity: makeFactValidity(),
        });
        // Add a SECOND conflicting appearance postcondition so
        // AppearanceValidator.validatePre detects the contradiction
        event.postconditions.push({
          id: `appearance_sane_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'appearance',
          value: 'pale_yellow_face_red_cheeks',
          validity: makeFactValidity(),
        });
        applied.push('Added contradictory appearance postcondition pair');
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
  stateBeforeByEventId?: Map<string, WorldState>,
): ValidationIssue[] {
  const aggregator = new ResultAggregator();
  const results = aggregator.validateAll(events, state, registry, { stateBeforeByEventId });

  const allIssues: ValidationIssue[] = [];
  for (const result of results.values()) {
    allIssues.push(...result.errors, ...result.warnings, ...result.infos);
  }
  return allIssues;
}

// ─── Injection File Processor ──────────────────────────────────────────────

/**
 * Process a single injection file: load the YAML, create mutated events,
 * replay state incrementally per-event, run validators, and return results.
 *
 * State is built incrementally: each event is validated against the state
 * accumulated from all previous events (but NOT its own effects). This
 * ensures validators see pre-event state — critical for nullify detection,
 * circular dependency detection, and self-referencing precondition detection.
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
  // Build state incrementally: validate each event against pre-event state,
  // then apply its effects for subsequent events.
  const allIssues: ValidationIssue[] = [];
  const incrementalState = makeEmptyState();

  // Sort by narrative order for deterministic incremental replay
  const sorted = [...mutated].sort((a, b) => a.narrativeOrder - b.narrativeOrder);

  // Seed initial state from genesis postconditions + registry entity state,
  // matching production renderNovel's initialFacts construction.
  const genesisEvent = sorted.find((e) => e.id === 'system:genesis');
  if (genesisEvent) {
    applyEventToState(genesisEvent, incrementalState);
  }
  // Apply registry entity state on top (overwrites genesis for same keys,
  // matching compileStoryBoundaries behavior).
  applyRegistryState(incrementalState, registry);

  for (const event of sorted) {
    if (event.id === 'system:genesis') {
      continue;
    }

    // Validate event against current (pre-event) state
    const eventAggregator = new ResultAggregator();
    const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
    const result = eventAggregator.validate(event, incrementalState, registry, sorted, chapter);
    allIssues.push(...result.errors, ...result.warnings, ...result.infos);

    // Apply event's effects to state for subsequent events
    applyEventToState(event, incrementalState);
  }

  // For each injection entry, check if the expected validator matched
  const results: VariantIssueResult[] = injections.map((inj) => {
    const expectedName = normalizeValidatorName(inj.expectedValidator);

    // Collect ALL pre-render issues from the expected validator (any severity).
    const preIssues = allIssues.filter((issue) => issue.validator === expectedName);

    // Post-render validation: run validateRender for entries with mock analysis data
    let postIssues: ValidationIssue[] = [];
    if (inj.mockAnalysis || inj.mockProse) {
      const targetEvent = mutated.find((e) => e.id === inj.entityId);
      if (targetEvent) {
        const renderAggregator = new ResultAggregator();
        const mockAnalysis: AnalysisResult | undefined = inj.mockAnalysis
          ? {
              eventId: targetEvent.id,
              analysis: {
                ...makeBaselineAnalysisContent(),
                ...(inj.mockAnalysis as Record<string, unknown>),
              },
            }
          : undefined;

        // Build pre-event state for post-render validation: stop at the target event.
        // Must include registry entity state (same as pre-render path) so validators
        // like AliasValidator and PronounValidator can access declaration fields.
        const postRenderState = makeEmptyState();
        if (genesisEvent) {
          applyEventToState(genesisEvent, postRenderState);
        }
        applyRegistryState(postRenderState, registry);
        for (const e of sorted) {
          if (e.id === 'system:genesis') continue;
          if (e.narrativeOrder >= targetEvent.narrativeOrder) break;
          applyEventToState(e, postRenderState);
        }

        const postResult = renderAggregator.validateRender(
          inj.mockProse ?? '',
          targetEvent,
          postRenderState,
          mockAnalysis,
          undefined,
          registry,
        );
        postIssues = [...postResult.errors, ...postResult.warnings, ...postResult.infos].filter(
          (i) => i.validator === expectedName,
        );
      }
    }

    // Combine pre-render and post-render issues from the expected validator
    const allFromValidator = [...preIssues, ...postIssues];

    // MATCH: require at least one actual issue from the expected validator AND
    // at least one issue with the exact expected severity.
    // Severity-specific matching ensures contract fidelity across all severities
    // (error, warning, info). A validator may produce multiple severities for
    // different rule checks — the match targets the specific severity declared
    // in the YAML fixture, which the contract then verifies.
    const matched = allFromValidator.some((i) => i.severity === inj.expectedSeverity);
    return {
      file: fileName,
      description: inj.description,
      expectedValidator: inj.expectedValidator,
      expectedSeverity: inj.expectedSeverity,
      actualIssues: allFromValidator,
      unexpectedIssues: allIssues.filter((issue) => issue.validator !== expectedName),
      matched,
    };
  });

  if (results.some((r) => r.matched)) {
    const matchedDesc = results
      .filter((r) => r.matched)
      .map((r) => r.expectedValidator)
      .join(', ');
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
  const root = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'zhu-fu-variants');
  const baseFixturePath = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'zhu-fu');

  const startTime = Date.now();

  // ── Load base fixture data (shared entities across all tests) ──────
  const mapper = new EntityMapper(baseFixturePath);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(baseFixturePath);
  const baseEvents = mapper.loadAllEvents(projectData.chapters);

  // ── Branch variants ─────────────────────────────────────────────────
  const branchA = runBranchVariant(path.join(root, 'branch-A'));
  const branchB = runBranchVariant(path.join(root, 'branch-B'));

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
      warningsDetected: errorInjectionResults.filter((r) => r.expectedSeverity === 'warning')
        .length,
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

/**
 * Create a fresh empty WorldState with no accumulated facts.
 */
function makeEmptyState(): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };
}

/**
 * Apply a single event's effects to the world state (postconditions,
 * thread progress, relationship effects, knowledge, rule evidence).
 * Separated from buildStateFromEvents so incremental replay can use it.
 */
function applyEventToState(event: NarrativeEvent, state: WorldState): void {
  // Apply postconditions to entities
  for (const fact of event.postconditions) {
    if (fact.value === undefined) continue;
    if (!state.entities[fact.entityId]) {
      state.entities[fact.entityId] = {};
    }
    state.facts.push(fact);
    state.entities[fact.entityId][fact.attribute] = fact.value;
  }

  // Update thread progress
  for (const tp of event.threadProgress) {
    state.threads[tp.thread] = {
      threadId: tp.thread as ThreadId,
      status: 'active',
      currentRunId: `bench-${tp.thread}` as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: '',
    };
  }

  // Update relationship state (STATE-2)
  const rels = state.relationships as unknown as Record<string, Record<string, unknown>>;
  for (const re of event.relationshipEffects) {
    const relId = re.relationshipId as unknown as string;
    if (!rels[relId]) {
      rels[relId] = {
        relationshipId: relId,
        typeId: 'default',
        epochs: {},
        activeEpochId: undefined,
      };
    }
    const relState = rels[relId];
    const epochs = relState.epochs as Record<string, Record<string, unknown>>;
    const epochId = re.epochId ?? 'epoch_1';
    if (!epochs[epochId]) {
      epochs[epochId] = {
        epochId,
        lifecycle: 'active',
        memberships: {},
        dimensions: {},
      };
    }
    const epoch = epochs[epochId];
    const memberships = epoch.memberships as Record<
      string,
      { membershipId: string; entityId: string; role?: string }
    >;
    for (const m of re.membershipAfter) {
      memberships[m.membershipId] = m;
    }
    if (re.dimensionSet) {
      const dimensions = epoch.dimensions as Record<
        string,
        { value: unknown; scope: string; lastUpdatedEffectId: string }
      >;
      for (const d of re.dimensionSet) {
        const key = `${d.scope}::${d.dimensionId}`;
        dimensions[key] = { value: d.value, scope: d.scope, lastUpdatedEffectId: re.effectId };
      }
    }
    if (re.lifecycleAfter) {
      epoch.lifecycle = re.lifecycleAfter;
      if (re.lifecycleAfter === 'active') {
        relState.activeEpochId = epochId;
      } else if (re.lifecycleAfter === 'dissolved') {
        if (relState.activeEpochId === epochId) {
          relState.activeEpochId = undefined;
        }
      }
    }
  }

  // Update knowledge (from postconditions with attribute "knows" or "knowledge")
  for (const fact of event.postconditions) {
    if (fact.attribute === 'knows' || fact.attribute === 'knowledge') {
      if (!state.knowledge[fact.entityId]) {
        state.knowledge[fact.entityId] = { knownFacts: [] };
      }
      state.knowledge[fact.entityId].knownFacts.push(fact.id);
    }
  }

  // Update rule evidence (STATE-6: use RuleRuntimeState)
  for (const re of event.ruleEffects) {
    if (!state.rules[re.rule]) {
      state.rules[re.rule] = {
        ruleId: re.rule,
        currentEpoch: `${re.rule}-epoch-default`,
        specificationId: `${re.rule}-spec`,
        activation: 'dormant',
        effectiveness: 'full',
        scopeBindings: {},
        exceptions: [],
      };
    }
    switch (re.effect) {
      case 'reinforce':
        state.rules[re.rule].activation = 'enabled';
        state.rules[re.rule].effectiveness = 'full';
        break;
      case 'weaken':
        state.rules[re.rule].activation = 'suspended';
        break;
      case 'nullify':
        state.rules[re.rule].activation = 'dormant';
        state.rules[re.rule].effectiveness = 'nullified';
        break;
      case 'introduce_exception':
        state.rules[re.rule].exceptions.push({
          exceptionId: `${re.rule}-exc-${state.rules[re.rule].exceptions.length}`,
          status: 'active',
          constraintIds: [],
          scopeBindings: {},
          effect: { type: 'exempt' },
        });
        break;
    }
  }
}

/**
 * Seed registry entity state into a world state, matching production
 * renderNovel's initialFacts construction where all entity.state fields
 * become available as initial facts. This ensures character declaration
 * fields (aliases, gender, appearance, age, profession) are accessible to
 * pre-render and post-render validators.
 *
 * Registry state is applied AFTER genesis postconditions so it overwrites
 * any duplicate keys, the same order as compileStoryBoundaries does.
 */
function applyRegistryState(state: WorldState, registry: EntityRegistry): void {
  for (const entity of registry.getAll()) {
    if (!state.entities[entity.id]) {
      state.entities[entity.id] = {};
    }
    for (const [attr, value] of Object.entries(entity.state)) {
      if (value !== undefined) {
        state.entities[entity.id][attr] = value;
        state.facts.push({
          id: `${entity.id}.${attr}`,
          entityId: entity.id,
          attribute: attr,
          value,
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        });
      }
    }
  }
}

// ─── Branch variant runner ──────────────────────────────────────────────────

function runBranchVariant(dir: string): { eventsLoaded: number; issues: ValidationIssue[] } {
  const mapper = new EntityMapper(dir);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(dir);
  const allEvents = mapper.loadAllEvents(projectData.chapters);

  // Separate genesis event from authored events
  const genesis = allEvents.find((e) => e.id === 'system:genesis');

  // Initial facts = genesis postconditions + registry entity state
  const initialFacts: Fact[] = [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) =>
      Object.entries(entity.state).map(([attribute, value]) => ({
        id: `${entity.id}.${attribute}`,
        entityId: entity.id,
        attribute,
        value,
        validity: {
          temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      })),
    ),
  ];

  // Compile canonical runtime graph + boundaries with causal ordering and state snapshots
  const compiled = compileStoryRuntimeGraph({
    events: allEvents,
    initialFacts,
    initialThreads: [],
    timeAnchors: projectData.timeAnchors,
    branchPath: { decisions: [] },
  });
  const boundaries = compileStoryBoundaries(
    [...compiled.selectedEvents],
    compiled.initialFacts,
    compiled.storyAdjacency,
  );

  const issues = runValidators(
    [...compiled.selectedEvents],
    boundaries.finalState,
    registry,
    boundaries.stateBeforeByEventId,
  );
  return { eventsLoaded: compiled.selectedEvents.length, issues };
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
    const results = processInjectionFile(filePath, baseEvents, registry);
    allResults.push(...results);
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
  const precision =
    matchedCount + falsePositiveCount > 0
      ? matchedCount / (matchedCount + falsePositiveCount)
      : total > 0
        ? 0
        : 1;

  const recall = total > 0 ? matchedCount / total : 1;

  const f1 = precision + recall > 0 ? (2 * (precision * recall)) / (precision + recall) : 0;

  return {
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    matchedCount,
    falsePositiveCount,
    missedCount,
  };
}
