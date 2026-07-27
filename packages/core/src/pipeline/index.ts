// ============================================================================
// Pipeline barrel
// ============================================================================

export type { InteractionGate, WaiverRecord } from './interaction-gate.ts';
export { InteractionManager } from './interaction-gate.ts';
export { buildAndWriteOutputs } from './output.ts';
export type {
  Pass2RejectionCategory,
  ProviderCallLedgerEntry,
  RenderJob,
  RenderPipelineOptions,
  RenderSceneResult,
} from './render.ts';
export { RenderPipeline } from './render.ts';
export type {
  RepairDecision,
  RepairStrategy,
  ReverseValidationResult,
} from './reverse-validate.ts';
