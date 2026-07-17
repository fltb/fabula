// ============================================================================
// TimelineValidator — Absolute time contradictions, duration, simultaneity
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
  PostRenderInput,
} from '../types/index.js';
import { compareTimestamp } from '../entity/index.js';
import { makeIssue } from './base.js';

export class TimelineValidator implements Validator {
  name = 'timeline';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    // Check: narrative order must be strictly increasing
    const prevEvents = events.filter(
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

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { prose, event } = input;

    const storyTime = event.storyTime;
    if (storyTime?.type !== 'absolute') return issues;

    const value = storyTime.value.toLowerCase();
    const lowerProse = prose.toLowerCase();

    // Time period keyword sets
    const timeKeywords: [string, string[]][] = [
      ['night', ['night', 'dark', 'dusk', 'moon', 'stars', 'midnight', 'evening']],
      ['dawn', ['dawn', 'morning', 'sunrise', 'daybreak']],
      ['day', ['day', 'afternoon', 'noon', 'midday', 'sun', 'daylight']],
      ['dusk', ['dusk', 'twilight', 'sunset', 'evening']],
      ['midnight', ['midnight']],
    ];

    // Find matching time period from storyTime value
    // Check if any keyword for a period appears in the storyTime value
    let keywords: string[] | null = null;
    for (const [, kws] of timeKeywords) {
      if (kws.some((kw) => value.includes(kw))) {
        keywords = kws;
        break;
      }
    }

    if (!keywords) return issues;

    const found = keywords.some((kw) => lowerProse.includes(kw));
    if (!found) {
      issues.push(makeIssue(
        this.name, event.id, event.pov.character, 'warning',
        `Story time is "${value}" but prose lacks matching time-of-day cues (e.g., ${keywords.slice(0, 3).join(', ')})`,
        'Add atmospheric details that reflect the time of day in the prose.',
        'edit_file',
      ));
    }

    return issues;
  }
}
