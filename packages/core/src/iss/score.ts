// ============================================================================
// ISS — Score Calculation
// ============================================================================

import {
  type EntityRegistry,
  type NarrativeEvent,
  type RuleDefinition,
  type ISSSnapshot,
  type ISSDimension,
  type ISSGap,
} from '../types/index.js';
import { type ISSOptions, isPlaceholderValue } from './types.js';

// ─── Status Helper ──────────────────────────────────────────────────────────

function scoreToStatus(score: number, threshold: number): 'green' | 'yellow' | 'red' {
  if (score >= threshold) return 'green';
  if (score >= threshold * 0.5) return 'yellow';
  return 'red';
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
      for (const m of rel.membershipAfter) {
        referencedIds.add(m.entityId);
      }
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
