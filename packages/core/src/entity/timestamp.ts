import { ConfigError } from '../errors.js';
import { authoredStoryTimeSchema } from '../schemas/timestamp.js';
import type {
  AuthoredStoryTime,
  NarrativeEvent,
  PointStoryCoordinate,
  SceneStoryCoordinate,
  StoryCoordinate,
  StoryTimestamp,
  TemporalOrder,
  TimeAnchor,
  TimeUnit,
} from '../types/index.js';

export const INITIAL_STORY_ROOT_ID = 'system:initial' as const;

const MILLIS_BY_UNIT: Record<TimeUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

const DAY_PATTERN = /^day[_\s]*(-?(?:\d+(?:\.\d+)?|\.\d+))$/i;
const CHAPTER_PATTERN = /^chapter[_\s]*(\d+)$/i;
const RELATIVE_PATTERN = /^(\S+)\s*\+\s*(\d+(?:\.\d+)?|\.\d+)\s*(minute|hour|day|week|month)s?$/i;
const OFFSET_PATTERN = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(minute|hour|day|week|month)s?$/i;
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

export interface TemporalContext {
  coordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>;
  narrationCoordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>;
  coordinatesByAnchorId: ReadonlyMap<string, PointStoryCoordinate>;
}

/** Parse the preserved authored expression without resolving anchors or event references. */
export function parseStoryTimestamp(raw: AuthoredStoryTime | undefined): StoryTimestamp {
  if (raw === undefined) return { type: 'indeterminate', mode: 'unspecified' };
  if (typeof raw === 'string') return parseAuthoredStringTimestamp(raw);

  const parsed = authoredStoryTimeSchema.safeParse(raw);
  if (!parsed.success) {
    throw configError(
      'Invalid authored story timestamp',
      'timestamp',
      parsed.error.issues[0]?.message,
    );
  }

  const authored = parsed.data;
  if (typeof authored === 'string') return parseAuthoredStringTimestamp(authored);
  if ('type' in authored) {
    return {
      type: 'indeterminate',
      mode: 'intentional',
      ...(authored.reason === undefined ? {} : { reason: authored.reason }),
    };
  }
  if ('at' in authored) return parseAuthoredStringTimestamp(authored.at);
  if ('after' in authored) {
    return {
      type: 'relative',
      anchor: authored.after.ref.trim(),
      offset: { amount: authored.after.amount, unit: authored.after.unit },
    };
  }
  if ('offset' in authored) {
    return { type: 'offset', amount: authored.offset.amount, unit: authored.offset.unit };
  }
  return { type: 'chapter', chapter: authored.chapter };
}

function parseAuthoredStringTimestamp(raw: string): StoryTimestamp {
  const value = raw.trim();
  if (!value) throw new ConfigError('Story timestamp must be nonblank', { phase: 'timestamp' });

  const relative = value.match(RELATIVE_PATTERN);
  if (relative) {
    return {
      type: 'relative',
      anchor: relative[1],
      offset: { amount: Number(relative[2]), unit: relative[3].toLowerCase() as TimeUnit },
    };
  }

  const chapter = value.match(CHAPTER_PATTERN);
  if (chapter) return { type: 'chapter', chapter: Number(chapter[1]) };

  const offset = value.match(OFFSET_PATTERN);
  if (offset) {
    return {
      type: 'offset',
      amount: Number(offset[1]),
      unit: offset[2].toLowerCase() as TimeUnit,
    };
  }

  return { type: 'absolute', value };
}

function configError(message: string, path: string, detail?: string): ConfigError {
  return new ConfigError(message, {
    path,
    phase: 'timestamp',
    ...(detail ? { stateKey: detail } : {}),
  });
}

function normalizedScalar(scalar: number, path: string): number {
  if (!Number.isFinite(scalar))
    throw configError(`Timestamp resolves to a non-finite scalar at ${path}`, path);
  return Object.is(scalar, -0) ? 0 : scalar;
}

function point(
  clock: PointStoryCoordinate['clock'],
  scalar: number,
  path: string,
): PointStoryCoordinate {
  return { type: 'storyTime', kind: 'point', clock, scalar: normalizedScalar(scalar, path) };
}

function parseIsoMillis(value: string, path: string): number | null {
  const match = value.match(ISO_PATTERN);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const millis = fractionText === undefined ? 0 : Number(`${fractionText.slice(1).padEnd(3, '0')}`);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw configError(`Invalid ISO timestamp '${value}' at ${path}`, path);
  }

  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(utc);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw configError(`Invalid ISO calendar date '${value}' at ${path}`, path);
  }

  if (zone === undefined || zone === 'Z') return utc;
  const sign = zone[0] === '+' ? 1 : -1;
  const zoneHours = Number(zone.slice(1, 3));
  const zoneMinutes = Number(zone.slice(4, 6));
  if (zoneHours > 23 || zoneMinutes > 59) {
    throw configError(`Invalid ISO offset '${value}' at ${path}`, path);
  }
  return utc - sign * (zoneHours * MILLIS_BY_UNIT.hour + zoneMinutes * MILLIS_BY_UNIT.minute);
}

/**
 * Resolve all authored times into graph-only coordinates. Resolution is deliberately
 * performed over the complete event set before any branch projection.
 */
export function resolveTemporalContext(
  events: readonly Pick<NarrativeEvent, 'id' | 'storyTime' | 'narrationTime'>[],
  anchors: readonly TimeAnchor[],
): TemporalContext {
  const eventById = new Map<string, Pick<NarrativeEvent, 'id' | 'storyTime' | 'narrationTime'>>();
  const anchorById = new Map<string, TimeAnchor>();

  for (const event of events) {
    if (event.id === INITIAL_STORY_ROOT_ID) {
      throw configError(
        `Event id '${INITIAL_STORY_ROOT_ID}' is reserved for the initial story root`,
        `event:${event.id}`,
      );
    }
    if (eventById.has(event.id)) {
      throw configError(`Duplicate event id '${event.id}'`, `event:${event.id}`);
    }
    eventById.set(event.id, event);
  }
  for (const anchor of anchors) {
    if (OFFSET_PATTERN.test(anchor.id)) {
      throw configError(
        `Time anchor id '${anchor.id}' conflicts with bare duration syntax`,
        `anchor:${anchor.id}.at`,
      );
    }
    if (anchorById.has(anchor.id)) {
      throw configError(`Duplicate time anchor id '${anchor.id}'`, `anchor:${anchor.id}.at`);
    }
    if (eventById.has(anchor.id)) {
      throw configError(
        `Event id '${anchor.id}' collides with a time anchor`,
        `anchor:${anchor.id}.at`,
      );
    }
    anchorById.set(anchor.id, anchor);
  }

  const coordinatesByEventId = new Map<string, SceneStoryCoordinate>();
  const narrationCoordinatesByEventId = new Map<string, SceneStoryCoordinate>();
  const coordinatesByAnchorId = new Map<string, PointStoryCoordinate>();
  const resolving: string[] = [];

  const resolveReference = (
    reference: string,
    path: string,
  ): SceneStoryCoordinate | PointStoryCoordinate => {
    const event = eventById.get(reference);
    if (event) return resolveEvent(event.id, path);
    const anchor = anchorById.get(reference);
    if (anchor) return resolveAnchor(anchor.id, path);
    throw configError(`Unknown story-time reference '${reference}' at ${path}`, path);
  };

  const resolveTimestamp = (
    timestamp: StoryTimestamp,
    path: string,
  ): SceneStoryCoordinate | PointStoryCoordinate => {
    switch (timestamp.type) {
      case 'indeterminate':
        return { type: 'storyTime', kind: 'unlocated' };
      case 'offset':
        return point('story', timestamp.amount * MILLIS_BY_UNIT[timestamp.unit], path);
      case 'chapter':
        return point('chapter', timestamp.chapter, path);
      case 'absolute': {
        const day = timestamp.value.match(DAY_PATTERN);
        if (day) return point('story', Number(day[1]) * MILLIS_BY_UNIT.day, path);
        const iso = parseIsoMillis(timestamp.value, path);
        if (iso !== null) return point('calendar', iso, path);
        return resolveReference(timestamp.value, path);
      }
      case 'relative': {
        if (!Number.isFinite(timestamp.offset.amount) || timestamp.offset.amount < 0) {
          throw configError(
            `Relative offset must be a non-negative finite number at ${path}`,
            path,
          );
        }
        const base = resolveReference(timestamp.anchor, path);
        if (base.kind !== 'point' || base.clock === 'chapter') {
          throw configError(
            `Relative offset at ${path} requires a story or calendar point base`,
            path,
            timestamp.anchor,
          );
        }
        return point(
          base.clock,
          base.scalar + timestamp.offset.amount * MILLIS_BY_UNIT[timestamp.offset.unit],
          path,
        );
      }
    }
  };

  const resolveAnchor = (id: string, requestedBy: string): PointStoryCoordinate => {
    const cached = coordinatesByAnchorId.get(id);
    if (cached) return cached;
    const marker = `anchor:${id}`;
    if (resolving.includes(marker)) {
      const cycle = [...resolving.slice(resolving.indexOf(marker)), marker].join(' -> ');
      throw configError(`Cyclic story-time reference: ${cycle}`, requestedBy, cycle);
    }
    const anchor = anchorById.get(id);
    if (!anchor) throw configError(`Unknown time anchor '${id}'`, requestedBy);
    resolving.push(marker);
    const resolved = resolveTimestamp(anchor.at, `anchor:${id}.at`);
    resolving.pop();
    if (resolved.kind !== 'point') {
      throw configError(`Time anchor '${id}' must resolve to a point`, `anchor:${id}.at`);
    }
    coordinatesByAnchorId.set(id, resolved);
    return resolved;
  };

  const resolveEvent = (id: string, requestedBy: string): SceneStoryCoordinate => {
    const cached = coordinatesByEventId.get(id);
    if (cached) return cached;
    const marker = `event:${id}`;
    if (resolving.includes(marker)) {
      const cycle = [...resolving.slice(resolving.indexOf(marker)), marker].join(' -> ');
      throw configError(`Cyclic story-time reference: ${cycle}`, requestedBy, cycle);
    }
    const event = eventById.get(id);
    if (!event) throw configError(`Unknown event '${id}'`, requestedBy);
    resolving.push(marker);
    const resolved = resolveTimestamp(event.storyTime, `event:${id}.storyTime`);
    resolving.pop();
    coordinatesByEventId.set(id, resolved);
    return resolved;
  };

  for (const anchor of anchors) resolveAnchor(anchor.id, `anchor:${anchor.id}.at`);
  for (const event of events) resolveEvent(event.id, `event:${event.id}.storyTime`);
  for (const event of events) {
    if (event.narrationTime !== undefined) {
      narrationCoordinatesByEventId.set(
        event.id,
        resolveTimestamp(
          event.narrationTime,
          `event:${event.id}.narrationTime`,
        ) as SceneStoryCoordinate,
      );
    }
  }

  return { coordinatesByEventId, narrationCoordinatesByEventId, coordinatesByAnchorId };
}

export function compareStoryCoordinates(a: StoryCoordinate, b: StoryCoordinate): TemporalOrder {
  if (a.kind === 'initial') return b.kind === 'initial' ? 'equal' : 'before';
  if (b.kind === 'initial') return 'after';
  if (a.kind === 'unlocated' || b.kind === 'unlocated') return 'incomparable';
  if (a.clock !== b.clock) return 'incomparable';
  if (a.scalar < b.scalar) return 'before';
  if (a.scalar > b.scalar) return 'after';
  return 'equal';
}

export function factIdFrom(entity: string, attribute: string): string {
  return `${entity}.${attribute}`;
}
