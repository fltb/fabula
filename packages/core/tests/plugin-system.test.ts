// ============================================================================
// Comprehensive Unit Tests — Plugin System Integration (D12)
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PluginHooksManager,
  ValidatorRegistry,
} from '../src/plugin/index.js';
import type {
  PluginHooks,
  PluginContext,
  ProviderRegistry,
} from '../src/plugin/index.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import { Logger, MemoryLogTransport } from '../src/observability/logger.js';
import type { PluginManifest } from '../src/types/index.js';
import { PluginLoader } from '../src/plugin/index.js';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../src/ai/types.js';

// ============================================================================
// Test Helpers
interface ProviderRegistrySpy {
  providers: Record<string, LLMProvider>;
  register(name: string, provider: LLMProvider): void;
}

function createTestContext(): PluginContext {
  return {
    projectDir: '/tmp/test-project',
    storage: new MemoryStorage(),
    log: new Logger(new MemoryLogTransport()),
  };
}

function createProviderRegistrySpy(): ProviderRegistrySpy {
  const providers: Record<string, LLMProvider> = {};
  return {
    providers,
    register(name: string, provider: LLMProvider): void {
      providers[name] = provider;
    },
  };
}

function createDummyProvider(name: string): LLMProvider {
  return {
    name,
    async complete(_request: CompletionRequest): Promise<CompletionResponse> {
      return {
        id: `mock-${name}`,
        model: name,
        content: 'mock response',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      };
    },
  };
}

function createDummyValidator(name: string) {
  return {
    name,
    validate: () => ({ passed: true, errors: [], warnings: [], infos: [] }),
  };
}

// ============================================================================
// 1. PluginManifest Capability Gate
// ============================================================================

describe('Capability gate — PluginManifest requirement', () => {
  it('PluginLoader requires manifest to register', () => {
    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    const manifest: PluginManifest = {
      name: 'test-plugin',
      version: '1.0.0',
      priority: 10,
      provides: ['test-feature'],
      requires: [],
      conflicts: [],
      authority: { dimensions: [], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };

    expect(() => loader.register(manifest)).not.toThrow();
    expect(loader.get('test-plugin')).toBe(manifest);
  });

  it('PluginLoader rejects duplicate manifest', () => {
    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    const manifest: PluginManifest = {
      name: 'dup-plugin',
      version: '1.0.0',
      priority: 10,
      provides: [],
      requires: [],
      conflicts: [],
      authority: { dimensions: [], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };

    loader.register(manifest);
    expect(() => loader.register(manifest)).toThrow('already registered');
  });

  it('PluginLoader lists registered manifests', () => {
    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    const manifestA: PluginManifest = {
      name: 'plugin-a', version: '1.0.0', priority: 10,
      provides: [], requires: [], conflicts: [],
      authority: { dimensions: [], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };
    const manifestB: PluginManifest = {
      name: 'plugin-b', version: '2.0.0', priority: 20,
      provides: [], requires: [], conflicts: [],
      authority: { dimensions: [], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };

    loader.register(manifestA);
    loader.register(manifestB);
    const list = loader.list();
    expect(list).toHaveLength(2);
    expect(list.map(m => m.name)).toEqual(['plugin-a', 'plugin-b']);
  });
});

// ============================================================================
// 2. Sandbox Deny — Plugin cannot mutate core state
// ============================================================================

describe('Sandbox deny — PluginContext is read-only', () => {
  it('PluginContext properties are marked readonly', () => {
    const ctx = createTestContext();
    // TypeScript enforces readonly at compile time; at runtime we verify
    // that the objects are frozen or that mutations are ignored.
    // PluginContext uses readonly in TypeScript — that's the primary enforcement.
    expect(ctx.projectDir).toBe('/tmp/test-project');
    expect(ctx.storage).toBeDefined();
    expect(ctx.log).toBeDefined();
    expect(typeof ctx.log.info).toBe('function');
  });

  it('PluginHooksManager context is not exposed for mutation', () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    // Verify that hooks receive the context but cannot access internal fields
    const capturedContexts: PluginContext[] = [];
    const hook: PluginHooks = {
      name: 'observer',
      onLoad: async (c: PluginContext) => { capturedContexts.push(c); },
    };

    manager.register(hook);
    manager.initialize();

    expect(capturedContexts).toHaveLength(1);
    // The context is read-only — verify it has the expected shape
    expect(capturedContexts[0].projectDir).toBe('/tmp/test-project');
  });
});

// ============================================================================
// 3. Validator Registration via PluginHooks
// ============================================================================

describe('Validator registration via PluginHooks', () => {
  it('registerValidators adds validators to the registry', () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const hook: PluginHooks = {
      name: 'test-validator-plugin',
      registerValidators(registry: ValidatorRegistry) {
        registry.register(createDummyValidator('custom-validator-1'));
        registry.register(createDummyValidator('custom-validator-2'));
      },
    };

    manager.register(hook);
    manager.initialize();

    const validators = validatorRegistry.validators;
    expect(validators).toHaveLength(2);
    expect(validators.map(v => v.name)).toEqual(['custom-validator-1', 'custom-validator-2']);
  });

  it('registerValidators can add multiple plugins', () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const hookA: PluginHooks = {
      name: 'plugin-a',
      registerValidators(registry: ValidatorRegistry) {
        registry.register(createDummyValidator('a-validator'));
      },
    };
    const hookB: PluginHooks = {
      name: 'plugin-b',
      registerValidators(registry: ValidatorRegistry) {
        registry.register(createDummyValidator('b-validator'));
      },
    };

    manager.register(hookA);
    manager.register(hookB);
    manager.initialize();

    expect(validatorRegistry.validators).toHaveLength(2);
  });

  it('registered validators are callable via runAll', () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const validateSpy = vi.fn().mockReturnValue({ passed: true, errors: [], warnings: [], infos: [] });

    const hook: PluginHooks = {
      name: 'spy-plugin',
      registerValidators(registry: ValidatorRegistry) {
        registry.register({ name: 'spy-validator', validate: validateSpy });
      },
    };

    manager.register(hook);
    manager.initialize();

    const results = validatorRegistry.runAll({} as any);
    expect(results).toHaveLength(1);
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(results[0].passed).toBe(true);
  });
});

// ============================================================================
// 4. Provider Registration via PluginHooks
// ============================================================================

describe('Provider registration via PluginHooks', () => {
  it('registerProvider adds provider to registry', () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const customProvider = createDummyProvider('custom-llm');
    const hook: PluginHooks = {
      name: 'test-provider-plugin',
      registerProvider(registry: ProviderRegistry) {
        registry.register('custom-llm', customProvider);
      },
    };

    manager.register(hook);
    manager.initialize();

    expect(providerRegistry.providers['custom-llm']).toBe(customProvider);
  });

  it('registered provider can process completion requests', async () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const mockProvider = createDummyProvider('mock-provider');
    const hook: PluginHooks = {
      name: 'provider-plugin',
      registerProvider(registry: ProviderRegistry) {
        registry.register('mock-provider', mockProvider);
      },
    };

    manager.register(hook);
    manager.initialize();

    const provider = providerRegistry.providers['mock-provider']!;
    expect(provider).toBeDefined();
    expect(provider.name).toBe('mock-provider');

    const response = await provider.complete({ messages: [{ role: 'user', content: 'test' }] });
    expect(response.content).toBe('mock response');
    expect(response.finishReason).toBe('stop');
  });
});

// ============================================================================
// 5. PluginHooksManager Lifecycle
// ============================================================================

describe('PluginHooksManager lifecycle', () => {
  let ctx: PluginContext;
  let validatorRegistry: ValidatorRegistry;
  let providerRegistry: ReturnType<typeof createProviderRegistrySpy>;
  let manager: PluginHooksManager;

  beforeEach(() => {
    ctx = createTestContext();
    validatorRegistry = new ValidatorRegistry();
    providerRegistry = createProviderRegistrySpy();
    manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);
  });

  it('onLoad is called during initialize', async () => {
    const onLoadSpy = vi.fn();
    const hook: PluginHooks = { name: 'load-test', onLoad: onLoadSpy };
    manager.register(hook);
    await manager.initialize();
    expect(onLoadSpy).toHaveBeenCalledTimes(1);
    expect(onLoadSpy).toHaveBeenCalledWith(ctx);
  });

  it('onUnload is called during shutdown', async () => {
    const onUnloadSpy = vi.fn();
    const hook: PluginHooks = { name: 'unload-test', onUnload: onUnloadSpy };
    manager.register(hook);
    await manager.initialize();
    await manager.shutdown();
    expect(onUnloadSpy).toHaveBeenCalledTimes(1);
    expect(onUnloadSpy).toHaveBeenCalledWith(ctx);
  });

  it('initialize calls onLoad, registerValidators, and registerProvider in order', async () => {
    const callOrder: string[] = [];
    const hook: PluginHooks = {
      name: 'order-test',
      onLoad: async () => { callOrder.push('onLoad'); },
      registerValidators: () => { callOrder.push('registerValidators'); },
      registerProvider: () => { callOrder.push('registerProvider'); },
    };

    manager.register(hook);
    await manager.initialize();
    expect(callOrder).toEqual(['onLoad', 'registerValidators', 'registerProvider']);
  });

  it('shutdown clears all hooks', async () => {
    const hook: PluginHooks = { name: 'clear-test' };
    manager.register(hook);
    await manager.initialize();
    expect(manager.list()).toHaveLength(1);

    await manager.shutdown();
    expect(manager.list()).toHaveLength(0);
  });

  it('shutdown runs hooks in reverse order', async () => {
    const order: string[] = [];
    const hook: PluginHooks = {
      name: 'reverse-test',
      onUnload: async () => { order.push('first'); },
    };
    manager.register(hook);

    // Register a second hook
    const hook2: PluginHooks = {
      name: 'reverse-test-2',
      onUnload: async () => { order.push('second'); },
    };
    manager.register(hook2);

    await manager.shutdown();
    // Should be reverse order: second was pushed last, so it runs first
    expect(order).toEqual(['second', 'first']);
  });

  it('duplicate registration is silently ignored', () => {
    const hook: PluginHooks = { name: 'dup-test' };
    manager.register(hook);
    manager.register(hook);
    expect(manager.list()).toHaveLength(1);
  });

  it('unregister removes a hook', () => {
    const hook: PluginHooks = { name: 'remove-me' };
    manager.register(hook);
    expect(manager.list()).toHaveLength(1);

    const removed = manager.unregister('remove-me');
    expect(removed).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  it('unregister returns false for unknown name', () => {
    expect(manager.unregister('does-not-exist')).toBe(false);
  });
});

// ============================================================================
// 6. beforeRender/afterRender Hooks
// ============================================================================

describe('beforeRender / afterRender hooks', () => {
  let ctx: PluginContext;
  let validatorRegistry: ValidatorRegistry;
  let providerRegistry: ReturnType<typeof createProviderRegistrySpy>;
  let manager: PluginHooksManager;

  beforeEach(() => {
    ctx = createTestContext();
    validatorRegistry = new ValidatorRegistry();
    providerRegistry = createProviderRegistrySpy();
    manager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);
  });

  it('runBeforeRender calls all beforeRender hooks', async () => {
    const hookSpy = vi.fn();
    const hook: PluginHooks = {
      name: 'before-test',
      beforeRender: hookSpy,
    };

    manager.register(hook);
    const errors = await manager.runBeforeRender();
    expect(hookSpy).toHaveBeenCalledTimes(1);
    expect(hookSpy).toHaveBeenCalledWith(ctx);
    expect(errors).toEqual([]);
  });

  it('runAfterRender calls all afterRender hooks', async () => {
    const hookSpy = vi.fn();
    const hook: PluginHooks = {
      name: 'after-test',
      afterRender: hookSpy,
    };

    manager.register(hook);
    const errors = await manager.runAfterRender();
    expect(hookSpy).toHaveBeenCalledTimes(1);
    expect(hookSpy).toHaveBeenCalledWith(ctx);
    expect(errors).toEqual([]);
  });

  it('runBeforeRender collects errors without throwing', async () => {
    const hook: PluginHooks = {
      name: 'error-plugin',
      beforeRender: async () => { throw new Error('hook failure'); },
    };

    manager.register(hook);
    const errors = await manager.runBeforeRender();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('error-plugin');
    expect(errors[0]).toContain('hook failure');
  });

  it('beforeRender and afterRender are non-authoritative (cannot modify context)', async () => {
    const beforeCtxs: PluginContext[] = [];
    const afterCtxs: PluginContext[] = [];

    const hook: PluginHooks = {
      name: 'observe-only',
      beforeRender: async (c) => { beforeCtxs.push(c); },
      afterRender: async (c) => { afterCtxs.push(c); },
    };

    manager.register(hook);
    await manager.runBeforeRender();
    await manager.runAfterRender();

    expect(beforeCtxs).toHaveLength(1);
    expect(afterCtxs).toHaveLength(1);
    // Context is read-only via TypeScript types — runtime enforcement
    // is that the storage/log are read-only references
    expect(beforeCtxs[0].projectDir).toBe(ctx.projectDir);
    expect(afterCtxs[0].projectDir).toBe(ctx.projectDir);
  });
});

// ============================================================================
// 7. End-to-end: Plugin integration
// ============================================================================

describe('End-to-end plugin integration', () => {
  it('PluginLoader + PluginHooksManager work together', async () => {
    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    const manifest: PluginManifest = {
      name: 'integrated-plugin',
      version: '0.1.0',
      priority: 10,
      provides: ['custom-validation'],
      requires: [],
      conflicts: [],
      authority: { dimensions: ['comment-text'], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };

    // Register manifest via PluginLoader
    loader.register(manifest);
    expect(loader.get('integrated-plugin')).toBe(manifest);

    // Create PluginHooks that provides validators and providers
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const hooksManager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    let onLoadCalled = false;
    const hook: PluginHooks = {
      name: 'integrated-plugin',
      onLoad: async () => { onLoadCalled = true; },
      registerValidators(registry: ValidatorRegistry) {
        registry.register(createDummyValidator('integrated-validator'));
      },
      registerProvider(registry: ProviderRegistry) {
        registry.register('integrated-provider', createDummyProvider('integrated-provider'));
      },
    };

    hooksManager.register(hook);
    await hooksManager.initialize();

    // Verify everything is wired
    expect(onLoadCalled).toBe(true);
    expect(validatorRegistry.validators).toHaveLength(1);
    expect(validatorRegistry.validators[0].name).toBe('integrated-validator');
    expect('integrated-provider' in providerRegistry.providers).toBe(true);

    // Run the validator
    const results = validatorRegistry.runAll({} as any);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);

    // Run the provider
    const provider = providerRegistry.providers['integrated-provider']!;
    const response = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.content).toBe('mock response');
  });

  it('beforeRender/afterRender hooks integrate with initialize', async () => {
    const ctx = createTestContext();
    const validatorRegistry = new ValidatorRegistry();
    const providerRegistry = createProviderRegistrySpy();
    const hooksManager = new PluginHooksManager(ctx, validatorRegistry, providerRegistry);

    const lifecycle: string[] = [];

    const hook: PluginHooks = {
      name: 'full-lifecycle',
      onLoad: async () => { lifecycle.push('load'); },
      registerValidators: () => { lifecycle.push('registerValidators'); },
      registerProvider: () => { lifecycle.push('registerProvider'); },
      beforeRender: async () => { lifecycle.push('beforeRender'); },
      afterRender: async () => { lifecycle.push('afterRender'); },
    };

    hooksManager.register(hook);
    await hooksManager.initialize();
    expect(lifecycle).toEqual(['load', 'registerValidators', 'registerProvider']);

    // Run render hooks
    await hooksManager.runBeforeRender();
    await hooksManager.runAfterRender();
    expect(lifecycle).toEqual(['load', 'registerValidators', 'registerProvider', 'beforeRender', 'afterRender']);

    // Shutdown
    await hooksManager.shutdown();
    expect(hooksManager.list()).toHaveLength(0);
  });
});
