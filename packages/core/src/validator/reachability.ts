// ============================================================================
// ReachabilityValidator — Thread completion tracking, precondition deadlock detection
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class ReachabilityValidator implements Validator {
  name = 'reachability';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;

    // 1. Thread completion: check if threads are on track
    const allThreads = input.worldState.threads;
    for (const [threadId, threadData] of Object.entries(allThreads)) {
      const goalStates = threadData.goalStates ?? {};
      const totalGoals = Object.keys(goalStates!).length;
      const achievedGoals = Object.values(goalStates!).filter(s => s === 'achieved').length;
      if (
        achievedGoals < totalGoals &&
        input.chapter > event.narrativeOrder
      ) {
        const behind = totalGoals - achievedGoals;
        if (behind > 2 && input.chapter > 5) {
          issues.push(makeIssue(
            this.name, event.id, threadId, 'warning',
            `Thread "${threadId}" is behind: ${achievedGoals}/${totalGoals} goals (${behind} remaining) at chapter ${input.chapter}`,
            'Add events that advance this thread, or adjust the progress target.',
            'change_value',
            'thread_progress',
          ));
        }
      }
    }
    
    // 2. Precondition deadlock: are there events whose preconditions can never be satisfied?
    const allEvents = input.events;
    const allFactIds = new Set<string>();
    // Include initialFacts from world state (applied by compileStoryBoundaries)
    for (const [entityId, attrs] of Object.entries(input.worldState.entities)) {
      for (const attr of Object.keys(attrs)) {
        allFactIds.add(`${entityId}.${attr}`);
      }
    }
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
  
  validatePost(_input: PostRenderInput): ValidationIssue[] {
    return [];
  }


  getAnalysisRequirements() {
    return []; // No Pass 2 analysis needed
  }
}
