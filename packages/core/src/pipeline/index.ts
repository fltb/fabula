// ============================================================================
// Pipeline barrel
// ============================================================================

export type {
  MissingPredecessorEntry,
  ScheduledWave,
  SurfaceSchedulerError,
  WavePlan,
} from './surface-scheduler.ts';
export { AcceptedArtifactResolver, SurfaceScheduler } from './surface-scheduler.ts';
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
export { evaluateReleaseDecision } from './release-decision.ts';
export type {} from './release-decision.ts';
export type {
  RepairDecision,
  RepairStrategy,
  ReverseValidationResult,
} from './reverse-validate.ts';
