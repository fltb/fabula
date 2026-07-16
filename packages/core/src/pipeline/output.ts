// ============================================================================
// Output Writer — write render results to PROJECT.md-compliant file layout
// ============================================================================
//
// Each render sits in:
//   scenes/chapter-NN/{eventId}.md                — prose
//   scenes/chapter-NN/{eventId}.yaml               — metadata (prose_source, edit_history)
//   scenes/chapter-NN/{eventId}_render_request.yaml — context package sent to LLM
//   .nova/responses/{eventId}.json                 — full raw LLM response
//   .nova/derived/threads.yaml                     — thread progress tracking
//   .nova/derived/foreshadowing.yaml               — foreshadowing state tracking
//   .nova/derived/relationships.yaml               — relationship evolution tracking
//   .nova/derived/rules.yaml                       — rule evidence chain
// ============================================================================

import type { Storage } from '../storage/index.js';
import type { RenderJob, RenderSceneResult } from './render.js';

export interface OutputEntry {
  eventId: string;
  chapterNumber: number;
  prose: string;
  metadata: Record<string, unknown>;
  renderRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface DerivedData {
  threads: Record<string, unknown>;
  foreshadowing: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}

/**
 * Write render outputs to PROJECT.md-compliant directory layout.
 */
export function writeRenderOutputs(
  st: Storage,
  projectDir: string,
  entries: OutputEntry[],
  derived: DerivedData,
): void {
  const responseDir = [projectDir, '.nova', 'responses'].join('/');
  st.mkdirp(responseDir);

  for (const entry of entries) {
    const chStr = `chapter-${String(entry.chapterNumber).padStart(2, '0')}`;
    const sceneDir = [projectDir, 'scenes', chStr].join('/');
    st.mkdirp(sceneDir);

    // 1. {eventId}.md — pure prose
    st.write([sceneDir, `${entry.eventId}.md`].join('/'), entry.prose);

    // 2. {eventId}.yaml — scene metadata
    st.write(
      [sceneDir, `${entry.eventId}.yaml`].join('/'),
      yamlify(entry.metadata) + '\n',
    );

    // 3. {eventId}_render_request.yaml — what was sent to LLM
    st.write(
      [sceneDir, `${entry.eventId}_render_request.yaml`].join('/'),
      yamlify(entry.renderRequest) + '\n',
    );

    // 4. .nova/responses/{eventId}.json — full raw response
    st.write(
      [responseDir, `${entry.eventId}.json`].join('/'),
      JSON.stringify(entry.rawResponse, null, 2),
    );
  }

  // 5. .nova/derived/ — tracking files
  const derivedDir = [projectDir, '.nova', 'derived'].join('/');
  st.mkdirp(derivedDir);

  st.write([derivedDir, 'threads.yaml'].join('/'), JSON.stringify(derived.threads, null, 2));
  st.write([derivedDir, 'foreshadowing.yaml'].join('/'), JSON.stringify(derived.foreshadowing, null, 2));
  st.write([derivedDir, 'relationships.yaml'].join('/'), JSON.stringify(derived.relationships, null, 2));
  st.write([derivedDir, 'rules.yaml'].join('/'), JSON.stringify(derived.rules, null, 2));
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
  const threads: Record<string, unknown> = {};
  const foreshadowing: Array<Record<string, unknown>> = [];
  const relationships: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    const r = resultMap.get(job.event.id);
    if (!r) continue;

    entries.push({
      eventId: job.event.id,
      chapterNumber: job.chapter,
      prose: r.prose,
      metadata: {
        narrativeOrder: job.event.narrativeOrder,
        event: job.event.id,
        prose_source: r.cacheHit ? 'cache' : 'llm',
        model_used: null,
        rendered_at: new Date(r.renderStart).toISOString(),
        word_count: r.prose.split(/\s+/).filter(Boolean).length,
        edit_history: r.cacheHit ? [] : [{ action: 'llm_generated', timestamp: new Date().toISOString() }],
      },
      renderRequest: {
        eventId: job.event.id,
        chapter: job.chapter,
        sceneBrief: job.event.sceneBrief,
        styleGuidance: job.event.styleGuidance ?? null,
        contextFactCount: job.context?.worldFacts?.length ?? 0,
        contextCharCount: job.context?.characterSnapshots?.length ?? 0,
      },
      rawResponse: {
        prose: r.prose,
        timestamp: new Date().toISOString(),
        cacheHit: r.cacheHit,
        errors: r.errors,
      },
    });
  }

  const derived: DerivedData = { threads, foreshadowing, relationships, rules };

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
