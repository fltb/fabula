// ============================================================================
// Output Writer — write render results to PROJECT.md-compliant file layout
// ============================================================================
//
// Each render sits in:
//   scenes/chapter-NN/{eventId}.md                — prose
//   scenes/chapter-NN/{eventId}.yaml               — metadata (prose_source, edit_history)
//   scenes/chapter-NN/{eventId}_render_request.yaml — context package sent to LLM
//   .nova/derived/threads.yaml                     — thread progress tracking
//   .nova/derived/foreshadowing.yaml               — foreshadowing state tracking
//   .nova/derived/relationships.yaml               — relationship evolution tracking
//   .nova/derived/rules.yaml                       — rule evidence chain
// ============================================================================

import { countNarrativeText, NARRATIVE_TEXT_COUNT_VERSION } from '../assembler/count.ts';
import type { Storage } from '../storage/index.js';
import type { RenderJob, RenderSceneResult } from './render.js';
import type { GameDialogueChoice } from '../types/index.ts';

export interface OutputEntry {
  eventId: string;
  chapterNumber: number;
  prose: string;
  metadata: Record<string, unknown>;
  renderRequest?: Record<string, unknown>;
}

export interface DerivedData {
  threads: Record<string, unknown>;
  foreshadowing: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}

function yamlScalar(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

function appendPlayerChoicesBlock(prose: string, choices: readonly GameDialogueChoice[]): string {
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
      threads[tp.thread] = {
        advancement: tp.advancement,
        progressAfter: tp.progressAfter,
        progressTotal: tp.progressTotal,
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

    // Relationship effects — derive participants, direction, type, intensity from transaction
    for (const re of event.relationshipEffects) {
      const participants = re.membershipAfter.map((m) => m.entityId);
      const directionDim = re.dimensionSet?.find((d) => d.dimensionId === 'direction');
      const typeDim = re.dimensionSet?.find((d) => d.dimensionId === 'type');
      const intensityDim = re.dimensionSet?.find((d) => d.dimensionId === 'intensity');
      relationships.push({
        participants: participants.length >= 2 ? [participants[0], participants[1]] : [],
        effect: re.provenance?.replace('compat:RelationshipChange:', '') ?? 'change',
        direction: (directionDim?.value as string) ?? '',
        newState:
          typeDim || intensityDim
            ? {
                type: (typeDim?.value as string) ?? '',
                intensity: (intensityDim?.value as number) ?? 0,
              }
            : undefined,
      });
    }

    // Rule effects — each entry carries the rule as key
    for (const r of event.ruleEffects) {
      rules.push({
        rule: r.rule,
        effect: r.effect,
        evidence: r.evidence,
        eventId: event.id,
      });
    }
  }

  return { threads, foreshadowing, relationships, rules };
}

/**
 * Write render outputs to PROJECT.md-compliant directory layout.
 */
function writeRenderOutputs(
  st: Storage,
  projectDir: string,
  entries: OutputEntry[],
  derived: DerivedData,
): void {
  const writes: Array<{ path: string; content: string }> = [];

  for (const entry of entries) {
    const sceneDir = [
      projectDir,
      'scenes',
      `chapter-${String(entry.chapterNumber).padStart(2, '0')}`,
    ].join('/');
    writes.push(
      { path: [sceneDir, `${entry.eventId}.md`].join('/'), content: entry.prose },
      {
        path: [sceneDir, `${entry.eventId}.yaml`].join('/'),
        content: `${yamlify(entry.metadata)}\n`,
      },
    );
    if (entry.renderRequest) {
      writes.push({
        path: [sceneDir, `${entry.eventId}_render_request.yaml`].join('/'),
        content: `${yamlify(entry.renderRequest)}\n`,
      });
    }
  }

  const derivedDir = [projectDir, '.nova', 'derived'].join('/');
  writes.push(
    {
      path: [derivedDir, 'threads.yaml'].join('/'),
      content: JSON.stringify(derived.threads, null, 2),
    },
    {
      path: [derivedDir, 'foreshadowing.yaml'].join('/'),
      content: JSON.stringify(derived.foreshadowing, null, 2),
    },
    {
      path: [derivedDir, 'relationships.yaml'].join('/'),
      content: JSON.stringify(derived.relationships, null, 2),
    },
    { path: [derivedDir, 'rules.yaml'].join('/'), content: JSON.stringify(derived.rules, null, 2) },
  );
  st.commitBatch(writes);
}

/**
 * Convenience: build OutputEntry[] + DerivedData from pipeline jobs + results,
 * then write everything. Returns the entries and data (for inspection).
 */
export function buildAndWriteOutputs(
  st: Storage,
  projectDir: string,
  jobs: RenderJob[],
  results: RenderSceneResult[],
): { entries: OutputEntry[]; derived: DerivedData } {
  const resultMap = new Map(results.map((r) => [r.eventId, r]));

  const entries: OutputEntry[] = [];

  for (const job of jobs) {
    const r = resultMap.get(job.event.id);
    if (!r) continue;

    // Cache hits deliberately carry no request record: old cache metadata
    // cannot be promoted into a fabricated provider request artifact.
    entries.push({
      eventId: job.event.id,
      chapterNumber: job.chapter,
      prose: job.gameDialogue
        ? appendPlayerChoicesBlock(r.prose, job.gameDialogue.choices)
        : r.prose,
      metadata: {
        narrativeOrder: job.event.narrativeOrder,
        event: job.event.id,
        prose_source: r.cacheHit ? 'cache' : 'llm',
        word_count: countNarrativeText(r.prose, 'zh'),
        text_count_version: NARRATIVE_TEXT_COUNT_VERSION,
        rendered_at: new Date(r.renderStart).toISOString(),
        edit_history: r.cacheHit
          ? []
          : [{ action: 'llm_generated', timestamp: new Date().toISOString() }],
        branchExistence: job.event.branchExistence ?? { type: 'all' },
        ...(job.gameDialogue ? { playerChoices: job.gameDialogue.choices } : {}),
      },
      renderRequest:
        r.requestRecords.length > 0
          ? {
              eventId: job.event.id,
              chapter: job.chapter,
              logicalDisclosureSummary: job.logicalDisclosureSummary,
              surfaceReferencePacket: job.surfaceReferencePacket,
              requests: r.requestRecords,
            }
          : undefined,
    });
  }

  const derived = collectAllReferenceFiles(jobs, results);

  writeRenderOutputs(st, projectDir, entries, derived);

  return { entries, derived };
}

/** Simple YAML-ish formatting for key-value objects. */
function yamlify(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`${k}: ${val}`);
  }
  return lines.join('\n');
}
