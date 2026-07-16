import type { StoryTimestamp } from '../types/index.js';

// ============================================================================
// Timestamp Helpers
// ============================================================================

export function parseStoryTimestamp(raw: string | undefined, anchors: Map<string, number>): StoryTimestamp {
  if (raw === undefined || raw === null) return { type: 'absolute', value: 'day_0' };
  // Try "anchor + N unit" pattern
  const relativeMatch = raw.match(/^(\S+)\s*\+\s*(\d+)\s*(minute|hour|day|week|month)s?$/);
  if (relativeMatch) {
    return {
      type: 'relative',
      anchor: relativeMatch[1],
      offset: {
        amount: parseInt(relativeMatch[2], 10),
        unit: relativeMatch[3] as 'minute' | 'hour' | 'day' | 'week' | 'month',
      },
    };
  }

  // Try chapter_N pattern
  const chapterMatch = raw.match(/^chapter[_\s]*(\d+)$/i);
  if (chapterMatch) {
    return { type: 'chapter', chapter: parseInt(chapterMatch[1], 10) };
  }

  // Fallback: absolute timestamp
  return { type: 'absolute', value: raw };
}

export function resolveTimestampToDay(ts: StoryTimestamp, anchors: Map<string, number>): number {
  switch (ts.type) {
    case 'absolute': {
      const dayMatch = ts.value.match(/^day[_\s]*(\d+)$/i);
      if (dayMatch) return parseInt(dayMatch[1], 10);
      return 0;
    }
    case 'relative': {
      const anchorDay = anchors.get(ts.anchor) ?? 0;
      const unitDays: Record<string, number> = {
        minute: 1 / 1440,
        hour: 1 / 24,
        day: 1,
        week: 7,
        month: 30,
      };
      return anchorDay + ts.offset.amount * (unitDays[ts.offset.unit] ?? 1);
    }
    case 'chapter':
      return ts.chapter;
  }
}

export function compareTimestamp(a: StoryTimestamp, b: StoryTimestamp, anchors: Map<string, number>): number {
  return resolveTimestampToDay(a, anchors) - resolveTimestampToDay(b, anchors);
}

export function factIdFrom(entity: string, attribute: string): string {
  return `${entity}.${attribute}`;
}
