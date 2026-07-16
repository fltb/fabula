// ============================================================================
// TimelineValidator — Absolute time contradictions, duration, simultaneity
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { compareTimestamp } from '../entity/index.js';
import { makeIssue } from './base.js';

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
