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
export type {
  AgentSuggestionApplyInput,
  AgentSuggestionChangeV1,
  AgentSuggestionInput,
  AgentSuggestionPromptPort,
  AgentSuggestionResult,
  AgentSuggestionServiceOptions,
  AgentSuggestionV1,
  AgentTextSelectionV1,
  DefaultSuggestionPromptOptions,
} from './suggestion-service.js';
export {
  AGENT_SUGGESTION_CONTRACT_VERSION,
  AGENT_SUGGESTION_DEFAULT_TEMPERATURE,
  AGENT_SUGGESTION_MAX_CHANGE_TEXT_CHARACTERS,
  AGENT_SUGGESTION_MAX_CHANGES,
  AGENT_SUGGESTION_MAX_DOCUMENT_CHARACTERS,
  AGENT_SUGGESTION_MAX_INSTRUCTION_CHARACTERS,
  AgentSuggestionInputError,
  AgentSuggestionService,
  createAgentSuggestionService,
  createDefaultSuggestionPrompt,
  parseSuggestionChanges,
  suggestionHashOf,
  validateSuggestionChanges,
} from './suggestion-service.js';
export type {
  AgentTaskProvider,
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskServiceOptions,
} from './task-service.js';
export {
  AGENT_TASK_MAX_OUTPUT_CHARACTERS,
  AGENT_TASK_MAX_PROMPT_CHARACTERS,
  AGENT_TASK_MAX_TEMPERATURE,
  AGENT_TASK_MIN_TEMPERATURE,
  AgentTaskInputError,
  AgentTaskService,
  errorCodeOf,
  errorMessageOf,
} from './task-service.js';
