// ============================================================================
// Pipeline barrel
// ============================================================================

export type {
  ReleaseDecision,
  ReleasePolicy,
  ReleaseWarningPolicy,
} from '../types/render-surface.ts';
export type { InteractionGate, WaiverRecord } from './interaction-gate.ts';
export { InteractionManager } from './interaction-gate.ts';
export { buildAndWriteOutputs } from './output.ts';
export type {
  EvaluateReleaseDecisionOptions,
  ReleaseGateIdentityContext,
} from './release-decision.ts';
export {
  computeReleaseGateId,
  computeWarningFingerprint,
  evaluateReleaseDecision,
} from './release-decision.ts';
export type {
  EvaluateProseCandidateInput,
  EvaluateProseCandidateResult,
  Pass2RejectionCategory,
  ProviderCallLedgerEntry,
  RenderJob,
  RenderPipelineOptions,
  RenderSceneResult,
} from './render.ts';
export {
  evaluateProseCandidate,
  PASS1_PROMPT_TEMPLATE_NAME,
  PASS2_REFERENCE_POLICY_VERSION,
  PASS2_SAMPLING_CONFIG,
  RenderPipeline,
} from './render.ts';
export type {
  RepairDecision,
  RepairStrategy,
  ReverseValidationResult,
} from './reverse-validate.ts';
export type {
  MissingPredecessorEntry,
  ScheduledWave,
  SurfaceSchedulerError,
  WavePlan,
} from './surface-scheduler.ts';
export { AcceptedArtifactResolver, SurfaceScheduler } from './surface-scheduler.ts';
