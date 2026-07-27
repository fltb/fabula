// ============================================================================
// Novalistically Bench — Novel Agent SFT Dataset Adapter
// ============================================================================
//
// Novel Agent SFT is a dataset of 40K Chinese novel chapters designed for
// event skeleton generation. Each entry contains:
//   - Chapter-level metadata (title, summary, word count)
//   - Event descriptions with characters involved, location, conflict type
//   - Character appearance lists and location references
//
// Conversion strategy:
//   - Each chapter event → EventFile with direct-mapped fields
//   - Conflict type → mapped to standard English taxonomy
//   - Emotional tone → mapped to standard English labels
//   - Missing fields (preconditions, postconditions, tense, sceneType,
//     discourseMode, resolutionType) marked as unavailable
//
// This adapter primarily tests the RenderPipeline's throughput at converting
// chapter-level narrative data into renderable EventFiles.

import type { EventFile } from '@novalistically/core';
import { annotate, markMixed, type ProvenanceAnnotation } from './annotations.js';

// ─── Raw NovelAgentSFT types ────────────────────────────────────────────────

interface AgentSFTChapter {
  chapter_id: string;
  chapter_index: number;
  title: string;
  summary: string;
  word_count: number;
  events: AgentSFTEvent[];
  characters_appearing: string[];
  locations: string[];
}

interface AgentSFTEvent {
  event_id: string;
  description: string;
  characters_involved: string[];
  location: string;
  conflict_type?: string;
  emotional_tone?: string;
}

// ─── Taxonomy mappings ──────────────────────────────────────────────────────

const CONFLICT_TYPE_MAP: Record<string, string> = {
  人物冲突: 'person_vs_person',
  社会冲突: 'person_vs_society',
  自我冲突: 'person_vs_self',
  命运冲突: 'person_vs_fate',
  自然冲突: 'person_vs_nature',
};

const EMOTIONAL_TONE_MAP: Record<string, string> = {
  悲伤: 'sad',
  愤怒: 'angry',
  喜悦: 'joyful',
  恐惧: 'fearful',
  紧张: 'tense',
  平静: 'calm',
};

function mapConflictType(ct?: string): string {
  return ct ? (CONFLICT_TYPE_MAP[ct] ?? ct) : 'person_vs_self';
}

function mapEmotionalTone(et?: string): string {
  return et ? (EMOTIONAL_TONE_MAP[et] ?? et) : 'neutral';
}

// ─── Conversion functions ───────────────────────────────────────────────────

export function convertAgentSFTEvent(
  raw: AgentSFTEvent,
  chapterIndex: number,
): { data: EventFile; annotation: ProvenanceAnnotation } {
  const fieldOrigins = markMixed(
    ['event', 'narrativeOrder', 'sceneBrief', 'pov', 'storyTime'],
    ['conflictType', 'emotionalValence'],
    [
      'preconditions',
      'expectedPostconditions',
      'tense',
      'sceneType',
      'discourseMode',
      'resolutionType',
      'arcPosition',
      'narrationTime',
      'styleGuidance',
      'threadProgress',
      'foreshadowing',
      'relationshipEffects',
      'introduces',
    ],
  );

  const sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel' = 'linear';
  const discourseMode:
    | 'action'
    | 'dialogue'
    | 'description'
    | 'exposition'
    | 'reflection'
    | 'transition' = 'exposition';

  const data: EventFile = {
    event: raw.event_id,
    title: raw.description.slice(0, 50),
    narrativeOrder: chapterIndex * 10 + parseInt(raw.event_id.replace(/\D/g, '') || '0', 10),
    sceneBrief: raw.description,
    pov: {
      character: raw.characters_involved[0] ?? 'unknown',
      type: 'third_person_limited',
    },
    storyTime: `chapter_${chapterIndex}`,
    conflictType: mapConflictType(raw.conflict_type),
    emotionalValence: mapEmotionalTone(raw.emotional_tone),
    sceneType,
    discourseMode,
    tense: 'past',
    preconditions: [],
    expectedPostconditions: [],
    threadProgress: [],
    relationshipEffects: [],
    introduces: [],
    styleGuidance: {},
  };

  return { data, annotation: annotate('novel_agent_sft', raw.event_id, 'event', fieldOrigins) };
}

export function convertAgentSFTChapter(
  raw: AgentSFTChapter,
): Array<{ data: EventFile; annotation: ProvenanceAnnotation }> {
  return raw.events.map((e) => convertAgentSFTEvent(e, raw.chapter_index));
}

export interface AgentSFTConversionResult {
  chapters: number;
  eventsConverted: number;
  events: Array<{ data: EventFile; annotation: ProvenanceAnnotation }>;
  coverageReport: {
    directFields: number;
    inferredFields: number;
    unavailableFields: number;
  };
}

export function convertAgentSFT(raw: AgentSFTChapter[]): AgentSFTConversionResult {
  const allEvents: Array<{ data: EventFile; annotation: ProvenanceAnnotation }> = [];
  for (const chapter of raw) {
    allEvents.push(...convertAgentSFTChapter(chapter));
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
    chapters: raw.length,
    eventsConverted: allEvents.length,
    events: allEvents,
    coverageReport: { directFields, inferredFields, unavailableFields },
  };
}
