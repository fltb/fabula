// ============================================================================
// ISS — Strict Mode Validation
// ============================================================================

import type { ValidationIssue } from '../types/index.js';
import { isPlaceholderValue, type StrictValidationContext } from './types.js';

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
        kind: 'compiler_invariant',
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
        kind: 'compiler_invariant',
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
    const hasCheck = rule.logicalConsequences.some(
      (lc) => lc.check !== null && lc.check !== undefined,
    );
    if (!hasCheck) {
      issues.push({
        validator: 'iss-strict',
        severity: 'error',
        kind: 'compiler_invariant',
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
  const earlyEvents = sortedEvents.filter((e) => e.narrativeOrder <= 3);
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
        kind: 'compiler_invariant',
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
          kind: 'compiler_invariant',
          event: event.id,
          entity: post.entityId,
          attribute: post.attribute,
          message:
            `Postcondition "${post.attribute}" for entity "${post.entityId}" uses placeholder value ` +
            `"${String(post.value)}". Strict mode prohibits vague placeholder values.`,
          fixSuggestion: `Replace "${String(post.value)}" with a specific concrete value that reflects the actual change.`,
          fixAction: 'change_value',
          fixTarget: { file: `events/${event.event}.yaml`, field: 'expectedPostconditions' },
        });
      }
    }
  }

  return issues;
}
