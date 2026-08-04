// ============================================================================
// SurfaceReferenceExtractor — Budget-limited excerpt / style packet from
// accepted prose per RENDER-SURFACE-1.
//
// Non-authoritative — explicitly labeled as reference only. YAML always wins.
// Deterministic — pure function of prose + anchor + budget.
// ============================================================================

import { sha256 } from '../cache/pure-sha256.ts';
import type {
  AcceptedSceneArtifact,
  StyleMetrics,
  SurfaceReferencePacket,
} from '../types/render-surface.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const EXTRACTOR_VERSION = 'v1.0';
const DEFAULT_BUDGET = 2000; // characters

// ─── Public API ──────────────────────────────────────────────────────────────

export class SurfaceReferenceExtractor {
  private readonly defaultBudget: number;

  /**
   * @param defaultBudget Max characters for the excerpt (default 2000).
   */
  constructor(defaultBudget = DEFAULT_BUDGET) {
    this.defaultBudget = defaultBudget;
  }

  /**
   * Extract a budget-limited excerpt and style packet from an accepted scene
   * artifact.  Rejects any artifact whose `releaseDecision` is not `'accepted'`.
   *
   * The returned packet is always non-authoritative — YAML contract overrides it.
   *
   * @param artifact  Accepted scene artifact from the release gate.
   * @param authoredAnchor  Optional anchor string to pin the excerpt.
   * @param budget   Override budget in characters (defaults to constructor value).
   * @returns Non-authoritative SurfaceReferencePacket with `accepted: true`.
   * @throws Error if the artifact has not been accepted.
   */
  extract(
    artifact: AcceptedSceneArtifact,
    authoredAnchor?: string,
    budget?: number,
  ): SurfaceReferencePacket {
    if (artifact.releaseDecision.status !== 'accepted') {
      throw new Error(
        `Cannot extract non-accepted source '${artifact.eventId}' (releaseDecision.status='${artifact.releaseDecision.status}')`,
      );
    }

    const prose = artifact.prose;
    const maxBudget = budget ?? this.defaultBudget;
    const sourceHash = sha256(prose);

    // ── Determine excerpt mode and content ────────────────────────────
    let excerptMode: 'tail' | 'full' | 'authored_anchor';
    let excerpt: string;

    if (authoredAnchor) {
      excerptMode = 'authored_anchor';
      const anchorIndex = prose.indexOf(authoredAnchor);
      if (anchorIndex >= 0) {
        excerpt = prose.slice(anchorIndex, anchorIndex + maxBudget);
        // Append truncation marker if the excerpt is shorter than remaining prose
        if (anchorIndex + maxBudget < prose.length) {
          excerpt += '\n[… truncated]';
        }
      } else {
        // Anchor not found — fall back to tail
        excerptMode = 'tail';
        excerpt = prose.length <= maxBudget ? prose : `\u2026${prose.slice(-(maxBudget - 1))}`;
      }
    } else if (prose.length <= maxBudget) {
      excerptMode = 'full';
      excerpt = prose;
    } else {
      excerptMode = 'tail';
      excerpt = `\u2026${prose.slice(-(maxBudget - 1))}`;
    }

    // ── Compute style metrics ─────────────────────────────────────────
    const styleMetrics = this.computeStyleMetrics(prose);

    return {
      sceneId: artifact.eventId,
      excerptMode,
      excerpt,
      styleMetrics,
      authoredAnchor,
      sourceProseHash: sourceHash,
      accepted: true, // source was accepted by the release gate
      extractorVersion: EXTRACTOR_VERSION,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Deterministic style metrics from prose text.
   */
  private computeStyleMetrics(prose: string): StyleMetrics {
    const sentences = prose.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = prose.split(/\s+/).filter((w) => w.length > 0);
    const totalChars = prose.length;

    // Average words per sentence
    const avgSentenceLength =
      sentences.length > 0 ? Math.round((words.length / sentences.length) * 10) / 10 : 0;

    // Simplified reading-level heuristic (Flesch-Kincaid-like)
    const avgSyllablesEstimate = words.length > 0 ? totalChars / words.length : 0;
    const readingLevel =
      sentences.length > 0 && words.length > 0
        ? Math.round(
            (0.39 * (words.length / sentences.length) +
              11.8 * (avgSyllablesEstimate / words.length) -
              15.59) *
              10,
          ) / 10
        : 0;

    // Token count (words)
    const tokenCount = words.length;

    // Lexical diversity — unique / total ratio
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    const lexicalDiversity =
      words.length > 0 ? Math.round((uniqueWords.size / words.length) * 1000) / 1000 : 0;

    // Dialogue ratio — heuristic: content inside paired quote characters
    let dialogueChars = 0;
    let inQuote = false;
    for (const ch of prose) {
      if (ch === '"' || ch === '\u201c' || ch === '\u201e') {
        inQuote = !inQuote;
      } else if (inQuote) {
        dialogueChars++;
      }
    }
    const dialogueRatio =
      totalChars > 0 ? Math.round((dialogueChars / totalChars) * 1000) / 1000 : 0;

    return {
      avgSentenceLength,
      readingLevel: Math.max(0, Math.round(readingLevel * 10) / 10),
      tokenCount,
      lexicalDiversity,
      dialogueRatio,
    };
  }
}
