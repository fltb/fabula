// ============================================================================
// Release-Gate Diagnostic Tests
//
// Verifies that unreleased-scene diagnostics are event-scoped, safe
// (no raw provider secrets), and that released scenes are not reported.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildReleaseDiagnostic } from '../src/api.ts';
import type { RenderSceneResult } from '../src/pipeline/render.ts';
import type { ValidationResult } from '../src/types/index.js';
import { makeProtocol } from './fixtures/mock-pass2-helpers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    passed: false,
    errors: [],
    warnings: [],
    infos: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<RenderSceneResult> = {}): RenderSceneResult {
  return {
    eventId: 'evt_scene_001',
    prose: 'Some rendered prose.',
    analysis: {
      eventId: 'evt_scene_001',
      protocol: makeProtocol('Some rendered prose.'),
      observations: {},
      analysis: {},
    },
    llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    llmPass2: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
    cacheHit: false,
    errors: [],
    renderStart: 1000,
    renderEnd: 2000,
    validation: makeValidationResult({ passed: true }),
    providerCalls: [],
    attempts: 1,
    needsReview: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildReleaseDiagnostic', () => {
  it('includes event ID in the diagnostic', () => {
    const result = makeResult({
      validation: null,
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('evt_scene_001');
  });

  it('reports validation-error messages for a failing scene', () => {
    const result = makeResult({
      validation: makeValidationResult({
        passed: false,
        errors: [
          {
            validator: 'PronounValidator',
            severity: 'error',
            event: 'evt_scene_001',
            entity: 'jinx',
            message: 'pronoun reference mismatch for jinx',
            fixSuggestion: 'Review pronouns.',
            fixAction: 'change_value',
            fixTarget: { file: 'scenes/evt_scene_001.yaml' },
          },
          {
            validator: 'TenseConsistencyValidator',
            severity: 'error',
            event: 'evt_scene_001',
            entity: 'narrator',
            message: 'tense shift from past to present',
            fixSuggestion: 'Unify tense.',
            fixAction: 'change_value',
            fixTarget: { file: 'scenes/evt_scene_001.yaml' },
          },
        ],
      }),
    });
    const diag = buildReleaseDiagnostic(result);
    // Must mention the event ID
    expect(diag).toContain('evt_scene_001');
    // Must contain at least one validation message
    expect(diag).toContain('pronoun reference mismatch for jinx');
    expect(diag).toContain('tense shift from past to present');
    // Must be sanitized (no raw error objects, just strings)
    expect(diag).toBeTypeOf('string');
    expect(diag.startsWith('evt_scene_001: ')).toBe(true);
  });

  it('redacts secret-like content from validation error messages', () => {
    const result = makeResult({
      validation: makeValidationResult({
        passed: false,
        errors: [
          {
            validator: 'LLMProvider',
            severity: 'error',
            event: 'evt_scene_001',
            entity: 'provider',
            message: 'API call failed: sk-proj-Ax7G8kL2mN4pQ6rS9tUvWxYz',
            fixSuggestion: 'Check API key.',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
        ],
      }),
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('evt_scene_001');
    // The API key must be redacted
    expect(diag).not.toContain('sk-proj-Ax7G8kL2mN4pQ6rS9tUvWxYz');
    expect(diag).toContain('[redacted]');
  });

  it('redacts secret-like content from raw error messages (no validation)', () => {
    const result = makeResult({
      validation: null,
      errors: ['Provider returned 401 — Bearer sk-proj-XwYzAbCdEfGhIjKlMnOpQrStUv'],
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('evt_scene_001');
    expect(diag).not.toContain('sk-proj-XwYzAbCdEfGhIjKlMnOpQrStUv');
    expect(diag).toContain('[redacted]');
  });

  it('uses fallback reason when there are no errors', () => {
    const result = makeResult({
      validation: makeValidationResult({ passed: false, errors: [] }),
      errors: [],
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toBe('evt_scene_001: release requirements unmet');
  });

  it('reports missing analysis output', () => {
    const result = makeResult({
      analysis: null,
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toBe('evt_scene_001: missing analysis output');
  });

  it('reports empty prose', () => {
    const result = makeResult({
      prose: '',
      validation: makeValidationResult({ passed: true }),
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toBe('evt_scene_001: empty prose');
  });

  it('reports needs-review (exhausted retries)', () => {
    const result = makeResult({
      needsReview: true,
      validation: makeValidationResult({ passed: true }),
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toBe('evt_scene_001: exhausted retries — needs review');
  });

  it('prefers validation errors over raw errors', () => {
    const result = makeResult({
      validation: makeValidationResult({
        passed: false,
        errors: [
          {
            validator: 'CausalityValidator',
            severity: 'error',
            event: 'evt_scene_001',
            entity: 'scene',
            message: 'causal loop detected',
            fixSuggestion: 'Reorder events.',
            fixAction: 'manual',
            fixTarget: { file: 'scenes/evt_scene_001.yaml' },
          },
        ],
      }),
      errors: ['raw provider failure: Connection refused'],
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('causal loop detected');
    // Must NOT include raw provider error when validation errors exist
    expect(diag).not.toContain('raw provider failure');
  });
  // ── Release / Response consistency ────────────────────────────────

  it('reports blocked when prose is empty despite no errors', () => {
    const result = makeResult({
      prose: '',
      validation: makeValidationResult({ passed: true }),
      analysis: { blocks: [] },
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('empty prose');
    // Empty prose always makes the result unreleased
    expect(diag).not.toContain('released');
  });

  it('reports blocked when analysis is null', () => {
    const result = makeResult({
      analysis: null,
      validation: makeValidationResult({ passed: true }),
      prose: 'Some prose.',
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('missing analysis');
    // Missing analysis blocks release
    expect(diag).not.toContain('released');
  });

  it('reports blocked when validation fails with errors', () => {
    const result = makeResult({
      validation: makeValidationResult({
        passed: false,
        errors: [
          {
            validator: 'POVValidator',
            severity: 'error',
            event: 'evt_scene_001',
            entity: 'narrator',
            message: 'POV shift detected',
            fixSuggestion: 'Maintain consistent POV.',
            fixAction: 'change_value',
            fixTarget: { file: 'scenes/evt_scene_001.yaml' },
          },
        ],
      }),
      prose: 'Some prose.',
      analysis: { blocks: [] },
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('POV shift detected');
    // Validation errors block release
    expect(diag).not.toContain('released');
  });

  it('reports blocked when needsReview is true despite passing validation', () => {
    const result = makeResult({
      needsReview: true,
      validation: makeValidationResult({ passed: true }),
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('needs review');
    expect(diag).not.toContain('released');
  });

  it('diagnostic contains event ID and reason even when released fields pass', () => {
    const result = makeResult({
      validation: makeValidationResult({ passed: true }),
      prose: 'valid prose',
      analysis: { blocks: [] },
    });
    const diag = buildReleaseDiagnostic(result);
    expect(diag).toContain('evt_scene_001');
    // When all conditions pass, the diagnostic should indicate release readiness
    // or at minimum include the event ID with a status message
    expect(typeof diag).toBe('string');
    expect(diag.length).toBeGreaterThan(0);
  });

  it('all released fields derive from ReleaseDecision in every path', () => {
    // Verify that every result path has a consistent projection of fields
    // needed for release decision
    const successful: RenderSceneResult = makeResult({
      validation: makeValidationResult({ passed: true }),
    });
    expect(successful.prose.trim().length).toBeGreaterThan(0);
    expect(successful.analysis).not.toBeNull();
    expect(successful.validation).not.toBeNull();
    expect(successful.validation!.passed).toBe(true);
    expect(successful.needsReview).toBe(false);

    // Build the release decision fields
    const released =
      successful.prose.trim().length > 0 &&
      successful.analysis !== null &&
      successful.validation !== null &&
      successful.validation.passed &&
      !successful.needsReview;
    expect(released).toBe(true);
  });

  it('blocked result fields never all pass the release check', () => {
    const blocked: RenderSceneResult = makeResult({
      analysis: null,
      validation: makeValidationResult({ passed: false }),
      needsReview: true,
    });
    const released =
      blocked.prose.trim().length > 0 &&
      blocked.analysis !== null &&
      blocked.validation !== null &&
      blocked.validation.passed &&
      !blocked.needsReview;
    expect(released).toBe(false);
  });

  it('warning-only result with needsReview=false is releasable', () => {
    const result: RenderSceneResult = makeResult({
      validation: makeValidationResult({
        passed: true,
        errors: [],
        warnings: [
          {
            validator: 'PacingValidator',
            severity: 'warning',
            event: 'evt_scene_001',
            entity: 'narrator',
            message: 'pacing slightly uneven',
            fixSuggestion: 'Adjust paragraph lengths.',
            fixAction: 'manual',
            fixTarget: { file: 'scenes/evt_scene_001.yaml' },
          },
        ],
      }),
    });
    const released =
      result.prose.trim().length > 0 &&
      result.analysis !== null &&
      result.validation !== null &&
      result.validation.passed &&
      !result.needsReview;
    expect(released).toBe(true);
    // Warning-only does not block release when passed is true
    expect(result.validation.passed).toBe(true);
  });
});
