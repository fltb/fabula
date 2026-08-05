// ============================================================================
// Render Output Intents — pure JSON-safe construction of render outputs
// ============================================================================
// Core never writes files: it builds semantic output intents/values that a
// Host serializes and persists. Every emitted payload is JSON-safe — optional
// logical/surface data and render-request records are normalized to explicit
// values (null / JSON-safe projections) with no undefined fields. Derived data
// keeps the shape consumed by editorial publishing and assembly consumers.
// ============================================================================

import type { Message } from '../ai/types.ts';
import { countNarrativeText, NARRATIVE_TEXT_COUNT_VERSION } from '../assembler/count.ts';
import type { JsonValue } from '../contracts/json.ts';
import type { BranchSet, Condition } from '../types/branch.ts';
import type { GameDialogueChoice, RelationshipTransaction } from '../types/index.ts';
import type { RenderJob, RenderRequestRecord, RenderSceneResult } from './render.js';

/** JSON-safe projection of a provider request record for an output intent. */
export interface RenderRequestRecordOutputV1 {
  phase: 'pass1' | 'pass2';
  attempt: number;
  requestHash: string;
  messages: readonly Message[];
  /** Normalized: absent response content becomes explicit null. */
  responseContent: string | null;
}

/** JSON-safe context package sent with a render (Host-persisted artifact). */
export interface RenderRequestOutputV1 {
  eventId: string;
  chapter: number;
  /** Normalized: optional logical disclosure summary becomes explicit null. */
  logicalDisclosureSummary: string | null;
  /** Normalized: optional surface reference packet becomes explicit null. */
  surfaceReferencePacket: JsonValue | null;
  requests: readonly RenderRequestRecordOutputV1[];
}

export interface OutputEntry {
  eventId: string;
  chapterNumber: number;
  prose: string;
  metadata: Record<string, JsonValue>;
  renderRequest?: RenderRequestOutputV1;
}

/**
 * Derived reference data (threads / foreshadowing / relationships / rules).
 * Shape is shared with editorial publishing and assembly consumers; Core emits
 * explicit JSON-safe values without undefined fields.
 */
export interface DerivedData {
  threads: Record<string, unknown>;
  foreshadowing: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}

/** Semantic render output intents produced for Host-side persistence. */
export interface RenderOutputs {
  entries: OutputEntry[];
  derived: DerivedData;
}

/** Convert any runtime value into a JSON-safe value, dropping undefined
 *  object fields and non-JSON primitives. */
function toJsonSafeValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafeValue(item));
  }
  if (typeof value === 'object') {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      object[key] = toJsonSafeValue(item);
    }
    return object;
  }
  return null;
}

/** JSON-safe representation of a branch existence condition (no undefined). */
function branchSetToJsonValue(branchSet: BranchSet): JsonValue {
  switch (branchSet.type) {
    case 'all':
      return { type: 'all' };
    case 'paths':
      return {
        type: 'paths',
        paths: branchSet.paths.map((branchPath) => ({
          decisions: branchPath.decisions.map((decision) => ({
            atEventId: decision.atEventId,
            choiceId: decision.choiceId,
            narrativeOrder: decision.narrativeOrder,
          })),
        })),
      };
    case 'condition':
      return { type: 'condition', condition: conditionToJsonValue(branchSet.condition) };
    case 'except':
      return { type: 'except', branches: branchSetToJsonValue(branchSet.branches) };
  }
}

function conditionToJsonValue(condition: Condition): JsonValue {
  const json: Record<string, JsonValue> = { type: condition.type };
  if (condition.field !== undefined) json.field = condition.field;
  if (condition.value !== undefined) json.value = toJsonSafeValue(condition.value);
  if (condition.conditions !== undefined) {
    json.conditions = condition.conditions.map(conditionToJsonValue);
  }
  return json;
}

function toJsonSafeRenderRequestRecord(record: RenderRequestRecord): RenderRequestRecordOutputV1 {
  return {
    phase: record.phase,
    attempt: record.attempt,
    requestHash: record.requestHash,
    messages: record.messages,
    responseContent: record.responseContent ?? null,
  };
}

function yamlScalar(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

export function appendPlayerChoicesBlock(
  prose: string,
  choices: readonly GameDialogueChoice[],
): string {
  const lines = [
    '<!-- FABULA:PLAYER_CHOICES:v1 -->',
    '```yaml',
    'playerChoices:',
    ...choices.flatMap((choice) => [
      `  - id: ${yamlScalar(choice.id)}`,
      `    label: ${JSON.stringify(choice.label)}`,
      `    description: ${JSON.stringify(choice.description)}`,
      `    targetEvent: ${yamlScalar(choice.targetEvent)}`,
    ]),
    '```',
    '<!-- /FABULA:PLAYER_CHOICES -->',
  ];
  return `${prose.trimEnd()}\n\n${lines.join('\n')}`;
}

/**
 * Collect derived reference data from rendered events.
 * Extracts thread progress, foreshadowing entries, relationship effects,
 * and rule effects from each event that has a corresponding render result.
 * Emits explicit JSON-safe values: absent relationship state is omitted
 * rather than written as an undefined field.
 */
function collectAllReferenceFiles(jobs: RenderJob[], results: RenderSceneResult[]): DerivedData {
  const resultMap = new Map(results.map((r) => [r.eventId, r]));
  const threads: Record<string, unknown> = {};
  const foreshadowing: Array<Record<string, unknown>> = [];
  const relationships: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    if (!resultMap.has(job.event.id)) continue;
    const event = job.event;

    // Thread progress — keyed by thread ID
    for (const tp of event.threadProgress) {
      const goalSet = tp.goalSet ?? [];
      threads[tp.thread] = {
        advancement: tp.advancement ?? '',
        goalAchieved: goalSet.filter((goal) => goal.status === 'achieved').length,
        goalTotal: goalSet.length,
      };
    }

    // Foreshadowing — array of { eventId, hint, targetChapter }
    for (const f of event.foreshadowing) {
      foreshadowing.push({
        eventId: event.id,
        hint: f.hint,
        targetChapter: f.targetRevealChapter,
        thread: f.thread,
      });
    }

    // Relationship effects — derive participants, direction, type, intensity
    for (const re of event.relationshipEffects) {
      if (re.type === 'identity_transition') {
        // Identity transition groups project each established transaction.
        for (const transaction of re.newTransactions) {
          relationships.push(projectRelationshipEntry(transaction));
        }
        continue;
      }
      relationships.push(projectRelationshipEntry(re));
    }

    // Rule effects — each transaction carries the rule as ruleId
    for (const r of event.ruleEffects) {
      rules.push({
        ruleId: r.ruleId,
        operation: r.operation,
        evidence: r.evidence,
        eventId: event.id,
      });
    }
  }

  return { threads, foreshadowing, relationships, rules };
}

/** JSON-safe relationship entry projection for canonical relationship transactions. */
function projectRelationshipEntry(re: RelationshipTransaction): Record<string, unknown> {
  const participants = re.membershipAfter.map((m) => m.entityId);
  const directionDim = re.dimensionSet?.find((d) => d.dimensionId === 'direction');
  const typeDim = re.dimensionSet?.find((d) => d.dimensionId === 'type');
  const intensityDim = re.dimensionSet?.find((d) => d.dimensionId === 'intensity');
  const entry: Record<string, unknown> = {
    participants: participants.length >= 2 ? [participants[0], participants[1]] : [],
    effect: re.lifecycleAfter ?? 'change',
    direction: (directionDim?.value as string) ?? '',
  };
  if (typeDim || intensityDim) {
    entry.newState = {
      type: (typeDim?.value as string) ?? '',
      intensity: (intensityDim?.value as number) ?? 0,
    };
  }
  return entry;
}

/** Build JSON-safe scene metadata for an output entry. */
function buildEntryMetadata(job: RenderJob, result: RenderSceneResult): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = {
    schema_version: 1,
    event: job.event.id,
    narrative_order: job.event.narrativeOrder,
    prose_source: result.cacheHit ? 'cache' : 'llm',
    word_count: countNarrativeText(result.prose, 'zh'),
    text_count_version: NARRATIVE_TEXT_COUNT_VERSION,
    rendered_at: result.renderedAt ?? '',
    edit_history: result.cacheHit
      ? []
      : [{ action: 'llm_generated', timestamp: result.renderedAt ?? '' }],
    branch_existence: branchSetToJsonValue(job.event.branchExistence ?? { type: 'all' }),
  };
  if (job.gameDialogue) {
    metadata.player_choices = job.gameDialogue.choices.map((choice) => toJsonSafeValue(choice));
  }
  return metadata;
}

/**
 * Build pure JSON-safe render output intents from pipeline jobs + results.
 * File writing is owned by the Host; Core returns the semantic entries and
 * derived data for inspection and persistence.
 */
export function buildAndWriteOutputs(
  jobs: RenderJob[],
  results: RenderSceneResult[],
): RenderOutputs {
  const resultMap = new Map(results.map((r) => [r.eventId, r]));

  const entries: OutputEntry[] = [];

  for (const job of jobs) {
    const r = resultMap.get(job.event.id);
    if (!r) continue;

    // Cache hits deliberately carry no request record: old cache metadata
    // cannot be promoted into a fabricated provider request artifact.
    const requestRecords = r.requestRecords.map(toJsonSafeRenderRequestRecord);
    entries.push({
      eventId: job.event.id,
      chapterNumber: job.chapter,
      prose: job.gameDialogue
        ? appendPlayerChoicesBlock(r.prose, job.gameDialogue.choices)
        : r.prose,
      metadata: buildEntryMetadata(job, r),
      renderRequest:
        requestRecords.length > 0
          ? {
              eventId: job.event.id,
              chapter: job.chapter,
              logicalDisclosureSummary: job.logicalDisclosureSummary ?? null,
              surfaceReferencePacket: job.surfaceReferencePacket
                ? toJsonSafeValue(job.surfaceReferencePacket)
                : null,
              requests: requestRecords,
            }
          : undefined,
    });
  }

  const derived = collectAllReferenceFiles(jobs, results);

  return { entries, derived };
}
