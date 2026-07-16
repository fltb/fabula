// ============================================================================
// ReachabilityValidator — Branch reachability, thread completion, foreshadow recovery, deadlocks
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

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
