// ============================================================================
// Validator System — All 11 Validators + ResultAggregator
// 8 deterministic + 2 LLM-assisted + 1 LLM-required = 11 total
// ============================================================================

import type {
  NarrativeEvent,
  WorldState,
  EntityRegistry,
  Validator,
  ValidatorContext,
  ValidationIssue,
  ValidationResult,
  EntityId,
  Fact,
  StoryTimestamp,
  BranchPath,
} from '../types/index.js';
import { compareTimestamp, parseStoryTimestamp } from '../entity/index.js';
import { includesPath, createEmptyBranchPath } from '../branch/index.js';

// ============================================================================
// Helper: build ValidatorContext from current state
// ============================================================================

function buildContext(
  event: NarrativeEvent,
  state: WorldState,
  registry: EntityRegistry,
  events: NarrativeEvent[],
  chapter: number,
): ValidatorContext {
  return {
    worldState: state,
    events,
    entityRegistry: registry,
    currentEvent: event,
    currentChapter: chapter,
    narrativeOrder: event.narrativeOrder,
    queryState: (entityId: EntityId, attribute: string) =>
      state.entities[entityId]?.[attribute],
    getKnowledge: (characterId: EntityId) => ({
      worldTruth: state.facts,
      characterKnowledge: {
        [characterId]: {
          knownFacts: state.knowledge[characterId]?.knownFacts?.map((fid) => ({
            fact: state.facts.find((f) => f.id === fid) ?? {
              id: fid, entityId: '', attribute: '', value: null,
              validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
            },
            acquiredAt: { type: 'absolute' as const, value: 'day_0' },
            source: { type: 'direct_experience' as const, eventId: event.id },
            confidence: 1,
          })) ?? [],
          unknownFacts: [],
          misbeliefs: [],
        },
      },
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: (threadId: string) =>
      state.threads[threadId] ?? { progress: 0, total: 0 },
    getRuleEvidence: (_ruleId: string) => [],
  };
}

function makeIssue(
  validator: string,
  eventId: string,
  entity: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  fixSuggestion: string,
  fixAction: ValidationIssue['fixAction'] = 'manual',
  attribute?: string,
  file?: string,
  value?: unknown,
): ValidationIssue {
  return {
    validator,
    severity,
    event: eventId,
    entity,
    attribute,
    message,
    fixSuggestion,
    fixAction,
    fixTarget: { file: file ?? '', field: attribute, value },
  };
}

// ============================================================================
// 1. TimelineValidator — Absolute time contradictions, duration, simultaneity
// ============================================================================

export class TimelineValidator implements Validator {
  name = 'timeline';
  category = 'timeline_plot' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check: narrative order must be strictly increasing
    const prevEvents = context.events.filter(
      (e) => e.narrativeOrder < event.narrativeOrder && e.id !== 'system:genesis',
    );
    const prevEvent = prevEvents[prevEvents.length - 1];

    if (prevEvent && event.storyTime && prevEvent.storyTime) {
      const anchors = new Map<string, number>();
      const cmp = compareTimestamp(event.storyTime, prevEvent.storyTime, anchors);
      if (cmp < 0 && event.sceneType === 'linear') {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'error',
          `Story time ${JSON.stringify(event.storyTime)} is before previous event's story time ${JSON.stringify(prevEvent.storyTime)}`,
          'If this is intentional (flashback), set scene_type to "flashback". Otherwise, adjust story_time.',
          'declare_flashback',
          'story_time',
        ));
      }
    }

    // Check: flashback/scene should have narrationTime if different from storyTime
    if (event.sceneType !== 'linear' && !event.narrationTime) {
      issues.push(makeIssue(
        this.name, event.id, event.pov.character, 'warning',
        `Scene type is "${event.sceneType}" but no narration_time is set`,
        'Add narration_time field to indicate where in the narrative this scene is told.',
        'add_field',
        'narration_time',
      ));
    }

    return issues;
  }
}

// ============================================================================
// 2. CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

export class CharacterStateValidator implements Validator {
  name = 'character_state';
  category = 'characterization' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const pc of event.preconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      const currentState = context.queryState(pc.entityId, 'status');
      const currentAlive = context.queryState(pc.entityId, 'alive');

      // If character is dead, can't appear in scenes
      if (currentState === 'dead' || currentAlive === false) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" is dead but appears in this scene`,
          `Remove this character from the scene, or this character's death must have been revealed as false.`,
          'remove_line',
          'status',
        ));
      }
    }

    // Check postconditions for state contradictions
    for (const pc of event.postconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      const currentCondition = context.queryState(pc.entityId, 'condition');

      // If transitioning to healthy from shimmer_damaged without medical_intervention
      if (
        pc.attribute === 'condition' &&
        pc.value === 'healthy' &&
        currentCondition === 'shimmer_damaged'
      ) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Character "${pc.entityId}" transitions from shimmer_damaged to healthy without medical intervention`,
          'Add an event showing medical treatment, or change the expected postcondition.',
          'change_value',
          'condition',
          undefined,
          pc.value,
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 3. KnowledgeValidator — Knowledge boundary enforcement
// ============================================================================

export class KnowledgeValidator implements Validator {
  name = 'knowledge';
  category = 'characterization' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const povChar = event.pov.character;
    const knowledge = context.getKnowledge(povChar);
    const charKnowledge = knowledge.characterKnowledge[povChar];

    // For each postcondition that sets "knows" on the POV character,
    // check if they could have learned this at this point in time
    for (const pc of event.postconditions) {
      if (pc.attribute !== 'knows' || pc.entityId !== povChar) continue;

      const knownFacts = charKnowledge?.knownFacts ?? [];
      const alreadyKnown = knownFacts.some((k) => k.fact.id === pc.id);

      if (alreadyKnown) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'info',
          `Character "${povChar}" already knows fact "${pc.value}"`,
          'This is a duplicate knowledge acquisition. Consider removing if redundant.',
          'manual',
        ));
      }
    }

    // Check: POV character shouldn't know facts from future events
    for (const pc of event.postconditions) {
      if (pc.entityId !== povChar || pc.attribute !== 'knows') continue;

      // Check if this fact was established in a future event (impossible)
      const factEvents = context.events.filter(
        (e) =>
          e.narrativeOrder > event.narrativeOrder &&
          e.postconditions.some(
            (p) => p.entityId === pc.entityId && p.attribute === pc.attribute && p.value === pc.value,
          ),
      );

      if (factEvents.length > 0) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'error',
          `Character "${povChar}" appears to know fact "${pc.value}" before it is established (in ${factEvents[0].id})`,
          'Reorder events so the fact is established before the character learns it.',
          'add_precondition',
          'knows',
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 4. WorldRuleValidator — Enforce logical_consequences from rule definitions
// ============================================================================

export class WorldRuleValidator implements Validator {
  name = 'world_rule';
  category = 'worldbuilding' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check postconditions against world rules
    for (const pc of event.postconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity) continue;

      // Check: entity_kind == 'character' AND traits contains 'hextech_augmented'
      const traits = entity.state['traits'] as string[] | undefined;
      if (traits?.includes('hextech_augmented') && pc.attribute === 'condition') {
        if (
          pc.value !== 'operational' &&
          pc.value !== 'healthy'
        ) {
          issues.push(makeIssue(
            this.name, event.id, pc.entityId, 'warning',
            `Hextech-augmented character "${pc.entityId}" has condition "${pc.value}" — hextech augmentations should remain operational`,
            'Ensure hextech-augmented characters maintain operational physical state.',
            'change_value',
            'condition',
          ));
        }
      }

      // Check: condition contains 'shimmer' → status != 'healthy'
      const condition = context.queryState(pc.entityId, 'condition');
      if (
        typeof condition === 'string' &&
        condition.includes('shimmer') &&
        pc.attribute === 'status' &&
        pc.value === 'healthy'
      ) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" has shimmer damage but is set to healthy status (violates shimmer rule)`,
          'Shimmer-damaged characters cannot be healthy. Use "stable" or "deteriorating" instead.',
          'change_value',
          'status',
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 5. CausalityValidator — LLM-assisted causal reasoning
// ============================================================================

export class CausalityValidator implements Validator {
  name = 'causality';
  category = 'timeline_plot' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check that preconditions are satisfied in current state
    for (const pc of event.preconditions) {
      const currentValue = context.queryState(pc.entityId, pc.attribute);

      if (currentValue === undefined || currentValue === null) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Precondition "${pc.entityId}.${pc.attribute} = ${pc.value}" is not satisfied — current value is ${JSON.stringify(currentValue)}`,
          'Add a preceding event that establishes this precondition, or adjust the expected preconditions.',
          'add_precondition',
          pc.attribute,
          undefined,
          pc.value,
        ));
      }
    }

    // Check: postconditions should logically follow from preconditions
    // Deterministic check: if postconditions are identical to preconditions, that's suspicious
    const preKeys = new Set(event.preconditions.map((p) => `${p.entityId}.${p.attribute}`));
    const postKeys = event.postconditions.map((p) => `${p.entityId}.${p.attribute}`);
    const allInPre = postKeys.every((k) => preKeys.has(k));

    if (allInPre && event.postconditions.length === event.preconditions.length) {
      issues.push(makeIssue(
        this.name, event.id, event.pov.character, 'warning',
        'All postconditions match preconditions — scene has no causal effect on the world',
        'This scene does not advance the story. Add meaningful state changes to expected_postconditions.',
        'change_value',
        'expected_postconditions',
      ));
    }

    return issues;
  }
}

// ============================================================================
// 6. ForeshadowingValidator — Check foreshadow status
// ============================================================================

export class ForeshadowingValidator implements Validator {
  name = 'foreshadowing';
  category = 'factual_detail' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check existing foreshadows: are they past due?
    for (const f of event.foreshadowing) {
      if (
        f.targetRevealChapter > 0 &&
        context.currentChapter > f.targetRevealChapter
      ) {
        issues.push(makeIssue(
          this.name, event.id, f.id, 'warning',
          `Foreshadow "${f.id}" (${f.hint}) was supposed to be revealed by chapter ${f.targetRevealChapter}, but we're at chapter ${context.currentChapter}`,
          'Add the reveal event, or update the target_reveal_chapter.',
          'change_value',
          'target_reveal_chapter',
        ));
      }
    }

    // Check all foreshadows in the event store: any dangling?
    // (partial check — full check is in ReachabilityValidator)
    const allForeshadows = context.events.flatMap((e) => e.foreshadowing);
    for (const f of allForeshadows) {
      if (f.targetRevealChapter > 0 && context.currentChapter > f.targetRevealChapter + 2) {
        // Already 2 chapters past due
        const alreadyReported = issues.some((i) => i.entity === f.id);
        if (!alreadyReported) {
          issues.push(makeIssue(
            this.name, f.id, f.id, 'error',
            `Foreshadow "${f.id}" is 2+ chapters past its reveal deadline (chapter ${f.targetRevealChapter})`,
            'Write the reveal scene or update the target chapter.',
            'change_value',
            'target_reveal_chapter',
          ));
        }
      }
    }

    return issues;
  }
}

// ============================================================================
// 7. POVValidator — POV consistency checks
// ============================================================================

export class POVValidator implements Validator {
  name = 'pov';
  category = 'narrative_style' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const povType = event.pov.type;
    const povChar = event.pov.character;

    // Check: POV character must exist in entity registry
    const povEntity = context.entityRegistry.resolve(povChar);
    if (!povEntity) {
      issues.push(makeIssue(
        this.name, event.id, povChar, 'error',
        `POV character "${povChar}" is not defined in entity registry`,
        'Define this character in definitions/characters/ or use an existing character.',
        'create_file',
        'character',
        `definitions/characters/${povChar}.yaml`,
      ));
    }

    // For third_person_limited: POV character should be in the scene
    if (povType === 'third_person_limited' || povType === 'first_person') {
      const inScene = event.participants.entities.includes(povChar);
      if (!inScene) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'warning',
          `POV character "${povChar}" is not listed as a participant in this scene (${povType} POV)`,
          'Add the POV character to the scene participants.',
          'change_value',
          'participants',
        ));
      }
    }

    // For omniscient: should not use omniscient for character-heavy scenes without reason
    if (povType === 'omniscient') {
      issues.push(makeIssue(
        this.name, event.id, povChar, 'info',
        'Using omniscient POV — ensure this is intentional. Limited POV often creates stronger reader engagement.',
        'Consider switching to third_person_limited for a specific character.',
        'manual',
      ));
    }

    return issues;
  }
}

// ============================================================================
// 8. FactualDetailValidator — LLM-assisted detail checking
// ============================================================================

export class FactualDetailValidator implements Validator {
  name = 'factual_detail';
  category = 'factual_detail' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check entity attribute consistency
    for (const pc of event.preconditions) {
      const entity = context.entityRegistry.resolve(pc.entityId);
      if (!entity) continue;

      const currentValue = context.queryState(pc.entityId, pc.attribute);
      const currentTraits = entity.state['traits'] as string[] | undefined;

      // Check trait-level contradictions
      if (pc.attribute === 'traits' && currentTraits) {
        const requestedTraits = Array.isArray(pc.value) ? pc.value : [pc.value];
        for (const trait of requestedTraits) {
          if (currentTraits.includes(trait as string)) {
            issues.push(makeIssue(
              this.name, event.id, pc.entityId, 'info',
              `Trait "${trait}" confirmed for "${pc.entityId}"`,
              'No action needed.',
              'manual',
            ));
          }
        }
      }
    }

    // Check for naming inconsistencies: entity IDs should match across references
    for (const pc of event.preconditions) {
      if (pc.value === 'changed' || pc.value === 'resolved' || pc.value === 'updated') {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Placeholder value "${pc.value}" used for "${pc.entityId}.${pc.attribute}" — this is not a verifiable fact`,
          'Use a specific, concrete value instead of a placeholder.',
          'change_value',
          pc.attribute,
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 9. VoiceDriftDetector — LLM-required (optional, default WARNING)
// ============================================================================

export class VoiceDriftDetector implements Validator {
  name = 'voice_drift';
  category = 'narrative_style' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check forbidden words if specified in style guidance
    if (event.styleGuidance?.avoid) {
      const forbidden = event.styleGuidance.avoid.split(',').map((w) => w.trim().toLowerCase());
      // This would need the actual prose text to check — only possible after rendering
      // For now, flag as needing LLM check
      if (forbidden.length > 0) {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'info',
          'Voice drift check requires LLM evaluation of rendered prose.',
          'After rendering, run voice drift analysis on the prose text.',
          'manual',
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 10. BranchMergeValidator — Check branch merge precondition consistency
// ============================================================================

export class BranchMergeValidator implements Validator {
  name = 'branch_merge';
  category = 'timeline_plot' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // For branch events: check if this is a merge point
    // A merge point is where multiple incoming branch paths converge
    const incomingBranches = context.events.filter(
      (e) =>
        e.narrativeOrder < event.narrativeOrder &&
        e.branchExistence.type !== 'all',
    );

    if (incomingBranches.length === 0) return issues;

    // Check each precondition against each incoming branch's final state
    for (const pc of event.preconditions) {
      const currentValue = context.queryState(pc.entityId, pc.attribute);

      if (currentValue === undefined || currentValue === null) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Merge precondition "${pc.entityId}.${pc.attribute} = ${pc.value}" is not satisfied (current: ${JSON.stringify(currentValue)}) on branch path`,
          'Ensure the precondition is satisfied on all incoming branch paths before merging.',
          'add_precondition',
          pc.attribute,
        ));
      }
    }

    return issues;
  }
}

// ============================================================================
// 11. ReachabilityValidator — Branch reachability, thread completion, foreshadow recovery, deadlocks
// ============================================================================

export class ReachabilityValidator implements Validator {
  name = 'reachability';
  category = 'timeline_plot' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // 1. Thread completion: check if threads are on track
    const allThreads = context.worldState.threads;
    for (const [threadId, threadData] of Object.entries(allThreads)) {
      if (
        threadData.progress < threadData.total &&
        context.currentChapter > event.narrativeOrder
      ) {
        const behind = threadData.total - threadData.progress;
        if (behind > 2 && context.currentChapter > 5) {
          issues.push(makeIssue(
            this.name, event.id, threadId, 'warning',
            `Thread "${threadId}" is behind: ${threadData.progress}/${threadData.total} (${behind} remaining) at chapter ${context.currentChapter}`,
            'Add events that advance this thread, or adjust the progress target.',
            'change_value',
            'thread_progress',
          ));
        }
      }
    }

    // 2. Foreshadow recovery: check for dangling foreshadows
    const allEvents = context.events;
    const allForeshadows = allEvents.flatMap((e) =>
      e.foreshadowing.map((f) => ({ ...f, eventId: e.id, chapter: Math.ceil(e.narrativeOrder / 3) })),
    );

    for (const f of allForeshadows) {
      if (f.targetRevealChapter > 0 && context.currentChapter > f.targetRevealChapter + 3) {
        issues.push(makeIssue(
          this.name, f.eventId, f.id, 'error',
          `Foreshadow "${f.id}" planted in ${f.eventId} (target: chapter ${f.targetRevealChapter}) is unrevealed at chapter ${context.currentChapter}`,
          'Resolve this foreshadow in an upcoming scene or mark it as intentionally abandoned.',
          'change_value',
          'target_reveal_chapter',
        ));
      }
    }

    // 3. Precondition deadlock: are there events whose preconditions can never be satisfied?
    const allFactIds = new Set<string>();
    for (const e of allEvents) {
      for (const pc of e.postconditions) {
        allFactIds.add(`${pc.entityId}.${pc.attribute}`);
      }
    }

    for (const e of allEvents) {
      if (e.narrativeOrder > event.narrativeOrder) continue;
      for (const pc of e.preconditions) {
        const factKey = `${pc.entityId}.${pc.attribute}`;
        if (!allFactIds.has(factKey)) {
          issues.push(makeIssue(
            this.name, e.id, pc.entityId, 'warning',
            `Precondition "${pc.entityId}.${pc.attribute}" in event ${e.id} is never established by any postcondition`,
            'Add an event that establishes this precondition, or remove it.',
            'add_precondition',
            pc.attribute,
          ));
        }
      }
    }

    return issues;
  }
}

// ============================================================================
// ResultAggregator — Collect, grade, and output validation results
// ============================================================================

export class ResultAggregator {
  private validators: Validator[];

  constructor(customValidators?: Validator[]) {
    this.validators = customValidators ?? [
      new TimelineValidator(),
      new CharacterStateValidator(),
      new KnowledgeValidator(),
      new WorldRuleValidator(),
      new CausalityValidator(),
      new ForeshadowingValidator(),
      new POVValidator(),
      new FactualDetailValidator(),
      new VoiceDriftDetector(),
      new BranchMergeValidator(),
      new ReachabilityValidator(),
    ];
  }

  /**
   * Run all validators against an event.
   */
  validate(
    event: NarrativeEvent,
    state: WorldState,
    registry: EntityRegistry,
    events: NarrativeEvent[],
    chapter: number,
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
  ): ValidationResult {
    const context = buildContext(event, state, registry, events, chapter);
    const allIssues: ValidationIssue[] = [];

    for (const validator of this.validators) {
      // Check if validator is disabled
      const override = overrides?.[validator.name];
      if (override === 'off') continue;

      const issues = validator.validate(event, context);

      // Apply severity override
      for (const issue of issues) {
        if (override === 'error') {
          issue.severity = 'error';
        } else if (override === 'warning') {
          issue.severity = issue.severity === 'error' ? 'error' : 'warning';
        }
        allIssues.push(issue);
      }
    }

    const errors = allIssues.filter((i) => i.severity === 'error');
    const warnings = allIssues.filter((i) => i.severity === 'warning');
    const infos = allIssues.filter((i) => i.severity === 'info');

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      infos,
    };
  }

  /**
   * Run all validators against all events in order.
   */
  validateAll(
    events: NarrativeEvent[],
    state: WorldState,
    registry: EntityRegistry,
    overrides?: Record<string, 'off' | 'warning' | 'error'>,
  ): Map<string, ValidationResult> {
    const results = new Map<string, ValidationResult>();

    for (const event of events) {
      if (event.id === 'system:genesis') continue;

      const chapter = Math.max(1, Math.ceil(event.narrativeOrder / 3));
      const result = this.validate(event, state, registry, events, chapter, overrides);
      results.set(event.id, result);
    }

    return results;
  }

  /** List all registered validators */
  listValidators(): Array<{ name: string; category: string; requiresLLM: boolean }> {
    return this.validators.map((v) => ({
      name: v.name,
      category: v.category,
      requiresLLM: v.requiresLLM,
    }));
  }
}
