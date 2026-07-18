// ============================================================================
// TimelineValidator — Absolute time contradictions, duration, simultaneity
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidationIssue,
  PreRenderInput,
  PostRenderInput,
} from '../types/index.js';
import { compareTimestamp, resolveTimestampToDay } from '../entity/index.js';
import { buildCausalEdges } from '../state/dag.js';
import { makeIssue } from './base.js';

export class TimelineValidator implements Validator {
  name = 'timeline';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    // Find predecessor via DAG causal edges (most recent by narrativeOrder)
    const { edges } = buildCausalEdges(events);
    const predecessors: string[] = [];
    for (const [srcId, targets] of edges) {
      if (targets.includes(event.id) && srcId !== 'system:genesis') {
        predecessors.push(srcId);
      }
    }
    let prevEvent: NarrativeEvent | undefined;
    if (predecessors.length > 0) {
      // Sort predecessors by narrativeOrder, take the most recent
      const prevId = predecessors.sort((a, b) => {
        const ea = events.find((e) => e.id === a)!;
        const eb = events.find((e) => e.id === b)!;
        return eb.narrativeOrder - ea.narrativeOrder;
      })[0];
      prevEvent = events.find((e) => e.id === prevId);
    } else {
      // Fallback: use narrativeOrder predecessor when no DAG edges exist
      const prevEvents = events.filter(
        (e) => e.narrativeOrder < event.narrativeOrder && e.id !== 'system:genesis',
      );
      prevEvent = prevEvents[prevEvents.length - 1];
    }

    if (prevEvent && event.storyTime && prevEvent.storyTime) {
      // Build anchors map from all events' storyTime values, keyed by event ID.
      // This allows relative timestamps referencing other event IDs to resolve correctly.
      // For absolute timestamps (e.g. "day_5"), resolution is direct.
      // For relative timestamps, the incremental build ensures earlier events' resolved
      // values are available when resolving later events' relative references.
      const anchors = new Map<string, number>();
      for (const e of input.events) {
        if (e.storyTime) {
          anchors.set(e.id, resolveTimestampToDay(e.storyTime, anchors));
        }
      }
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

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks = input.analysis.analysis.narrativeChecks ?? [];
    for (const check of narrativeChecks) {
      if (check.attribute !== 'time_period') continue;
      if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
        issues.push(makeIssue(
          'timeline',
          input.event.id,
          input.event.id,
          'warning',
          `Time period mismatch: ${check.evidence}`,
          'Review time-of-day consistency',
          'edit_file',
          'storyTime',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['time_period'],
      schemaExample: { entityId: 'E1', attribute: 'time_period', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[time_period]: Check if the prose includes atmospheric cues and setting details that match the story time (night, dawn, day, dusk, midnight, etc.). Use the narrativeChecks block with attribute "time_period" to report whether the prose\'s time-of-day cues match the expected story time. Report matchLevel as "exact", "similar", "absent", or "contradicted".',
    }];
  }
}
