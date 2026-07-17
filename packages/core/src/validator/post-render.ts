// ============================================================================
// PostRenderValidator — Verify LLM-rendered prose against the source event
// ============================================================================
//
// This is the *core meaning* of the system: after an LLM renders a scene,
// verify the prose actually reflects the event's claims. Catches:
//   - Postconditions not stated (LLM dropped key facts)
//   - Preconditions contradicted (LLM changed a fact it shouldn't have)
//   - POV leaks (3rd-person-limited slipping into omniscient)
//   - Character name typos (Levenshtein against canonical names)
//   - Forbidden / anachronism phrases (optional denylist per scene)
//
// This belongs in core because it's input/output validation — not benchmark
// or measure. Like other Validators, it runs over (prose, event, worldState).
// ============================================================================

import type { NarrativeEvent, WorldState, AnalysisResult } from '../types/index.js';

export interface PostRenderIssue {
  rule: 'postcondition_missing' | 'precondition_contradicted' | 'pov_leak' | 'name_typo' | 'forbidden_phrase';
  severity: 'error' | 'warning' | 'info';
  message: string;
  evidence?: string;
  expected?: string;
  actual?: string;
}

export interface PostRenderResult {
  passed: boolean;
  confidence: number; // 0..1, overall
  issues: PostRenderIssue[];
  coverage: {
    postconditionsStated: number;
    postconditionsTotal: number;
    preconditionsPreserved: number;
    preconditionsTotal: number;
  };
}

// POV leak detection is now handled by POVValidator (dynamic) and
// AnalysisResult.pov.leaks (LLM analysis). This default is kept as
// a fallback for legacy use — it uses no fixture-specific names.
// The canonical approach is to provide canonicalNames via options.
const DEFAULT_POV_LEAK_PATTERNS: Record<string, RegExp[]> = {
  third_person_limited: [],
};

const FORBIDDEN_DEFAULT: RegExp[] = [
  // Things that should NEVER appear in any render (system-level)
  /\[SYSTEM\]/gi,
  /\[USER\]/gi,
  /<\|.*?\|>/g, // chat-template tokens
];

export interface PostRenderValidatorOptions {
  /** Optional denylist of phrases that must not appear in the prose */
  forbiddenPhrases?: RegExp[];
  /** Optional allowlist of patterns per POV type (overrides default) */
  povLeakPatterns?: Record<string, RegExp[]>;
  /** Canonical character names for typo detection. Defaults to extracting from registry. */
  canonicalNames?: string[];
  /** Min confidence to pass (default 0.5) */
  minConfidence?: number;
}

/**
 * Validate rendered prose against the source event.
 *
 * This is invoked AFTER an LLM produces text, to check the text matches the
 * event's claims. Returns a structured result with issues + confidence.
 */
export class PostRenderValidator {
  private readonly options: Required<Omit<PostRenderValidatorOptions, 'forbiddenPhrases' | 'povLeakPatterns' | 'canonicalNames'>> & {
    forbiddenPhrases: RegExp[];
    povLeakPatterns: Record<string, RegExp[]>;
    canonicalNames: string[];
  };

  constructor(options: PostRenderValidatorOptions = {}) {
    this.options = {
      forbiddenPhrases: options.forbiddenPhrases ?? FORBIDDEN_DEFAULT,
      povLeakPatterns: options.povLeakPatterns ?? DEFAULT_POV_LEAK_PATTERNS,
      canonicalNames: options.canonicalNames ?? [],
      minConfidence: options.minConfidence ?? 0.5,
    };
  }

  validate(prose: string, event: NarrativeEvent, _worldState: WorldState): PostRenderResult {
    const issues: PostRenderIssue[] = [];
    const lowerProse = prose.toLowerCase();

    // ── 1. Postcondition coverage ─────────────────────────────────
    let postconditionsStated = 0;
    const postconditionsTotal = event.postconditions.length;
    for (const pc of event.postconditions) {
      const needle = String(pc.value ?? '').toLowerCase();
      if (!needle) continue;

      let found = false;

      // Special case: boolean values like "true" or "false" → check
      // whether the prose mentions the relationship / state in some form
      if (needle === 'true' || needle === 'false') {
        // For met_*, knows_*, saw_* etc., check if both entities are
        // mentioned within 200 chars of each other (suggests a relationship
        // was established)
        const attr = pc.attribute.toLowerCase();
        // Detect "met", "knows", "sees", "saw" etc. by attribute name
        const relationVerbs = ['met', 'knows', 'saw', 'sees', 'recognizes', 'encountered', 'finds', 'found'];
        const verb = relationVerbs.find((v) => attr.includes(v));
        if (verb && pc.entityId) {
          // Look for both entities close together in prose
          const lower = prose.toLowerCase();
          const pos1 = lower.indexOf(pc.entityId.toLowerCase());
          // Other entities to look for: try common forms
          const otherForms = (event.postconditions ?? [])
            .filter((p) => p !== pc && p.entityId !== pc.entityId)
            .map((p) => p.entityId)
            .filter(Boolean);
          for (const other of otherForms) {
            const pos2 = lower.indexOf(other.toLowerCase());
            if (pos1 >= 0 && pos2 >= 0 && Math.abs(pos1 - pos2) < 200) {
              found = true;
              break;
            }
          }
        }
        if (found) {
          postconditionsStated++;
          continue;
        }
        // Fall through to standard token check below
      }

      // Standard: split value into tokens, check if any appear in prose
      const tokens = needle.split(/\W+/).filter((t) => t.length >= 3);
      if (tokens.some((t) => lowerProse.includes(t))) {
        found = true;
      }

      if (found) {
        postconditionsStated++;
      } else {
        issues.push({
          /** @deprecated Use AnalysisResult.postconditions.dropped instead. */
          rule: 'postcondition_missing',
          severity: 'warning',
          message: `Postcondition not stated: ${pc.entityId}.${pc.attribute} = ${pc.value}`,
          expected: `${pc.entityId}.${pc.attribute} = ${pc.value}`,
        });
      }
    }

    // ── 2. Precondition preservation ─────────────────────────────
    let preconditionsPreserved = 0;
    const preconditionsTotal = event.preconditions.length;
    for (const pc of event.preconditions) {
      // If precondition says entity is "alive" and prose says they died, contradict.
      // We use targeted patterns that associate the death word with the entity
      // to avoid false positives like "dead silence" or "dead weight".
      const value = String(pc.value ?? '').toLowerCase();
      const entity = pc.entityId ?? '';
      if (value === 'alive' && entity) {
        // Patterns that genuinely mean the entity died in the prose
        const deathPatterns: RegExp[] = [
          new RegExp(`\\b${entity}\\b[^.]{0,60}\\b(died|was killed|perished)\\b`, 'i'),
          new RegExp(`\\b(died|was killed|perished)\\b[^.]{0,60}\\b${entity}\\b`, 'i'),
          new RegExp(`\\bdead\\s+${entity}\\b`, 'i'),
          new RegExp(`\\b${entity}\\s+(lay|lying)\\s+dead\\b`, 'i'),
          new RegExp(`\\b${entity}'s\\s+corpse\\b`, 'i'),
          new RegExp(`\\b${entity}'s\\s+body\\b`, 'i'),
        ];
        const isDeath = deathPatterns.some((p) => p.test(prose));
        if (isDeath) {
          issues.push({
            /** @deprecated Use AnalysisResult.preconditions.violated instead. */
            rule: 'precondition_contradicted',
            severity: 'error',
            message: `Precondition contradicted: ${entity} is alive but prose says they died`,
            expected: `${entity}.status = alive`,
            actual: 'prose describes their death',
          });
          continue;
        }
      }
      preconditionsPreserved++;
    }

    // ── 3. POV leak ──────────────────────────────────────────────
    const povType = event.pov?.type ?? '';
    const patterns = this.options.povLeakPatterns[povType] ?? [];
    for (const pattern of patterns) {
      const matches = prose.match(pattern);
      if (matches && matches.length > 0) {
        issues.push({
          /** @deprecated Use AnalysisResult.pov.leaks instead. */
          rule: 'pov_leak',
          severity: 'warning',
          message: `POV leak: prose slips into non-POV character's inner thoughts`,
          evidence: matches.slice(0, 3).join(', '),
        });
        break; // one report per scene
      }
    }

    // ── 4. Name typos (Levenshtein) ───────────────────────────────
    if (this.options.canonicalNames.length > 0) {
      // Find all capitalized words in prose that look like character names
      const proseNames = new Set<string>();
      const proseNameRe = /\b[A-Z][a-z]{2,}\b/g;
      let m: RegExpExecArray | null;
      while ((m = proseNameRe.exec(prose)) !== null) {
        proseNames.add(m[0]);
      }
      for (const name of proseNames) {
        // Skip if exact match
        if (this.options.canonicalNames.some((c) => c === name)) continue;
        // Find closest canonical name
        const closest = this.options.canonicalNames
          .map((c) => ({ c, dist: levenshtein(c.toLowerCase(), name.toLowerCase()) }))
          .sort((a, b) => a.dist - b.dist)[0];
        if (closest && closest.dist > 0 && closest.dist <= 2) {
          issues.push({
            rule: 'name_typo',
            severity: 'warning',
            message: `Possible name typo: "${name}" — did you mean "${closest.c}"?`,
            expected: closest.c,
            actual: name,
          });
        }
      }
    }

    // ── 5. Forbidden phrases ─────────────────────────────────────
    for (const pattern of this.options.forbiddenPhrases) {
      const matches = prose.match(pattern);
      if (matches) {
        issues.push({
          rule: 'forbidden_phrase',
          severity: 'error',
          message: `Forbidden phrase in prose: ${matches[0]}`,
          evidence: matches[0],
        });
      }
    }

    // ── Compute confidence ───────────────────────────────────────
    const pcCoverage = postconditionsTotal > 0 ? postconditionsStated / postconditionsTotal : 1;
    const prCoverage = preconditionsTotal > 0 ? preconditionsPreserved / preconditionsTotal : 1;
    const errorPenalty = issues.filter((i) => i.severity === 'error').length * 0.2;
    const warningPenalty = issues.filter((i) => i.severity === 'warning').length * 0.05;
    const confidence = Math.max(0, Math.min(1, (pcCoverage + prCoverage) / 2 - errorPenalty - warningPenalty));

    return {
      passed: confidence >= this.options.minConfidence && issues.filter((i) => i.severity === 'error').length === 0,
      confidence,
      issues,
      coverage: {
        postconditionsStated,
        postconditionsTotal,
        preconditionsPreserved,
        preconditionsTotal,
      },
    };
  }
}

// ============================================================================
// Levenshtein distance — for name typo detection
// ============================================================================
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev.length = 0;
    prev.push(...curr);
  }
  return prev[b.length];
}
