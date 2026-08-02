// ============================================================================
// ISS — Anti-pattern Detection
// ============================================================================

import type { EntityLookup, NarrativeEvent, ValidationIssue } from '../types/index.js';

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
  entities: EntityLookup;
  events: NarrativeEvent[];
  threads: Array<{ id: string; name: string }>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { entities, events, threads } = options;

  // ═══ 1. Single-adjective traits ═══
  const characters = entities.findByKind('character');
  for (const char of characters) {
    const traits = char.state?.traits as unknown as string[] | undefined;
    if (!traits || traits.length === 0) continue;

    for (const trait of traits) {
      const words = trait.trim().split(/\s+/);
      if (words.length <= 1) {
        issues.push({
          validator: 'iss-anti-pattern',
          severity: 'warning',
          kind: 'compiler_invariant',
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
      .map((p) => `${p.entityId}:${p.attribute}:${JSON.stringify(p.value)}`)
      .sort()
      .join('|');
    let eventIds = precondMap.get(serialized);
    if (!eventIds) {
      eventIds = [];
      precondMap.set(serialized, eventIds);
    }
    eventIds.push(event.id);
  }

  for (const [serialized, eventIds] of precondMap.entries()) {
    if (serialized && eventIds.length > 1) {
      const others = eventIds.filter((e) => e !== eventIds[0]);
      for (const eventId of eventIds) {
        issues.push({
          validator: 'iss-anti-pattern',
          severity: 'warning',
          kind: 'compiler_invariant',
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
  const eventsPast5 = sortedEvents.filter((e) => e.narrativeOrder > 5);

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
        kind: 'compiler_invariant',
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
        kind: 'compiler_invariant',
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
