// ============================================================================
// LogicalDisclosureSummaryCompiler — Hash-pinned disclosure-safe summary
// from planned DiscourseState / scene contract / narrator projection.
//
// Deterministic — no LLM calls, pure compilation.
//
// Safety constraints:
//   Does NOT leak: raw state diffs, n-ary relationship internals,
//   unauthorized Knowledge, thread numeric progress, causal predecessor
//   prose, or ellipsis summaries.
// ============================================================================

import * as crypto from 'node:crypto';
import type { DiscourseContextProjection, DiscourseState } from '../types/discourse.ts';
import type { CompiledSceneContract } from '../types/render-surface.ts';

// ─── Public API ──────────────────────────────────────────────────────────────

export class LogicalDisclosureSummaryCompiler {
  /**
   * Compile a disclosure-safe summary from discourse state, scene contract,
   * and narrator/POV projection.
   *
   * Returns a plain-text summary prefixed with a 12-hex input-hash pin.
   * The hash verifies that the same inputs produce the same summary
   * (cache pinning — not a security seal).
   */
  compile(
    discourseState: DiscourseState,
    contract: CompiledSceneContract,
    projection: DiscourseContextProjection,
  ): string {
    const inputHash = this.computeInputHash(discourseState, contract, projection);

    // ── Safe counts (no raw IDs or propositions) ──────────────────────
    const revealCount = discourseState.reveals.length;
    const claimCount = discourseState.openClaims.length;
    const activeHints = discourseState.hints.filter((h) => h.state !== 'retracted');
    const hintCount = activeHints.length;
    const withholdCount = discourseState.activeWithholds.filter((w) => w.active).length;

    // Narrator type(s) — disclosure-safe (no profile internals)
    const narratorTypes = [
      ...new Set(Object.values(discourseState.narratorProfiles).map((p) => p.type)),
    ];

    // ── Build summary ─────────────────────────────────────────────────
    const lines: string[] = [];

    // Hash pin for cache verification
    lines.push(`[PIN:${inputHash.slice(0, 12)}]`);

    // Scene identity (no raw discourse position number)
    lines.push(`Scene ${contract.sceneId} — ${narratorTypes.join(' / ') || 'unknown'} narration`);

    // Branch name only (disclosure-safe)
    lines.push(`Branch track: ${discourseState.branch}`);

    // Disclosure counts (safe aggregates)
    if (revealCount > 0) {
      lines.push(`Revealed disclosures: ${revealCount}`);
    }
    if (claimCount > 0) {
      lines.push(`Open assertions: ${claimCount}`);
    }
    if (hintCount > 0) {
      lines.push(`Active hints: ${hintCount}`);
    }
    if (withholdCount > 0) {
      lines.push(`Withholding policies: ${withholdCount}`);
    }

    return lines.join('\n');
  }

  /**
   * Deterministic SHA-256 hash of canonical inputs for cache pinning.
   * Does NOT include full DiscourseState (only metadata + IDs) to avoid
   * leaking raw state through the hash itself.
   */
  computeInputHash(
    discourseState: DiscourseState,
    contract: CompiledSceneContract,
    projection: DiscourseContextProjection,
  ): string {
    const canonical = {
      ledgerHash: discourseState.ledgerHash,
      position: discourseState.position,
      branch: discourseState.branch,
      revealCount: discourseState.reveals.length,
      openClaimCount: discourseState.openClaims.length,
      hintCount: discourseState.hints.length,
      contractSceneId: contract.sceneId,
      contractHash: contract.promptContractHash,
      narratorProfileHash: contract.narratorProfileHash,
      plannedDiscourseHash: contract.plannedDiscourseHash,
      projectionRevealCount: projection.plannedReveals.length,
      projectionClaimCount: projection.openClaims.length,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
