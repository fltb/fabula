// ============================================================================
// Render-policy cross-package drift guard (Stage 1.10)
// ============================================================================
// DEFAULT_WORKBENCH_RENDER_POLICY is the policy the Host persists and serves,
// but core is the ONE source of truth at request time: Pass 2 requests are
// built from PASS2_SAMPLING_CONFIG and `samplingConfigHash` covers it. If the
// protocol copy drifts from core's constants, this test fails loudly.
//
// Pass 1 (temperature 0.8, maxTokens 10000) is intentionally NOT a core
// constant: the defaults are hardcoded in the RenderPipeline constructor
// (packages/core/src/pipeline/render.ts). The protocol policy is the canonical
// surface for them, so only self-consistency is asserted here.
// ============================================================================

import { PASS2_SAMPLING_CONFIG } from '@novalistically/core';
import { DEFAULT_WORKBENCH_RENDER_POLICY } from '@novalistically/workbench-protocol';
import { describe, expect, it } from 'vitest';

describe('DEFAULT_WORKBENCH_RENDER_POLICY vs core sampling defaults', () => {
  it('keeps pass2 in sync with core PASS2_SAMPLING_CONFIG', () => {
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.temperature).toBe(
      PASS2_SAMPLING_CONFIG.temperature,
    );
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.maxTokens).toBe(
      PASS2_SAMPLING_CONFIG.maxTokens,
    );
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass2.seed).toBe(PASS2_SAMPLING_CONFIG.seed);
  });

  it('pins core PASS2_SAMPLING_CONFIG to the agreed values', () => {
    expect(PASS2_SAMPLING_CONFIG.temperature).toBe(0.3);
    expect(PASS2_SAMPLING_CONFIG.maxTokens).toBe(12_000);
    expect(PASS2_SAMPLING_CONFIG.seed).toBe(42);
    // Core Pass 2 always requests JSON output; the protocol policy does not
    // carry responseFormat, so the invariant is pinned here.
    expect(PASS2_SAMPLING_CONFIG.responseFormat.type).toBe('json_object');
  });

  it('keeps pass1 defaults self-consistent at the RenderPipeline-constructor values', () => {
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass1.temperature).toBe(0.8);
    expect(DEFAULT_WORKBENCH_RENDER_POLICY.pass1.maxTokens).toBe(10_000);
  });
});
