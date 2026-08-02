// ============================================================================
// Interaction Gate — Test Suite
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import type { InteractionGate, WaiverRecord } from '../src/pipeline/interaction-gate.ts';
import { InteractionManager } from '../src/pipeline/interaction-gate.ts';
import type { Clock } from '../src/ports/runtime-services.ts';

const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const fixedClock: Clock = { now: () => FIXED_NOW };

// ============================================================================
// InteractionManager unit tests
// ============================================================================

describe('InteractionManager', () => {
  describe('needsApproval', () => {
    it('returns false for info severity (no approval needed)', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.needsApproval('test:gate', 'info')).toBe(false);
    });

    it('returns true for error severity (S/X — cannot waive)', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.needsApproval('test:gate', 'error')).toBe(true);
      // Error gates are never waivable
      expect(mgr.hasWaiver('test:gate')).toBe(false);
    });

    it('returns true for warning severity when no waiver exists', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.needsApproval('test:gate', 'warning')).toBe(true);
    });

    it('returns false for warning severity after waiver is recorded', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(true);
      mgr.recordWaiver('gate:E0:validation', 'accepted by author');
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(false);
    });

    it('error severity always returns true even after recordWaiver attempt', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.recordWaiver('gate:E0:fatal', 'tried to waive');
      // Error severity ignores waivers — always needs approval
      expect(mgr.needsApproval('gate:E0:fatal', 'error')).toBe(true);
    });
  });

  describe('recordWaiver', () => {
    it('records a waiver with timestamp and reason', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.recordWaiver('gate:E0:validation', 'minor tone issue, accepted');
      const waiver = mgr.getWaiver('gate:E0:validation');
      expect(waiver).toBeDefined();
      expect(waiver!.gateId).toBe('gate:E0:validation');
      expect(waiver!.reason).toBe('minor tone issue, accepted');
      expect(waiver!.signedBy).toBe('auto');
      // Timestamp comes from the injected clock — deterministic, never wall-clock
      expect(waiver!.signedAt).toBe(FIXED_NOW);
    });

    it('waiver timestamps are deterministic under the injected clock', () => {
      const first = new InteractionManager(fixedClock);
      const second = new InteractionManager(fixedClock);
      first.recordWaiver('gate:E0:validation', 'accepted');
      second.recordWaiver('gate:E0:validation', 'accepted');
      expect(first.getWaiver('gate:E0:validation')!.signedAt).toBe(FIXED_NOW);
      expect(second.getWaiver('gate:E0:validation')!.signedAt).toBe(FIXED_NOW);
      // Same gate + same clock → byte-identical waiver records
      expect(first.getWaiver('gate:E0:validation')).toEqual(
        second.getWaiver('gate:E0:validation'),
      );
    });

    it('honors the timestamp supplied by the injected clock', () => {
      const mgr = new InteractionManager({ now: () => '2026-02-02T02:02:02.000Z' });
      mgr.recordWaiver('gate:E0:validation', 'accepted');
      expect(mgr.getWaiver('gate:E0:validation')!.signedAt).toBe('2026-02-02T02:02:02.000Z');
    });

    it('defaults to a deterministic epoch timestamp without a clock', () => {
      const mgr = new InteractionManager();
      mgr.recordWaiver('gate:E0:validation', 'accepted');
      expect(mgr.getWaiver('gate:E0:validation')!.signedAt).toBe('1970-01-01T00:00:00.000Z');
    });

    it('records a waiver with custom signedBy', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.recordWaiver('gate:E1:validation', 'looks fine', 'author-jane');
      const waiver = mgr.getWaiver('gate:E1:validation');
      expect(waiver).toBeDefined();
      expect(waiver!.signedBy).toBe('author-jane');
    });

    it('hasWaiver returns true after recording', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.hasWaiver('gate:E0:validation')).toBe(false);
      mgr.recordWaiver('gate:E0:validation', 'ok');
      expect(mgr.hasWaiver('gate:E0:validation')).toBe(true);
    });

    it('resolves pending gates for the same ID', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('gate:E0:validation', 'warning');
      expect(mgr.getPendingGates().length).toBe(1);
      mgr.recordWaiver('gate:E0:validation', 'resolved');
      expect(mgr.getPendingGates().length).toBe(0);
    });
  });

  describe('getPendingGates', () => {
    it('returns empty array initially', () => {
      const mgr = new InteractionManager(fixedClock);
      expect(mgr.getPendingGates()).toEqual([]);
    });

    it('returns pending gates after needsApproval for warning', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('gate:E0:validation', 'warning');
      const gates = mgr.getPendingGates();
      expect(gates.length).toBe(1);
      expect(gates[0].condition).toBe('gate:E0:validation');
      expect(gates[0].expectedInput).toBeTruthy();
      expect(gates[0].timeoutMs).toBeGreaterThan(0);
    });

    it('does not create pending gates for info severity', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('test:info', 'info');
      expect(mgr.getPendingGates().length).toBe(0);
    });

    it('does not duplicate pending gates for same condition', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('gate:E0:validation', 'warning');
      mgr.needsApproval('gate:E0:validation', 'warning');
      expect(mgr.getPendingGates().length).toBe(1);
    });

    it('does not create pending gates for error severity', () => {
      // Error severity is always blocking and cannot be waived,
      // so no pending gate is registered
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('gate:E0:fatal', 'error');
      expect(mgr.getPendingGates().length).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears all waivers and gates', () => {
      const mgr = new InteractionManager(fixedClock);
      mgr.needsApproval('gate:E0:validation', 'warning');
      mgr.recordWaiver('gate:E1:validation', 'accepted');
      mgr.reset();
      expect(mgr.getPendingGates()).toEqual([]);
      expect(mgr.hasWaiver('gate:E1:validation')).toBe(false);
    });
  });

  describe('integration — renderNovel waiver flow', () => {
    it('allows warning-only results to be waived via InteractionManager', () => {
      const mgr = new InteractionManager(fixedClock);

      // Simulate: user pre-records a waiver for a known warning issue
      mgr.recordWaiver('gate:E0:validation', 'minor style drift, acceptable');

      // The gate should not need approval since waiver exists
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(false);
      expect(mgr.getPendingGates().length).toBe(0);
    });

    it('blocks warning-only results when no waiver exists', () => {
      const mgr = new InteractionManager(fixedClock);

      // No waiver recorded — gate is pending
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(true);
      expect(mgr.getPendingGates().length).toBe(1);
    });

    it('blocks error-severity results regardless of waivers', () => {
      const mgr = new InteractionManager(fixedClock);

      // Even with a waiver, error severity always blocks
      mgr.recordWaiver('gate:E0:fatal', 'tried to bypass');
      expect(mgr.needsApproval('gate:E0:fatal', 'error')).toBe(true);
    });

    it('waiver can be recorded interactively after gate is created', () => {
      const mgr = new InteractionManager(fixedClock);

      // Gate is initially pending
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(true);
      expect(mgr.getPendingGates().length).toBe(1);

      // User provides waiver interactively
      mgr.recordWaiver('gate:E0:validation', 'author reviewed and accepted', 'author-jane');

      // Now the gate is resolved
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(false);
      expect(mgr.getPendingGates().length).toBe(0);

      // Waiver record is saved
      const waiver = mgr.getWaiver('gate:E0:validation');
      expect(waiver!.signedBy).toBe('author-jane');
      expect(waiver!.reason).toBe('author reviewed and accepted');
    });

    it('multiple independent gates tracked separately', () => {
      const mgr = new InteractionManager(fixedClock);

      // Two events with warning issues — neither waived yet
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(true);
      expect(mgr.needsApproval('gate:E1:validation', 'warning')).toBe(true);
      expect(mgr.getPendingGates().length).toBe(2);

      // Waive one gate
      mgr.recordWaiver('gate:E0:validation', 'accepted');

      // First gate now resolved, second still pending
      expect(mgr.needsApproval('gate:E0:validation', 'warning')).toBe(false);
      expect(mgr.needsApproval('gate:E1:validation', 'warning')).toBe(true);
      expect(mgr.getPendingGates().length).toBe(1);
      expect(mgr.getPendingGates()[0].condition).toBe('gate:E1:validation');
    });
  });
});
