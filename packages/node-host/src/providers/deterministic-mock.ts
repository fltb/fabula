// ============================================================================
// AI Provider — Deterministic Mock Provider (Host composition path)
// ============================================================================
//
// Offline/dev provider for the composed Host (`WORKBENCH_PROVIDER=mock`).
// Unlike the bare shared `MockProvider`, it is Pass-2 aware:
//
//   - Pass 2 (analysis) requests resolve a per-event entry keyed by the
//     eventId extracted from the request. Entries come from injected
//     reference dirs (`<eventId>.json` fixtures, e.g. a project's
//     `reference/data/` directory) with in-order lookup across dirs; the
//     first entry found wins. When NO entry exists, a schema-valid analysis
//     envelope is GENERATED for that eventId (the pipeline's Pass-2 parser
//     validates it), so multi-event fixtures never block on a missing
//     reference.
//   - Pass 1 (prose) / summary requests return deterministic non-empty
//     prose keyed by the same eventId, so the evidence quotes embedded in
//     the analysis are always exact substrings of the prose the pipeline
//     actually rendered (the Pass-2 parser enforces that).
//   - Like the pure in-memory mocks, a compliant model echoes the REAL
//     measurement protocol embedded in the request, so the fail-closed
//     protocol comparison succeeds under whatever protocol is active.
//
// The generated fallback mirrors the deterministic envelope proven in the
// parity matrix (packages/workbench/tests/agent-parity-matrix.test.ts,
// `makeAnalysisJson`): every active analysis field produced with an exact
// prose quote, and the conflict measurement abstained (the deterministic
// warning the accept-and-record release policy records). Reference-dir
// entries take precedence and carry the real per-event analysis.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from '@novalistically/core';
import { type MockPass2Entry, MockPass2Provider } from '@novalistically/core/testing';

export interface DeterministicMockProviderOptions {
  /**
   * Directories containing `<eventId>.json` deterministic reference entries,
   * consulted in order (first entry found for an eventId wins). Missing
   * directories and malformed/non-fixture JSON files are skipped — an event
   * without an entry falls back to the generated schema-valid envelope.
   */
  readonly referenceDirs?: readonly string[];
  /** Extra entries keyed by eventId; override reference-dir entries. */
  readonly entries?: Record<string, MockPass2Entry>;
  /** Simulated latency per call, ms (default 0). */
  readonly latencyMs?: number;
}

/**
 * Deterministic, Pass-2-aware mock provider for offline Host composition.
 * One instance is built per project session with that project's reference
 * dir(s), so no two sessions share a provider instance.
 */
export class DeterministicMockProvider implements LLMProvider {
  readonly name = 'deterministic-mock';
  private readonly entries: Map<string, MockPass2Entry>;
  private readonly latencyMs: number;

  constructor(options: DeterministicMockProviderOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}));
    for (const dir of options.referenceDirs ?? []) {
      for (const [eventId, entry] of Object.entries(loadReferenceDirEntries(dir))) {
        if (!this.entries.has(eventId)) this.entries.set(eventId, entry);
      }
    }
    this.latencyMs = options.latencyMs ?? 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.latencyMs > 0) {
      const { promise, resolve: resolveDelay } = Promise.withResolvers<void>();
      setTimeout(resolveDelay, this.latencyMs);
      await promise;
    }

    const isPass2 = MockPass2Provider.isPass2Request(request);
    const eventId = extractEventId(request);
    const entry = this.entries.get(eventId);

    let content: string;
    if (isPass2) {
      // A compliant model echoes the REAL protocol from the prompt. Substitute
      // it into the canned/generated analysis so fail-closed protocol
      // comparison succeeds under whatever protocol is currently active.
      const echoed = extractExpectedProtocol(request.messages);
      const analysis = entry ? entry.analysis : generateAnalysis(eventId, proseFor(eventId));
      content = echoed
        ? JSON.stringify({ ...analysis, protocol: echoed })
        : JSON.stringify(analysis);
    } else {
      content = entry ? entry.prose : proseFor(eventId);
    }

    const estimatedTokens = Math.ceil(content.length / 4);
    return {
      id: `deterministic-mock-${eventId}-${isPass2 ? 'analysis' : 'prose'}`,
      model: 'deterministic-mock',
      content,
      usage: {
        promptTokens: request.messages.reduce(
          (acc: number, m: Message) => acc + Math.ceil(m.content.length / 4),
          0,
        ),
        completionTokens: estimatedTokens,
        totalTokens: 0,
      },
      finishReason: 'stop',
    };
  }
}

/**
 * Build a deterministic mock provider for one project session.
 * `referenceDirs` are consulted in order; an event without a reference entry
 * still gets a schema-valid generated analysis, so renders never block on a
 * missing fixture.
 */
export function createDeterministicMockProvider(
  options: DeterministicMockProviderOptions = {},
): DeterministicMockProvider {
  return new DeterministicMockProvider(options);
}

// ── Reference-dir loading (tolerant: skip missing dirs and non-fixtures) ────

function loadReferenceDirEntries(referenceDir: string): Record<string, MockPass2Entry> {
  const root = resolve(referenceDir);
  let files: string[];
  try {
    files = readdirSync(root).filter((entry) => entry.endsWith('.json'));
  } catch {
    return {}; // missing dir → generated fallback only
  }
  const entries: Record<string, MockPass2Entry> = {};
  for (const file of files.sort()) {
    const eventId = basename(file, '.json');
    const filePath = join(root, file);
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (
        typeof value === 'object' &&
        value !== null &&
        'prose' in value &&
        typeof value.prose === 'string' &&
        value.prose.length > 0 &&
        'analysis' in value &&
        value.analysis !== null
      ) {
        entries[eventId] = value as MockPass2Entry;
      }
    } catch {
      // Malformed fixture: skip; the event falls back to generation.
    }
  }
  return entries;
}

// ── Deterministic per-event prose ────────────────────────────────────────────

/**
 * Stable non-empty scene prose for an event. Pass 1 returns exactly this
 * text, and the generated Pass 2 analysis quotes substrings of it, so the
 * pipeline's exact-quote evidence validation always passes.
 */
function proseFor(eventId: string): string {
  return (
    `The morning light filtered through the tall windows as the narrator arrived at the edge of ` +
    `event ${eventId}. Footsteps echoed on the quiet cobblestones while the town held its breath ` +
    `in the cold air, and every detail of the scene unfolded exactly as the story required.`
  );
}

// ── Generated schema-valid analysis envelope ─────────────────────────────────

/**
 * Generated fallback analysis for an event WITHOUT a reference entry.
 * Mirrors the parity-matrix envelope: every active analysis field produced
 * with an exact prose quote, conflict measurement abstained (the
 * deterministic warning the accept-and-record release policy records).
 * `eventId` is the extracted request id, never a hardcoded value.
 */
function generateAnalysis(
  eventId: string,
  prose: string,
): {
  eventId: string;
  observations: Record<string, unknown>;
  analysis: Record<string, unknown>;
} {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 4,
      maxScore: 5,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 60,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
  };
  // One `produced` observation per analysis field with an exact prose quote.
  const quote = prose.trim().slice(0, 24);
  const observations: Record<string, unknown> = {};
  for (const field of Object.keys(payload)) {
    observations[field] = { disposition: 'produced', evidence: [quote] };
  }
  // The deterministic warning the accept-and-record release policy records:
  // the conflict measurement abstains (analysis_uncertainty, severity warning).
  observations.conflictAnalysis = {
    disposition: 'abstained',
    reason: 'prose does not reveal a clear conflict',
    evidence: [],
  };
  return { eventId, observations, analysis: payload };
}

// ── EventId extraction (mirrors core MockPass2Provider) ──────────────────────

/**
 * Extract the event identifier from the request messages. Mirrors
 * `MockPass2Provider.extractEventId` exactly (deterministic search order):
 *   1. `"eventId": "..."` in any message (Pass 2 templates and the Pass 1
 *      context package both carry it)
 *   2. `"id": "..."` near scene-related fields
 *   3. A hash of the last user message as a fallback label
 */
function extractEventId(request: CompletionRequest): string {
  const allText = request.messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content))
        return (m.content as Array<{ type: string; text?: string }>)
          .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('');
      return '';
    })
    .join('\n');

  const eventIdMatch = allText.match(/"eventId"\s*:\s*"([^"]+)"/);
  if (eventIdMatch) return eventIdMatch[1];

  const idMatch = allText.match(/"id"\s*:\s*"([^"]+)"/);
  if (idMatch) return idMatch[1];

  const lastUser = [...request.messages].reverse().find((m: Message) => m.role === 'user');
  if (lastUser) {
    const hash = simpleHash(lastUser.content);
    return `msg-${hash}`;
  }
  return 'unknown';
}

/** Simple string hash for fallback id extraction. */
function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

// ── Measurement-protocol echo (mirrors core extractExpectedProtocol) ─────────

/**
 * Extract the expected protocol object the prompt instructed the model to
 * echo, from the "## Measurement Protocol" block embedded by
 * `buildAnalysisPrompt()`. Mirrors core's `extractExpectedProtocol` exactly
 * (the core runtime bundle does not re-export it through the package
 * boundary, so the Host mirror keeps it in sync). Returns null when no
 * block is present.
 */
function extractExpectedProtocol(messages: readonly Message[]): Record<string, unknown> | null {
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    const match = message.content.match(
      /#{2,3}\s+Measurement Protocol[\s\S]*?```(?:json)?\s*(\{[\s\S]*?\})\s*```/i,
    );
    if (match) {
      try {
        return JSON.parse(match[1]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}
