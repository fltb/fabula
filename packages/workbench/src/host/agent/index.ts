/**
 * Host-only Agent capability boundary: server-side issuance, validation, and
 * revocation of opaque capability tokens, plus typed audit-effect construction
 * for Agent effects. Never imported by the browser client; only the safe grant
 * projection (no token, no digest, no persistence internals) leaves this layer.
 */

export type {
  AgentAuditEffect,
  AgentCapabilityCheckResult,
  AgentCapabilityFailure,
  AgentCapabilityFailureCode,
  AgentCapabilityGrant,
  AgentCapabilityServiceOptions,
  AgentCapabilityValidationResult,
  AuditEffectInput,
  CapabilityPersistence,
  CheckCapabilityInput,
  IssueCapabilityInput,
  ValidateCapabilityInput,
} from './capability-service.js';
export {
  AgentCapabilityService,
  buildAuditEffect,
  CAPABILITY_TOKEN_BYTES,
  CAPABILITY_TOKEN_PREFIX,
  CapabilityInputError,
  createCapabilityPersistence,
  DEFAULT_CAPABILITY_TTL_MS,
} from './capability-service.js';
export type {
  AgentAppliedTicket,
  AgentCommandServiceOptions,
  AgentDocumentPort,
  AgentEditEffectInput,
  AgentEditEffectOutcome,
  AgentEditEffectResult,
  AgentEffectDeniedResult,
  AgentEffectFailedResult,
  AgentPresencePort,
  AgentRevertEffectInput,
  AgentRevertEffectOutcome,
  AgentRevertEffectResult,
} from './edit-service.js';
export {
  AgentCommandService,
  createAgentCommandService,
  MAX_TRACKED_EFFECT_TICKETS,
} from './edit-service.js';
