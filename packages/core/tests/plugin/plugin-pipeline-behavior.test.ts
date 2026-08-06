// ============================================================================
// Plan 7.4 — Plugin validators merge into the pipeline; hook failures behave
// per contract
//
// 1. A plugin validator registered through PluginHooksManager joins the same
//    validation set the pipeline validates with: its error finding appears in
//    the scene validation and blocks release (error-severity is never waived).
// 2. Transform hook (onBuildPass1Prompt) exceptions are hard scene failures:
//    the scene is blocked and the error is recorded.
// 3. Observation hook (beforeRender) failures are record-only: the error is
//    surfaced on the scene result but the release decision is unchanged.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { renderNovel } from '../../src/api.ts';
import type { PluginHooks, Validator } from '../../src/plugin/index.js';
import type { EditorialRuntime } from '../../src/types/editorial.ts';
import type { ValidationIssue } from '../../src/types/validator.ts';
import { createRuntimeServices, toEditorialRuntime } from '../fixtures/runtime-services.ts';
import { analysisEntry, identityHooks, makeInitializedManager, source } from './helpers.ts';

const PROSE = 'A clean scene rendered by the mock provider.';

function renderRequest() {
  return {
    version: 1 as const,
    source: source(),
    selector: { type: 'events' as const, eventIds: ['E1'] },
    mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
    model: 'mock-pass2',
  };
}

async function runtimeWith(managerHooks: PluginHooks): Promise<EditorialRuntime> {
  const provider = new MockPass2Provider({ entries: { E1: analysisEntry(PROSE) } });
  return toEditorialRuntime(createRuntimeServices({ provider }), {
    pluginHooksManager: await makeInitializedManager(managerHooks),
  });
}

function issue(validator: string, message: string): ValidationIssue {
  return {
    validator,
    severity: 'error',
    kind: 'compiler_invariant',
    event: 'E1',
    entity: 'narrator',
    message,
    fixSuggestion: 'adjust the prose',
    fixAction: 'manual',
    fixTarget: { file: 'chapters/chapter_01/E1.yaml' },
  };
}

describe('plugin validator merge into pipeline validation', () => {
  it('a plugin validator finding appears in validation and blocks release', async () => {
    const hooks: PluginHooks = {
      ...identityHooks({ name: 'val-plugin' }),
      registerValidators(registrar) {
        const validator: Validator = {
          name: 'plugin-consistency',
          category: 'prose_quality',
          validatePost: () => [issue('plugin-consistency', 'plugin validator flagged prose')],
        };
        registrar.register(validator);
      },
    };

    const runtime = await runtimeWith(hooks);
    const result = await renderNovel(renderRequest(), runtime);

    expect(result.results).toHaveLength(1);
    const scene = result.results[0];
    expect(scene.validationIssueMessages).toContain('plugin validator flagged prose');
    expect(scene.released).toBe(false);
    expect(scene.disposition).toBe('candidate_blocked');
  });

  it('the same compile without the manager has no plugin validator finding', async () => {
    const provider = new MockPass2Provider({ entries: { E1: analysisEntry(PROSE) } });
    const runtime = toEditorialRuntime(createRuntimeServices({ provider }));
    const result = await renderNovel(renderRequest(), runtime);

    expect(result.results).toHaveLength(1);
    const scene = result.results[0];
    expect(scene.validationIssueMessages).not.toContain('plugin validator flagged prose');
    expect(scene.released).toBe(true);
  });
});

describe('plugin transform hook failures', () => {
  it('onBuildPass1Prompt exception is a hard scene failure (blocked, recorded)', async () => {
    const hooks: PluginHooks = {
      ...identityHooks({ name: 'transform-plugin' }),
      onBuildPass1Prompt: async () => {
        throw new Error('transform hook exploded');
      },
    };
    const runtime = await runtimeWith(hooks);
    const result = await renderNovel(renderRequest(), runtime);

    expect(result.results).toHaveLength(1);
    const scene = result.results[0];
    expect(scene.errors.join('\n')).toContain('Pass 1 decoration hook failed');
    expect(scene.errors.join('\n')).toContain('transform hook exploded');
    expect(scene.released).toBe(false);
  });
});

describe('plugin observation hook failures', () => {
  it('beforeRender failure is recorded but the release decision is unchanged', async () => {
    const hooks: PluginHooks = {
      ...identityHooks({ name: 'observer-plugin' }),
      beforeRender: async () => {
        throw new Error('observation hook exploded');
      },
    };
    const runtime = await runtimeWith(hooks);
    const result = await renderNovel(renderRequest(), runtime);

    expect(result.results).toHaveLength(1);
    const scene = result.results[0];
    expect(scene.errors.join('\n')).toContain('observation hook exploded');
    expect(scene.released).toBe(true);
    expect(scene.disposition).toBe('candidate_promoted');
  });
});
