// ============================================================================
// Plan 7.4 — Plugin identity flows into validationIdentity / planHash
//
// The EditorialRuntime.pluginHooksManager identities (name/version/
// manifestHash/moduleHash/hook names/validator names) must feed the compile
// input's validation identity, and through it the plan hash and render cache
// key. Two compiles with a different moduleHash MUST differ; identical
// managers MUST be byte-stable; a manager-present compile MUST differ from
// the no-plugin baseline (today's `plugins: []` behavior).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { previewEditorialRun } from '../../src/api.ts';
import { canonicalJson } from '../../src/editorial/identity.ts';
import type { EditorialRuntime } from '../../src/types/editorial.ts';
import { createRuntimeServices, toEditorialRuntime } from '../fixtures/runtime-services.ts';
import { hash, identityHooks, makeManager, source } from './helpers.ts';

const REQUEST = {
  version: 1 as const,
  source: source(),
  selector: { type: 'events' as const, eventIds: ['E1'] },
  model: 'mock-pass2',
};

function runtimeWith(moduleHash: string, base: EditorialRuntime): EditorialRuntime {
  return {
    ...base,
    pluginHooksManager: makeManager(
      identityHooks({ name: 'identity-plugin', moduleHash: hash(moduleHash) }),
    ),
  };
}

describe('plugin identity → validationIdentity/planHash', () => {
  it('same moduleHash is stable; different moduleHash changes validationIdentity and planHash', async () => {
    const base = toEditorialRuntime(createRuntimeServices());
    const withModuleA = runtimeWith('module-a', base);
    const withModuleA2 = runtimeWith('module-a', base);
    const withModuleB = runtimeWith('module-b', base);

    const previewA = await previewEditorialRun(REQUEST, withModuleA);
    const previewA2 = await previewEditorialRun(REQUEST, withModuleA2);
    const previewB = await previewEditorialRun(REQUEST, withModuleB);

    expect(previewA.planHash).toBe(previewA2.planHash);
    expect(previewA.planSummary.validationIdentity).toBe(previewA2.planSummary.validationIdentity);
    expect(previewA.planHash).not.toBe(previewB.planHash);
    expect(previewA.planSummary.validationIdentity).not.toBe(
      previewB.planSummary.validationIdentity,
    );
  });

  it('manifestHash, version, and hook-name changes also shift the identity', async () => {
    const base = toEditorialRuntime(createRuntimeServices());
    const manifestV1 = runtimeWith('module-a', base);
    const manifestV2 = {
      ...base,
      pluginHooksManager: makeManager(
        identityHooks({
          name: 'identity-plugin',
          moduleHash: hash('module-a'),
          manifestHash: hash('manifest-v2'),
        }),
      ),
    };
    const versionBump = {
      ...base,
      pluginHooksManager: makeManager(
        identityHooks({ name: 'identity-plugin', moduleHash: hash('module-a'), version: '2.0.0' }),
      ),
    };
    const extraHook = {
      ...base,
      pluginHooksManager: makeManager({
        ...identityHooks({ name: 'identity-plugin', moduleHash: hash('module-a') }),
        beforeRender: async () => undefined,
      }),
    };

    const previews = await Promise.all([
      previewEditorialRun(REQUEST, manifestV1),
      previewEditorialRun(REQUEST, manifestV2),
      previewEditorialRun(REQUEST, versionBump),
      previewEditorialRun(REQUEST, extraHook),
    ]);
    const [p1, p2, p3, p4] = previews;
    const identity = p1.planSummary.validationIdentity;
    expect(p2.planSummary.validationIdentity).not.toBe(identity);
    expect(p3.planSummary.validationIdentity).not.toBe(identity);
    expect(p4.planSummary.validationIdentity).not.toBe(identity);
    // Every identity shift also shifts the plan hash (plan hash covers
    // per-scene validationIdentity).
    const plan = p1.planHash;
    expect(p2.planHash).not.toBe(plan);
    expect(p3.planHash).not.toBe(plan);
    expect(p4.planHash).not.toBe(plan);
  });

  it('manager-present compile differs from the no-plugin baseline', async () => {
    const base = toEditorialRuntime(createRuntimeServices());
    const withPlugin = runtimeWith('module-a', base);

    const previewNone = await previewEditorialRun(REQUEST, base);
    const previewPlugin = await previewEditorialRun(REQUEST, withPlugin);

    expect(previewNone.planHash).not.toBe(previewPlugin.planHash);
    expect(previewNone.planSummary.validationIdentity).not.toBe(
      previewPlugin.planSummary.validationIdentity,
    );
  });

  it('manager identities feed the pipeline render-cache key input', async () => {
    // RenderPipeline hashes getPluginIdentities() into the cache key; the
    // shape must carry name/version/manifestHash/moduleHash/hook/validator
    // names so any plugin change invalidates cached renders.
    const managerA = makeManager(identityHooks({ name: 'cache-plugin', moduleHash: hash('m1') }));
    const managerA2 = makeManager(identityHooks({ name: 'cache-plugin', moduleHash: hash('m1') }));
    const managerB = makeManager(identityHooks({ name: 'cache-plugin', moduleHash: hash('m2') }));

    const keyA = canonicalJson(managerA.getPluginIdentities());
    const keyA2 = canonicalJson(managerA2.getPluginIdentities());
    const keyB = canonicalJson(managerB.getPluginIdentities());

    expect(keyA).toBe(keyA2);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('cache-plugin');
    expect(keyA).toContain(hash('m1'));
    expect(keyA).toContain(hash('manifest-v1'));
    expect(keyA).toContain('1.0.0');
  });
});
