// ============================================================================
// ISS — Input Structure Score
// Evaluates the structural quality of YAML input files for the narrative engine.
// Not literary quality — whether the system can actually use the data.
// Low ISS = the system is running "empty" with nothing to validate.
// ============================================================================

import {
  type EntityRegistry,
  type NarrativeEvent,
  type RuleDefinition,
  type ISSSnapshot,
  type ISSDimension,
  type ISSGap,
  type ValidationIssue,
} from '../types/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLACEHOLDER_VALUES = ['changed', 'resolved', 'updated', 'affected', 'modified', 'altered'] as const;
type PlaceholderValue = (typeof PLACEHOLDER_VALUES)[number];

function isPlaceholderValue(value: unknown): value is PlaceholderValue {
  return typeof value === 'string' && PLACEHOLDER_VALUES.includes(value.toLowerCase() as PlaceholderValue);
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface ISSOptions {
  projectDir: string;
  entityRegistry: EntityRegistry;
  events: NarrativeEvent[];
  threads: Array<{ id: string; name: string }>;
  rules: RuleDefinition[];
}

export interface StrictValidationContext {
  entityRegistry: EntityRegistry;
  events: NarrativeEvent[];
  rules: RuleDefinition[];
  threads: Array<{ id: string; name: string }>;
}

// ─── Dimension Calculators ──────────────────────────────────────────────────

/**
 * a. 实体引用完整性 (Entity Reference Completeness) — max 20, threshold 18
 *
 * For each unique entity ID referenced across all events (POV character,
 * participants, preconditions, postconditions, relationship participants),
 * check whether it has a registered definition in the entity registry.
 */
function calcEntityReferenceCompleteness(
  registry: EntityRegistry,
  events: NarrativeEvent[],
): ISSDimension {
  const MAX = 20;
  const THRESHOLD = 18;

  const referencedIds = new Set<string>();

  for (const event of events) {
    referencedIds.add(event.pov.character);
    for (const entityId of event.participants.entities) {
      referencedIds.add(entityId);
    }
    for (const pre of event.preconditions) {
      referencedIds.add(pre.entityId);
    }
    for (const post of event.postconditions) {
      referencedIds.add(post.entityId);
    }
    for (const rel of event.relationshipEffects) {
      referencedIds.add(rel.participants[0]);
      referencedIds.add(rel.participants[1]);
    }
  }

  // Remove any empty strings
  referencedIds.delete('');

  const totalReferenced = referencedIds.size;
  let definedCount = 0;
  const gaps: ISSGap[] = [];

  for (const id of referencedIds) {
    const entity = registry.resolve(id);
    if (entity !== null) {
      definedCount++;
    } else {
      gaps.push({
        entity: id,
        suggestion: `Entity "${id}" is referenced in events but has no YAML definition. Create a definition file for this entity.`,
        fixAction: 'create_file',
        fixTarget: `entities/${id}.yaml`,
        template: `# ${id}\nkind: character  # or location | item | concept | faction\nname: "${id}"\ndescription: ""\ninitialState: {}\ntraits: []`,
      });
    }
  }

  const score = totalReferenced > 0 ? Math.round((definedCount / totalReferenced) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: '实体引用完整性 (Entity Reference Completeness)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

/**
 * b. 规则可执行性 (Rule Executability) — max 15, threshold 12
 *
 * Each defined rule must have at least one logicalConsequences entry with
 * a non-null `check` object so the validator can actually enforce it.
 */
function calcRuleExecutability(rules: RuleDefinition[]): ISSDimension {
  const MAX = 15;
  const THRESHOLD = 12;

  let rulesWithChecks = 0;
  const gaps: ISSGap[] = [];

  for (const rule of rules) {
    const hasCheck = rule.logicalConsequences.some(lc => lc.check !== null && lc.check !== undefined);
    if (hasCheck) {
      rulesWithChecks++;
    } else {
      gaps.push({
        id: rule.ruleId,
        suggestion:
          `Rule "${rule.name}" (${rule.ruleId}) has no executable checks. ` +
          `Add at least one logicalConsequences entry with a complete check definition.`,
        fixAction: 'edit_file',
        fixTarget: `rules/${rule.ruleId}.yaml`,
        template:
          `logicalConsequences:\n` +
          `  - description: "..."\n` +
          `    check:\n` +
          `      type: state_invariant | transition_constraint | progression\n` +
          `      filter: "..."\n` +
          `      assert: "..."\n` +
          `      severity: error | warning`,
      });
    }
  }

  const score = rules.length > 0 ? Math.round((rulesWithChecks / rules.length) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: '规则可执行性 (Rule Executability)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

/**
 * c. 前置条件深度 (Precondition Depth) — max 15, threshold 12
 *
 * Events (except the first chronologically) should declare at least one
 * precondition. This ensures the narrative has causal structure.
 */
function calcPreconditionDepth(sortedEvents: NarrativeEvent[]): ISSDimension {
  const MAX = 15;
  const THRESHOLD = 12;

  // The first event (narrativeOrder === lowest) is exempt — it is the inciting
  // scene that establishes the initial state.
  const eventsToCheck = sortedEvents.slice(1);
  let eventsWithPreconditions = 0;
  const gaps: ISSGap[] = [];

  for (const event of eventsToCheck) {
    if (event.preconditions.length > 0) {
      eventsWithPreconditions++;
    } else {
      gaps.push({
        id: event.id,
        suggestion:
          `Event "${event.event}" (${event.id}) has no preconditions. ` +
          `Add at least one precondition describing what must be true before this scene can happen.`,
        fixAction: 'edit_file',
        fixTarget: `events/${event.event}.yaml`,
      });
    }
  }

  const score = eventsToCheck.length > 0 ? Math.round((eventsWithPreconditions / eventsToCheck.length) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: '前置条件深度 (Precondition Depth)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

/**
 * d. 后置条件具体性 (Postcondition Specificity) — max 20, threshold 16
 *
 * Each postcondition value must be concrete — not a generic placeholder like
 * "changed", "updated", "resolved", etc.
 */
function calcPostconditionSpecificity(events: NarrativeEvent[]): ISSDimension {
  const MAX = 20;
  const THRESHOLD = 16;

  let totalPostconditions = 0;
  let specificPostconditions = 0;
  const gaps: ISSGap[] = [];

  for (const event of events) {
    for (const post of event.postconditions) {
      totalPostconditions++;
      if (!isPlaceholderValue(post.value)) {
        specificPostconditions++;
      } else {
        gaps.push({
          entity: post.entityId,
          id: post.id,
          suggestion:
            `Postcondition "${post.attribute}" for entity "${post.entityId}" uses placeholder value ` +
            `"${String(post.value)}". Replace with a specific, concrete value that reflects the actual story change.`,
          fixAction: 'change_value',
          fixTarget: `events/${event.event}.yaml`,
        });
      }
    }
  }

  const score = totalPostconditions > 0 ? Math.round((specificPostconditions / totalPostconditions) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: '后置条件具体性 (Postcondition Specificity)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

/**
 * e. Thread 覆盖率 (Thread Coverage) — max 20, threshold 15
 *
 * Each defined thread must be referenced by at least one event's
 * threadProgress entry so the narrative engine knows when to advance it.
 */
function calcThreadCoverage(
  threads: Array<{ id: string; name: string }>,
  events: NarrativeEvent[],
): ISSDimension {
  const MAX = 20;
  const THRESHOLD = 15;

  const referencedThreads = new Set<string>();
  for (const event of events) {
    for (const tp of event.threadProgress) {
      referencedThreads.add(tp.thread);
    }
  }

  let referencedCount = 0;
  const gaps: ISSGap[] = [];

  for (const thread of threads) {
    if (referencedThreads.has(thread.id)) {
      referencedCount++;
    } else {
      gaps.push({
        id: thread.id,
        suggestion:
          `Thread "${thread.name}" (${thread.id}) is defined but never referenced in any event's threadProgress. ` +
          `Add threadProgress entries to advance this thread through the narrative.`,
        fixAction: 'edit_file',
        fixTarget: `world.yaml`,
      });
    }
  }

  const score = threads.length > 0 ? Math.round((referencedCount / threads.length) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: 'Thread 覆盖率 (Thread Coverage)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

/**
 * f. 伏笔覆盖率 (Foreshadow Coverage) — max 10, threshold 8
 *
 * Each foreshadowing entry must have a valid (positive finite number)
 * targetRevealChapter so the engine knows when to pay off the hint.
 */
function calcForeshadowCoverage(events: NarrativeEvent[]): ISSDimension {
  const MAX = 10;
  const THRESHOLD = 8;

  let totalForeshadows = 0;
  let validForeshadows = 0;
  const gaps: ISSGap[] = [];

  for (const event of events) {
    for (const f of event.foreshadowing) {
      totalForeshadows++;
      const ch = f.targetRevealChapter;
      if (typeof ch === 'number' && Number.isFinite(ch) && ch > 0 && Number.isInteger(ch)) {
        validForeshadows++;
      } else {
        gaps.push({
          id: f.id,
          suggestion:
            `Foreshadow entry "${f.id}" in event "${event.event}" has an invalid targetRevealChapter ` +
            `(${String(f.targetRevealChapter)}). Set a positive integer chapter number for the reveal.`,
          fixAction: 'change_value',
          fixTarget: `events/${event.event}.yaml`,
        });
      }
    }
  }

  const score = totalForeshadows > 0 ? Math.round((validForeshadows / totalForeshadows) * MAX) : MAX;
  const status = scoreToStatus(score, THRESHOLD);

  return {
    name: '伏笔覆盖率 (Foreshadow Coverage)',
    score,
    max: MAX,
    threshold: THRESHOLD,
    status,
    gaps,
  };
}

// ─── Status Helper ──────────────────────────────────────────────────────────

function scoreToStatus(score: number, threshold: number): 'green' | 'yellow' | 'red' {
  if (score >= threshold) return 'green';
  if (score >= threshold * 0.5) return 'yellow';
  return 'red';
}

// ─── Main Calculator ────────────────────────────────────────────────────────

/**
 * calculateISS — Main entry point for the Input Structure Score.
 *
 * Evaluates six dimensions of structural quality and returns an ISSSnapshot
 * with the overall score (0–100), the target (sum of thresholds), and per-
 * dimension breakdowns including gaps.
 */
export function calculateISS(options: ISSOptions): ISSSnapshot {
  const { entityRegistry, events, threads, rules } = options;

  // Sort events once and share across dimensions that need ordering
  const sortedEvents = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);

  const dimensions: ISSDimension[] = [
    calcEntityReferenceCompleteness(entityRegistry, events),
    calcRuleExecutability(rules),
    calcPreconditionDepth(sortedEvents),
    calcPostconditionSpecificity(events),
    calcThreadCoverage(threads, events),
    calcForeshadowCoverage(events),
  ];

  const overall = Math.round(dimensions.reduce((sum, d) => sum + d.score, 0));
  const target = Math.round(dimensions.reduce((sum, d) => sum + d.threshold, 0));

  return { overall, target, dimensions };
}

// ─── Anti-pattern Detection ─────────────────────────────────────────────────

/**
 * detectAntiPatterns — Scans the input data for known structural anti-patterns
 * and returns WARNING-level ValidationIssue[] entries.
 *
 * Checks performed:
 *  1. Single-adjective traits  — each character trait should be multi-word
 *  2. Copy-pasted preconditions — identical precondition sets across events
 *  3. Dead threads              — thread progress stuck at 0/0 past chapter 5
 *  4. Empty scenes              — events with zero postconditions
 */
export function detectAntiPatterns(options: {
  entityRegistry: EntityRegistry;
  events: NarrativeEvent[];
  threads: Array<{ id: string; name: string }>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { entityRegistry, events, threads } = options;

  // ═══ 1. Single-adjective traits ═══
  const characters = entityRegistry.findByKind('character');
  for (const char of characters) {
    const traits = char.state?.['traits'] as unknown as string[] | undefined;
    if (!traits || traits.length === 0) continue;

    for (const trait of traits) {
      const words = trait.trim().split(/\s+/);
      if (words.length <= 1) {
        issues.push({
          validator: 'iss-anti-pattern',
          severity: 'warning',
          event: '',
          entity: char.id,
          attribute: 'traits',
          message:
            `Character "${char.name}" has single-adjective trait "${trait}". ` +
            `Traits should be multi-word phrases (e.g. "fiercely loyal", "haunted by failure") for richer characterization.`,
          fixSuggestion: `Expand "${trait}" into a more descriptive multi-word trait.`,
          fixAction: 'change_value',
          fixTarget: { file: char.definitionFile, field: 'traits' },
        });
      }
    }
  }

  // ═══ 2. Copy-pasted preconditions ═══
  const precondMap = new Map<string, string[]>();
  for (const event of events) {
    if (event.preconditions.length === 0) continue;
    const serialized = event.preconditions
      .map(p => `${p.entityId}:${p.attribute}:${JSON.stringify(p.value)}`)
      .sort()
      .join('|');
    if (!precondMap.has(serialized)) {
      precondMap.set(serialized, []);
    }
    precondMap.get(serialized)!.push(event.id);
  }

  for (const [serialized, eventIds] of precondMap.entries()) {
    if (serialized && eventIds.length > 1) {
      const others = eventIds.filter(e => e !== eventIds[0]);
      for (const eventId of eventIds) {
        issues.push({
          validator: 'iss-anti-pattern',
          severity: 'warning',
          event: eventId,
          entity: '',
          message:
            `Event "${eventId}" shares identical preconditions with ` +
            `${others.join(', ')}. Duplicate precondition sets suggest copy-paste ` +
            `and reduce causal differentiation between scenes.`,
          fixSuggestion:
            'Differentiate preconditions across events so each scene has unique structural requirements.',
          fixAction: 'manual',
          fixTarget: { file: `events/${eventId}.yaml`, field: 'preconditions' },
        });
      }
    }
  }

  // ═══ 3. Dead threads ═══
  const sortedEvents = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  const eventsPast5 = sortedEvents.filter(e => e.narrativeOrder > 5);

  // Track the latest progress per thread among events past chapter 5
  const threadProgressPast5 = new Map<string, { progress: number; total: number }>();
  for (const event of eventsPast5) {
    for (const tp of event.threadProgress) {
      // Keep the last-seen (highest narrativeOrder) value
      threadProgressPast5.set(tp.thread, {
        progress: tp.progressAfter,
        total: tp.progressTotal,
      });
    }
  }

  for (const thread of threads) {
    const prog = threadProgressPast5.get(thread.id);
    if (prog !== undefined && prog.progress === 0 && prog.total === 0) {
      issues.push({
        validator: 'iss-anti-pattern',
        severity: 'warning',
        event: '',
        entity: '',
        message:
          `Thread "${thread.name}" (${thread.id}) is defined but its progress is still 0/0 ` +
          `after 5 chapters. No events are advancing this thread — it will never resolve.`,
        fixSuggestion:
          'Add threadProgress entries referencing this thread in events, or remove it if unused.',
        fixAction: 'manual',
        fixTarget: { file: 'world.yaml', field: `threads.${thread.id}.progress` },
      });
    }
  }

  // ═══ 4. Empty scenes ═══
  for (const event of events) {
    if (event.postconditions.length === 0) {
      issues.push({
        validator: 'iss-anti-pattern',
        severity: 'warning',
        event: event.id,
        entity: '',
        message:
          `Event "${event.event}" (${event.id}) has no postconditions. ` +
          `An event should introduce at least one new fact or state change to advance the narrative.`,
        fixSuggestion:
          'Add at least one expectedPostcondition that describes what changes after this scene.',
        fixAction: 'manual',
        fixTarget: { file: `events/${event.event}.yaml`, field: 'expectedPostconditions' },
      });
    }
  }

  return issues;
}

// ─── Strict Mode Validation ─────────────────────────────────────────────────

/**
 * validateStrict — Enforces minimum structural thresholds derived from the
 * agent prompt specification. Returns ERROR-level ValidationIssue[] for any
 * violation.
 *
 * Strict checks:
 *  1. Each character must have ≥ 3 verifiable traits
 *  2. Each event (except first) must have ≥ 1 precondition
 *  3. Each rule must have ≥ 1 executable check
 *  4. Each thread must be referenced within the first 3 chapters
 *  5. No placeholder postcondition values allowed
 */
export function validateStrict(context: StrictValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { entityRegistry, events, rules, threads } = context;

  // ═══ 1. Characters must have ≥ 3 verifiable traits ═══
  const characters = entityRegistry.findByKind('character');
  for (const char of characters) {
    const traits = char.state?.['traits'] as unknown as string[] | undefined;
    const traitCount = traits ? traits.length : 0;
    if (traitCount < 3) {
      issues.push({
        validator: 'iss-strict',
        severity: 'error',
        event: '',
        entity: char.id,
        attribute: 'traits',
        message:
          `Character "${char.name}" has only ${traitCount} verifiable trait(s). ` +
          `Strict mode requires a minimum of 3 traits for adequate characterization.`,
        fixSuggestion: `Add ${3 - traitCount} more traits to character "${char.name}" in its YAML definition.`,
        fixAction: 'manual',
        fixTarget: { file: char.definitionFile, field: 'traits' },
      });
    }
  }

  // ═══ 2. Each event (except E1) must have ≥ 1 precondition ═══
  const sortedEvents = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  const eventsToCheck = sortedEvents.slice(1); // skip the first/inciting event
  for (const event of eventsToCheck) {
    if (event.preconditions.length === 0) {
      issues.push({
        validator: 'iss-strict',
        severity: 'error',
        event: event.id,
        entity: '',
        message:
          `Event "${event.event}" (${event.id}, order ${event.narrativeOrder}) has no preconditions. ` +
          `Strict mode requires at least 1 precondition for every event except the first.`,
        fixSuggestion:
          'Add at least one precondition describing what must be true before this scene can occur.',
        fixAction: 'add_precondition',
        fixTarget: { file: `events/${event.event}.yaml`, field: 'preconditions' },
      });
    }
  }

  // ═══ 3. Each rule must have ≥ 1 executable check ═══
  for (const rule of rules) {
    const hasCheck = rule.logicalConsequences.some(lc => lc.check !== null && lc.check !== undefined);
    if (!hasCheck) {
      issues.push({
        validator: 'iss-strict',
        severity: 'error',
        event: '',
        entity: rule.ruleId,
        message:
          `Rule "${rule.name}" (${rule.ruleId}) has no executable check. ` +
          `Strict mode requires at least 1 logicalConsequences.check entry.`,
        fixSuggestion:
          'Add a logicalConsequences entry with a valid check (state_invariant, transition_constraint, or progression).',
        fixAction: 'manual',
        fixTarget: { file: `rules/${rule.ruleId}.yaml`, field: 'logicalConsequences' },
      });
    }
  }

  // ═══ 4. Each thread must be referenced within the first 3 chapters ═══
  const earlyEvents = sortedEvents.filter(e => e.narrativeOrder <= 3);
  const earlyThreadRefs = new Set<string>();
  for (const event of earlyEvents) {
    for (const tp of event.threadProgress) {
      earlyThreadRefs.add(tp.thread);
    }
  }
  for (const thread of threads) {
    if (!earlyThreadRefs.has(thread.id)) {
      issues.push({
        validator: 'iss-strict',
        severity: 'error',
        event: '',
        entity: thread.id,
        message:
          `Thread "${thread.name}" (${thread.id}) is not referenced within the first 3 chapters. ` +
          `Strict mode requires each thread to appear in an event's threadProgress by narrative order 3.`,
        fixSuggestion:
          'Add a threadProgress entry referencing this thread in one of the first 3 events.',
        fixAction: 'manual',
        fixTarget: { file: 'world.yaml', field: 'threads' },
      });
    }
  }

  // ═══ 5. No placeholder postconditions ═══
  for (const event of events) {
    for (const post of event.postconditions) {
      if (isPlaceholderValue(post.value)) {
        issues.push({
          validator: 'iss-strict',
          severity: 'error',
          event: event.id,
          entity: post.entityId,
          attribute: post.attribute,
          message:
            `Postcondition "${post.attribute}" for entity "${post.entityId}" uses placeholder value ` +
            `"${String(post.value)}". Strict mode prohibits vague placeholder values.`,
          fixSuggestion:
            `Replace "${String(post.value)}" with a specific concrete value that reflects the actual change.`,
          fixAction: 'change_value',
          fixTarget: { file: `events/${event.event}.yaml`, field: 'expectedPostconditions' },
        });
      }
    }
  }

  return issues;
}
