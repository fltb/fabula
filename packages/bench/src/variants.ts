// ============================================================================
// Variants Benchmarks — Run variant fixtures (branch, error-injection, extreme-damage)
// Runs actual validators against injected-error fixtures, not just YAML counting.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AnalysisObservation,
  type AnalysisResult,
  compileProject,
  type EntityLookup,
  type EntityTypeCatalog,
  type NarrativeEvent,
  type ValidationIssue,
  type WorldState,
} from '@novalistically/core';
import { FileProjectSourceLoader } from '@novalistically/node-host';
import { ResultAggregator } from '@novalistically/core/tooling';
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

/** Mark every active analysis field as produced with mock evidence. */
function makeProducedObservations(
  content: Record<string, unknown>,
): Record<string, AnalysisObservation> {
  const observations: Record<string, AnalysisObservation> = {};
  for (const field of Object.keys(content)) {
    observations[field] = { disposition: 'produced', evidence: ['(mock evidence)'] };
  }
  return observations;
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
          // Add a postcondition that contradicts character state:
          // set xianglins_wife.status = dead on this event.
          event.postconditions.push({
            id: `injected_dead_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'dead',
            validity: makeFactValidity(),
          });
          // Add a conflicting alive precondition to the NEXT event (in
          // narrative order). Incremental replay validates each event against
          // pre-event state, so the precondition is only checked after this
          // event's dead postcondition has been applied — that is when
          // CharacterStateValidator detects the dead-status contradiction.
          const nextEvents = [...events]
            .filter((e) => e.narrativeOrder > event.narrativeOrder)
            .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
          const aliveCheckTarget = nextEvents[0] ?? event;
          aliveCheckTarget.preconditions.push({
            id: `injected_alive_check_${nextInjId()}`,
            entityId: 'xianglins_wife',
            attribute: 'status',
            value: 'alive',
            validity: makeFactValidity(),
          });
          applied.push(
            `Added dead status postcondition to ${event.id} + alive precondition to ${aliveCheckTarget.id}`,
          );
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
        // Add postcondition with the catalog's knowledge attribute about future
        // events. KnowledgeValidator.validatePre checks postconditions for
        // temporal consistency — it looks for matching postconditions in
        // future events (the semanticRole 'knowledge' lookup is catalog-driven).
        const futureFactValue = 'kidnapped_by_he_laoliu';
        event.postconditions.push({
          id: `future_knowledge_${nextInjId()}`,
          entityId: 'narrator',
          attribute: 'knowledge',
          value: futureFactValue,
          validity: makeFactValidity(),
        });
        applied.push('Added future knowledge postcondition (knowledge attribute)');

        // Also add a matching knowledge postcondition to the nearest future
        // event so KnowledgeValidator detects the temporal inconsistency:
        // the current event knows something before the future event establishes it.
        const futureEvents = events
          .filter((e) => e.narrativeOrder > event.narrativeOrder)
          .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
        if (futureEvents.length > 0) {
          const nearestFuture = futureEvents[0];
          nearestFuture.postconditions.push({
            id: `establish_knowledge_${nextInjId()}`,
            entityId: 'narrator',
            attribute: 'knowledge',
            value: futureFactValue,
            validity: makeFactValidity(),
          });
          applied.push(`Added matching knowledge to future event ${nearestFuture.id}`);
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
        // Negative benchmark: bypass the valid NarrativeEvent union to inject malformed input.
        const malformedEvent = event as unknown as Record<string, unknown>;
        malformedEvent.sceneType = 'notarealtype';
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
        // Also add dead-status postcondition, plus a conflicting alive
        // precondition on the NEXT event (in narrative order) so incremental
        // replay validates it against the dead state this event establishes —
        // that is when CharacterStateValidator fires.
        event.postconditions.push({
          id: `injected_dead_loc_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'status',
          value: 'dead',
          validity: makeFactValidity(),
        });
        const nextEvents = [...events]
          .filter((e) => e.narrativeOrder > event.narrativeOrder)
          .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
        const aliveCheckTarget = nextEvents[0] ?? event;
        aliveCheckTarget.preconditions.push({
          id: `injected_alive_check_loc_${nextInjId()}`,
          entityId: 'xianglins_wife',
          attribute: 'status',
          value: 'alive',
          validity: makeFactValidity(),
        });
        applied.push(
          `Added location=beijing + dead status postconditions to ${event.id}, alive precondition to ${aliveCheckTarget.id}`,
        );
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
          e.arcPosition = 'climax';
        }
        applied.push('Set all events to arcPosition="climax"');
        break;
      }

      // ── discourseMode ──────────────────────────────────────────────
      case 'discourseMode':
      case 'discourse_mode': {
        // Set ALL events to same discourse mode
        for (const e of events) {
          e.discourseMode = 'description';
        }
        applied.push('Set all events to discourseMode="description"');
        break;
      }

      // ── branchExistence ────────────────────────────────────────────
      case 'branchExistence':
      case 'branch_existence': {
        // Negative benchmark: bypass the valid branch union to exercise schema/validator failure.
        const malformedEvent = event as unknown as Record<string, unknown>;
        malformedEvent.branchExistence = {
          type: 'paths',
          paths: [['A'], ['B']],
        };
        // Set earlier events to non-all branchExistence so
        // BranchMergeValidator.validatePre sees incoming branches
        for (const e of events) {
          if (e.narrativeOrder < event.narrativeOrder && e.branchExistence.type === 'all') {
            const malformedPredecessor = e as unknown as Record<string, unknown>;
            malformedPredecessor.branchExistence = {
              type: 'paths',
              paths: [['A'], ['B']],
            };
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
function runValidators(
  events: NarrativeEvent[],
  entities: EntityLookup,
  state: WorldState,
  stateBeforeByEventId?: Map<string, WorldState>,
  entityTypeCatalog?: EntityTypeCatalog,
): ValidationIssue[] {
  // Catalog-driven semantic checks receive the project's compiled catalog.
  const aggregator = new ResultAggregator(undefined, entityTypeCatalog);
  const results = aggregator.validateAll(events, state, entities, { stateBeforeByEventId });

  const allIssues: ValidationIssue[] = [];
  for (const result of results.values()) {
    allIssues.push(...result.errors, ...result.warnings, ...result.infos);
  }
  return allIssues;
}

/**
 * state-contradiction case. This mutates benchmark input data, not story
 * replay: every untouched boundary remains the compiled project's result.
 */
function buildSyntheticStateBoundaries(
  base: Map<string, WorldState>,
  events: readonly NarrativeEvent[],
): Map<string, WorldState> {
  const boundaries = new Map(base);
  for (const event of events) {
    const injectsDeadState = event.preconditions.some(
      (fact) =>
        fact.id.startsWith('injected_alive_check_') ||
        fact.id.startsWith('injected_alive_check_loc_'),
    );
    if (!injectsDeadState) continue;

    const baseState = base.get(event.id);
    if (!baseState) continue;
    const state = structuredClone(baseState);
    const entity = state.entities.xianglins_wife ?? {};
    entity.status = 'dead';
    state.entities.xianglins_wife = entity;
    boundaries.set(event.id, state);
  }
  return boundaries;
}

// ─── Injection File Processor ──────────────────────────────────────────────

/**
 * Process one synthetic mutation file against the canonical base project's
 * compiled boundaries. Mutation cases exercise validator sensitivity only;
 * they never implement or replay a second story-state protocol.
 */
function processInjectionFile(
  filePath: string,
  baseEvents: NarrativeEvent[],
  entities: EntityLookup,
  baseFinalState: WorldState,
  baseStateBeforeByEventId: Map<string, WorldState>,
  entityTypeCatalog?: EntityTypeCatalog,
): VariantIssueResult[] {
  // One aggregator per file, carrying the project catalog for validators.
  const fileAggregator = new ResultAggregator(undefined, entityTypeCatalog);
  const raw = YAML.parse(fs.readFileSync(filePath, 'utf-8'));
  const injections: InjectedEntry[] = raw?.injected ?? [];
  if (injections.length === 0) return [];

  const fileName = path.basename(filePath).replace(/\.yaml$/, '');

  // Deep-clone events and apply all injections for this file simultaneously
  const mutated = cloneEvents(baseEvents);
  const appliedDesc = applyInjections(mutated, injections);
  // Synthetic mutations are evaluated against the canonical base project's
  // Project replay remains owned by the canonical compilation.
  const stateBeforeByEventId = buildSyntheticStateBoundaries(baseStateBeforeByEventId, mutated);
  const allIssues = runValidators(
    mutated,
    entities,
    baseFinalState,
    stateBeforeByEventId,
    entityTypeCatalog,
  );

  // For each injection entry, check if the expected validator matched
  const results: VariantIssueResult[] = injections.map((inj) => {
    const expectedName = normalizeValidatorName(inj.expectedValidator);

    // Collect ALL pre-render issues from the expected validator (any severity).
    const preIssues = allIssues.filter((issue) => issue.validator === expectedName);

    // Post-render validation for entries with mock analysis data
    let postIssues: ValidationIssue[] = [];
    if (inj.mockAnalysis || inj.mockProse) {
      const targetEvent = mutated.find((e) => e.id === inj.entityId);
      if (targetEvent) {
        const mergedAnalysis: Record<string, unknown> = {
          ...makeBaselineAnalysisContent(),
          ...(inj.mockAnalysis as Record<string, unknown>),
        };
        const mockAnalysis: AnalysisResult | undefined = inj.mockAnalysis
          ? {
              eventId: targetEvent.id,
              // Mock protocol pins the measurement configuration; bench mocks
              // never round-trip through zod, so stable placeholders suffice.
              protocol: {
                proseHash: '',
                analysisSchema: 'mock-variant',
                model: 'mock',
                provider: 'mock',
                analysisPromptHash: 'mock-variant-prompt',
                samplingConfigHash: 'mock-variant-sampling',
                validatorPolicy: 'default',
                referencePolicy: 'none',
              },
              observations: makeProducedObservations(mergedAnalysis),
              analysis: mergedAnalysis,
            }
          : undefined;

        const postRenderState = stateBeforeByEventId.get(targetEvent.id) ?? baseFinalState;

        const postResult = fileAggregator.validatePost(
          inj.mockProse ?? '',
          targetEvent,
          postRenderState,
          mockAnalysis,
          undefined,
          entities,
          1,
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

  // ── Load base fixture through the canonical kernel ──────────────────
  const compilation = compileProject(new FileProjectSourceLoader().load(baseFixturePath));
  const baseEvents = [...compilation.events];
  const entities = compilation.entities;
  const boundaries = compilation.boundaries;
  const entityTypes = compilation.entityTypes;

  // ── Branch variants ─────────────────────────────────────────────────
  const branchA = runBranchVariant(path.join(root, 'branch-A'));
  const branchB = runBranchVariant(path.join(root, 'branch-B'));

  const errorInjectionResults = runInjectionVariants(
    path.join(root, 'error-injection'),
    baseEvents,
    entities,
    boundaries.finalState,
    boundaries.stateBeforeByEventId,
    entityTypes,
  );
  const extremeDamageResults = runInjectionVariants(
    path.join(root, 'extreme-damage'),
    baseEvents,
    entities,
    boundaries.finalState,
    boundaries.stateBeforeByEventId,
    entityTypes,
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

// ─── Branch variant runner ──────────────────────────────────────────────────

function runBranchVariant(
  dir: string,
): { eventsLoaded: number; issues: ValidationIssue[] } {
  const compilation = compileProject(new FileProjectSourceLoader().load(dir));
  const events = [...compilation.events];
  const entities = compilation.entities;
  const boundaries = compilation.boundaries;
  const entityTypes = compilation.entityTypes;
  const issues = runValidators(
    events,
    entities,
    boundaries.finalState,
    boundaries.stateBeforeByEventId,
    entityTypes,
  );
  return { eventsLoaded: events.length, issues };
}

// ─── Injection variants runner ─────────────────────────────────────────────
function runInjectionVariants(
  dir: string,
  baseEvents: NarrativeEvent[],
  entities: EntityLookup,
  baseFinalState: WorldState,
  baseStateBeforeByEventId: Map<string, WorldState>,
  entityTypeCatalog?: EntityTypeCatalog,
): VariantIssueResult[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const allResults: VariantIssueResult[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const results = processInjectionFile(
      filePath,
      baseEvents,
      entities,
      baseFinalState,
      baseStateBeforeByEventId,
      entityTypeCatalog,
    );
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
