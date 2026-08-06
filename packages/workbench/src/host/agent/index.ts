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
  AgentAuditAppendInput,
  AgentAuditListQuery,
  AgentDurableAuditOptions,
} from './durable-audit.js';
export {
  AGENT_AUDIT_MAX_DETAIL_CHARACTERS,
  AGENT_AUDIT_MAX_LIST_LIMIT,
  AgentAuditInputError,
  AgentDurableAudit,
  createAgentDurableAudit,
  createDurableAuditSink,
} from './durable-audit.js';
export type {
  ProjectToolExecutor,
  ProjectToolExecutorPrincipal,
} from './project-tool-executor.js';
export { createProjectToolExecutor } from './project-tool-executor.js';
