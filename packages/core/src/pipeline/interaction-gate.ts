// ============================================================================
// Interaction Gate — Interactive approval/waiver system for render pipeline
// ============================================================================
//
// Design:
//   The InteractionManager tracks gates that need human approval and records
//   waivers. It is used by renderNovel to decide whether a RenderSceneResult
//   with needsReview=true can be released:
//     - 'error' severity (S/X failures): always needs approval, cannot waive
//     - 'warning' severity (C findings): can be waived via recordWaiver()
//     - 'info' severity: no approval needed
// ============================================================================

import type { Clock } from '../ports/runtime-services.ts';

// Deterministic fallback when the host does not supply a Clock — never wall-clock.
const FALLBACK_CLOCK: Clock = { now: () => '1970-01-01T00:00:00.000Z' };

/**
 * Describes an interaction gate — a point where the pipeline is waiting
 * for human input to proceed.
 */
export interface InteractionGate {
  /** Human-readable description of what needs approval. */
  condition: string;
  /** What the user should provide to resolve (e.g. "waive or fix"). */
  expectedInput: string;
  /** Maximum time (ms) to wait for user input before the gate times out. */
  timeoutMs: number;
}

/**
 * A signed record of a waiver granted for a specific gate.
 */
export interface WaiverRecord {
  /** The gate identifier (matching the condition string). */
  gateId: string;
  /** Who signed the waiver (e.g. username or 'auto'). */
  signedBy: string;
  /** ISO-8601 timestamp when the waiver was recorded. */
  signedAt: string;
  /** Reason the waiver was granted. */
  reason: string;
}

/**
 * Manages interaction gates and waivers for the render pipeline.
 *
 * Typical usage:
 *   const mgr = new InteractionManager();
 *   mgr.recordWaiver('gate:E0:validation', 'accepted by author');
 *   renderNovel({ ..., interactionManager: mgr });
 */
export class InteractionManager {
  private readonly clock: Clock;
  private waivers: Map<string, WaiverRecord> = new Map();
  private gates: Map<string, InteractionGate> = new Map();

  /**
   * @param clock - explicit time source for waiver records; defaults to a
   *                deterministic epoch clock so records stay reproducible
   */
  constructor(clock?: Clock) {
    this.clock = clock ?? FALLBACK_CLOCK;
  }
  /**
   * Check whether a condition needs human approval.
   *
   * @param condition - gate identifier (e.g. 'gate:E0:validation')
   * @param severity  - severity level
   * @returns true if the condition needs approval (gate is blocking or pending)
   */
  needsApproval(condition: string, severity: 'error' | 'warning' | 'info'): boolean {
    // 'info' severity never needs approval
    if (severity === 'info') return false;

    // 'error' severity always needs approval — cannot waive
    if (severity === 'error') return true;

    // 'warning' severity: check if a waiver already exists
    if (this.waivers.has(condition)) return false;

    // Register a pending gate if one doesn't exist yet
    if (!this.gates.has(condition)) {
      this.gates.set(condition, {
        condition,
        expectedInput: 'sign waiver to accept warning-level issues, or fix and re-render',
        timeoutMs: 30000,
      });
    }

    return true;
  }

  /**
   * Record a waiver for a gate. Once recorded, needsApproval() returns false
   * for the same condition with 'warning' severity.
   *
   * @param gateId - the gate identifier (condition string used in needsApproval)
   * @param reason - why the waiver was granted
   * @param signedBy - optional name of the person waiving (defaults to 'auto')
   */
  recordWaiver(gateId: string, reason: string, signedBy?: string): void {
    const record: WaiverRecord = {
      gateId,
      signedBy: signedBy ?? 'auto',
      signedAt: this.clock.now(),
      reason,
    };
    this.waivers.set(gateId, record);
    this.gates.delete(gateId);
  }

  /**
   * Return all currently pending (unresolved) interaction gates.
   */
  getPendingGates(): InteractionGate[] {
    return Array.from(this.gates.values());
  }

  /**
   * Check whether a specific gate has a recorded waiver.
   */
  hasWaiver(gateId: string): boolean {
    return this.waivers.has(gateId);
  }

  /**
   * Get the waiver record for a specific gate, if one exists.
   */
  getWaiver(gateId: string): WaiverRecord | undefined {
    return this.waivers.get(gateId);
  }

  /**
   * Reset all gates and waivers.
   */
  reset(): void {
    this.waivers.clear();
    this.gates.clear();
  }
}
