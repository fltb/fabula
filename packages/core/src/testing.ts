// ============================================================================
// Testing — scoped public entry: in-memory/test adapters.
// Published as `@novalistically/core/testing`.
// ============================================================================

export {
  extractExpectedProtocol,
  type MockPass2Entry,
  type MockPass2Options,
  MockPass2Provider,
  MockProvider,
  type MockProviderOptions,
} from './ai/index.ts';
export { InMemoryEntityRegistry } from './entity/registry.ts';

export {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from './testing/memory-repositories.ts';
