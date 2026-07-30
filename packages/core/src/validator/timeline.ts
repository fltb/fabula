// ============================================================================
// TimelineValidator — Absolute time contradictions, duration, simultaneity
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { consumeNarrativeChecks, getAttributeSemanticRole, makeIssue } from './base.js';
import { narrativeCheckSchema } from './schemas.js';

export class TimelineValidator implements Validator {
  name = 'timeline';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    // Chronology check: use supplied story context only.
    // When no story context is available (isolated aggregator usage), skip.
    // The timeline validator never re-compiles the graph or resolves raw timestamps.
    const story = input.story;

    if (story) {
      // Choose preceding scene by narrativeOrder.
      const prevEvents = events.filter(
        (e) => e.narrativeOrder < event.narrativeOrder && e.id !== 'system:genesis',
      );
      const prevEvent = prevEvents[prevEvents.length - 1];

      if (prevEvent && event.storyTime && prevEvent.storyTime) {
        const currentCoord = story.coordinatesByEventId.get(event.id);
        const prevCoord = story.coordinatesByEventId.get(prevEvent.id);

        // Only check linear backwards jump when both coordinates are same-clock
        // point coordinates. Unlocated, cross-clock, or missing coordinates skip.
        if (
          currentCoord?.kind === 'point' &&
          prevCoord?.kind === 'point' &&
          currentCoord.clock === prevCoord.clock
        ) {
          if (currentCoord.scalar < prevCoord.scalar && event.sceneType === 'linear') {
            issues.push(
              makeIssue(
                this.name,
                event.id,
                event.pov.character,
                'error',
                `Story time coordinate (${currentCoord.clock}, ${currentCoord.scalar}) is before previous event's coordinate (${prevCoord.clock}, ${prevCoord.scalar})`,
                'If this is intentional (flashback), set scene_type to "flashback". Otherwise, adjust story_time.',
                'declare_flashback',
                'story_time',
              ),
            );
          }
        }
      }
    }

    // Check: sceneType must be a valid enum value
    const VALID_SCENE_TYPES = ['linear', 'flashback', 'flashforward', 'dream', 'parallel'];
    if (!VALID_SCENE_TYPES.includes(event.sceneType)) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          event.pov.character,
          'error',
          `Invalid sceneType "${event.sceneType}" — must be one of: ${VALID_SCENE_TYPES.join(', ')}`,
          'Set scene_type to a valid value.',
          'change_value',
          'scene_type',
        ),
      );
    }

    // Check: flashback/scene should have narrationTime if different from storyTime
    if (event.sceneType !== 'linear' && !event.narrationTime) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          event.pov.character,
          'warning',
          `Scene type is "${event.sceneType}" but no narration_time is set`,
          'Add narration_time field to indicate where in the narrative this scene is told.',
          'add_field',
          'narration_time',
        ),
      );
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks =
      z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
    issues.push(
      ...consumeNarrativeChecks(
        narrativeChecks,
        (check) => {
          // Catalog-driven: check if attribute has temporal semanticRole
          // time_period is the primary attribute; also accept any catalog temporal attrs
          if (check.attribute !== 'time_period') {
            const entityKind = input.entityRegistry?.resolve(check.entityId)?.kind;
            if (!entityKind || getAttributeSemanticRole(entityKind, check.attribute) !== 'temporal')
              return false;
          }
          return check.matchLevel === 'absent' || check.matchLevel === 'contradicted';
        },
        (check) =>
          makeIssue(
            'timeline',
            input.event.id,
            input.event.id,
            'warning',
            `Time period mismatch: ${check.evidence}`,
            'Review time-of-day consistency',
            'edit_file',
            'storyTime',
          ),
      ),
    );
    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'narrativeChecks',
        attributes: ['time_period'],
        schema: z.array(narrativeCheckSchema),
        instruction:
          'narrativeChecks[time_period]: Check if the prose includes atmospheric cues and setting details that match the story time (night, dawn, day, dusk, midnight, etc.). Use the narrativeChecks block with attribute "time_period" to report whether the prose\'s time-of-day cues match the expected story time. Report matchLevel as "exact", "similar", "absent", or "contradicted".',
      },
    ];
  }
}
