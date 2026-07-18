// ============================================================================
// Novalistically Bench — Interactive Novels 3K Dataset Adapter
// ============================================================================
//
// Chinese Interactive Novel 3K dataset contains 100K+ chapters for batch
// validator throughput testing. Each chapter includes:
//   - Full text content with word count
//   - Extracted time markers for temporal segmentation
//   - Location change tracking
//   - Character appearance mention counts
//
// Conversion strategy:
//   - If the chapter has time markers → split into one EventFile per marker
//   - If no time markers → single EventFile for the whole chapter
//   - sceneBrief is filled with an approximate slice of content per segment
//   - Character mentions are used to select POV character (most-mentioned)
//   - Missing fields (preconditions, postconditions, conflict type, etc.)
//     are marked as unavailable in provenance
//
// This adapter is designed for testing TimelineValidator at scale — the
// time_markers provide natural temporal boundaries for consistency checks.

import type { EventFile } from '@novalistically/core';
import { annotate, markMixed, type ProvenanceAnnotation } from './annotations.js';

// ─── Raw InteractiveNovels3K types ──────────────────────────────────────────

interface IN3KChapter {
  novel_id: string;
  chapter_id: string;
  chapter_index: number;
  title: string;
  content: string;           // full chapter text
  word_count: number;
  time_markers: string[];    // extracted time references
  location_changes: string[];
  character_appearances: Record<string, number>;  // char_id → mention count
}

interface IN3KNovel {
  novel_id: string;
  title: string;
  author: string;
  genre: string;
  chapters: IN3KChapter[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMostMentionedCharacter(appearances: Record<string, number>): string {
  let best = 'unknown';
  let bestCount = -1;
  for (const [id, count] of Object.entries(appearances)) {
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  return best;
}

function sliceContent(content: string, segmentIndex: number, totalSegments: number): string {
  if (totalSegments <= 1) {
    return content.slice(0, 500);
  }
  const segmentLength = Math.floor(content.length / totalSegments);
  const start = segmentIndex * segmentLength;
  const end = Math.min((segmentIndex + 1) * segmentLength, content.length);
  return content.slice(start, end);
}

// ─── Conversion functions ───────────────────────────────────────────────────

export function convertIN3KChapterToEvents(
  raw: IN3KChapter,
): Array<{ data: EventFile; annotation: ProvenanceAnnotation }> {
  const events: Array<{ data: EventFile; annotation: ProvenanceAnnotation }> = [];
  const povCharacter = getMostMentionedCharacter(raw.character_appearances);

  const unavailableFields: string[] = [
    'preconditions', 'expectedPostconditions', 'tense', 'sceneType',
    'discourseMode', 'conflictType', 'resolutionType', 'arcPosition',
    'narrationTime', 'emotionalValence', 'styleGuidance', 'threadProgress',
    'foreshadowing', 'relationshipEffects', 'introduces',
  ];

  if (raw.time_markers.length === 0) {
    // Single event for the whole chapter
    const fieldOrigins = markMixed(
      ['event', 'narrativeOrder', 'storyTime', 'sceneBrief', 'pov'],
      [],
      unavailableFields,
    );

    const eventId = `ch${raw.chapter_index}_e0`;
    events.push({
      data: {
        event: eventId,
        title: raw.title,
        narrativeOrder: raw.chapter_index * 10,
        sceneBrief: raw.content.slice(0, 500),
        pov: { character: povCharacter, type: 'third_person_limited' },
        storyTime: `chapter_${raw.chapter_index}`,
        preconditions: [],
        expectedPostconditions: [],
        tense: 'past',
        threadProgress: [],
        relationshipEffects: [],
        introduces: [],
        styleGuidance: {},
      },
      annotation: annotate('interactive_novels_3k', eventId, 'event', fieldOrigins),
    });
  } else {
    // One event per time marker
    const totalMarkers = raw.time_markers.length;
    for (let i = 0; i < totalMarkers; i++) {
      const fieldOrigins = markMixed(
        ['event', 'narrativeOrder', 'storyTime', 'pov'],
        ['sceneBrief'],
        unavailableFields,
      );

      const eventId = `ch${raw.chapter_index}_e${i}`;
      events.push({
        data: {
          event: eventId,
          title: `${raw.title} [${raw.time_markers[i]}]`,
          narrativeOrder: raw.chapter_index * 10 + i,
          sceneBrief: sliceContent(raw.content, i, totalMarkers),
          pov: { character: povCharacter, type: 'third_person_limited' },
          storyTime: `ch${raw.chapter_index}_t${i}`,
          preconditions: [],
          expectedPostconditions: [],
          tense: 'past',
          threadProgress: [],
          relationshipEffects: [],
          introduces: [],
          styleGuidance: {},
        },
        annotation: annotate('interactive_novels_3k', eventId, 'event', fieldOrigins),
      });
    }
  }

  return events;
}

export interface IN3KConversionResult {
  novels: number;
  chapters: number;
  eventsConverted: number;
  totalWords: number;
  events: Array<{ data: EventFile; annotation: ProvenanceAnnotation }>;
  coverageReport: {
    directFields: number;
    inferredFields: number;
    unavailableFields: number;
  };
}

export function convertIN3KNovel(raw: IN3KNovel): IN3KConversionResult {
  const allEvents: Array<{ data: EventFile; annotation: ProvenanceAnnotation }> = [];
  let totalWords = 0;

  for (const chapter of raw.chapters) {
    totalWords += chapter.word_count;
    allEvents.push(...convertIN3KChapterToEvents(chapter));
  }

  let directFields = 0;
  let inferredFields = 0;
  let unavailableFields = 0;

  for (const event of allEvents) {
    for (const origin of Object.values(event.annotation.fieldOrigins)) {
      if (origin === 'direct_map') directFields++;
      else if (origin === 'llm_inferred') inferredFields++;
      else if (origin === 'unavailable') unavailableFields++;
    }
  }

  return {
    novels: 1,
    chapters: raw.chapters.length,
    eventsConverted: allEvents.length,
    totalWords,
    events: allEvents,
    coverageReport: { directFields, inferredFields, unavailableFields },
  };
}
