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
    analysis: { blocks: [] },
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
});
