// ============================================================================
// Pipeline barrel
// ============================================================================

export { ConcurrencyPool } from '../util/pool.ts';
export { RenderPipeline } from './render.ts';
export type { RenderJob, RenderSceneResult, RenderPipelineOptions } from './render.ts';
export {
  writeRenderOutputs,
  buildAndWriteOutputs,
  type OutputEntry,
  type DerivedData,
} from './output.ts';
export { createCircuitBreaker } from './circuit-breaker.ts';
export type { CircuitBreakerState, CircuitBreakerConfig } from './circuit-breaker.ts';
export { analyzeValidationErrors, buildRepairGuidance, decideRepairStrategy, degradeStrategy } from './reverse-validate.ts';
export type { ReverseValidationResult, RepairStrategy, RepairDecision } from './reverse-validate.ts';
