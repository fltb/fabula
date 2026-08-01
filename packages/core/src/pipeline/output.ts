// ============================================================================
// Output Writer — write render results to PROJECT.md-compliant file layout
// ============================================================================
// Each render sits in:
//   scenes/chapter-NN/{eventId}.md                — prose
//   scenes/chapter-NN/{eventId}.yaml               — metadata (prose_source, edit_history)
//   scenes/chapter-NN/{eventId}_render_request.yaml — context package sent to LLM
//   .nova/derived/threads.yaml                     — thread progress tracking
//   .nova/derived/foreshadowing.yaml               — foreshadowing state tracking
//   .nova/derived/relationships.yaml               — relationship evolution tracking
//   .nova/derived/rules.yaml                       — rule evidence chain
// ============================================================================

import * as path from 'node:path';
import YAML from 'yaml';
import { countNarrativeText, NARRATIVE_TEXT_COUNT_VERSION } from '../assembler/count.ts';
import { ProjectTransactionCoordinator, resolveProjectPaths } from '../editorial/index.js';
import { computeFileHash } from '../storage/hash.ts';
import type { Storage } from '../storage/index.js';
import type { StorageWrite } from '../storage/types.ts';
import type { GameDialogueChoice } from '../types/index.ts';
import type { RenderJob, RenderSceneResult } from './render.js';

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
 * Uses ProjectTransactionCoordinator for atomic commits with CAS writes.
 */
function writeRenderOutputs(
  st: Storage,
  projectDir: string,
  entries: OutputEntry[],
  derived: DerivedData,
): void {
  const paths = resolveProjectPaths(projectDir);
  const coordinator = new ProjectTransactionCoordinator(st, paths);

  const writes: StorageWrite[] = [];

  for (const entry of entries) {
    const sceneDir = path.posix.join(
      projectDir,
      'scenes',
      `chapter-${String(entry.chapterNumber).padStart(2, '0')}`,
    );
    const mdPath = path.posix.join(sceneDir, `${entry.eventId}.md`);
    writes.push({
      type: 'put',
      path: mdPath,
      content: entry.prose,
      expectedHash: computeFileHash(st, mdPath),
    });

    const yamlPath = path.posix.join(sceneDir, `${entry.eventId}.yaml`);
    writes.push({
      type: 'put',
      path: yamlPath,
      content: YAML.stringify(entry.metadata, { lineWidth: 120 }) + '\n',
      expectedHash: computeFileHash(st, yamlPath),
    });

    if (entry.renderRequest) {
      const reqPath = path.posix.join(sceneDir, `${entry.eventId}_render_request.yaml`);
      writes.push({
        type: 'put',
        path: reqPath,
        content: YAML.stringify(entry.renderRequest, { lineWidth: 120 }) + '\n',
        expectedHash: computeFileHash(st, reqPath),
      });
    }
  }

  const derivedDir = path.posix.join(projectDir, '.nova', 'derived');
  const derivedFiles = [
    { name: 'threads.yaml', data: derived.threads },
    { name: 'foreshadowing.yaml', data: derived.foreshadowing },
    { name: 'relationships.yaml', data: derived.relationships },
    { name: 'rules.yaml', data: derived.rules },
  ] as const;
  for (const df of derivedFiles) {
    const dfPath = path.posix.join(derivedDir, df.name);
    writes.push({
      type: 'put',
      path: dfPath,
      content: YAML.stringify(df.data, { lineWidth: 120 }),
      expectedHash: computeFileHash(st, dfPath),
    });
  }

  coordinator.commit({ writes });
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
        schema_version: 1,
        event: job.event.id,
        narrative_order: job.event.narrativeOrder,
        prose_source: r.cacheHit ? 'cache' : 'llm',
        word_count: countNarrativeText(r.prose, 'zh'),
        text_count_version: NARRATIVE_TEXT_COUNT_VERSION,
        rendered_at: new Date(r.renderStart).toISOString(),
        edit_history: r.cacheHit
          ? []
          : [{ action: 'llm_generated', timestamp: new Date().toISOString() }],
        branch_existence: job.event.branchExistence ?? { type: 'all' },
        ...(job.gameDialogue ? { player_choices: job.gameDialogue.choices } : {}),
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
