export interface ErrorContext {
  path?: string;
  eventId?: string;
  phase?: string;
  stateKey?: string;
  cycle?: readonly string[];
}

/** A typed operational error whose context is safe to log. */
export class NovalisticallyError extends Error {
  readonly code: string;
  readonly context: Readonly<ErrorContext>;

  constructor(code: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function defineError(name: string, code: string) {
  return class extends NovalisticallyError {
    constructor(message: string, context: ErrorContext = {}) {
      super(code, message, context);
      this.name = name;
    }
  };
}

export class ConfigError extends defineError('ConfigError', 'CONFIG_INVALID') {}
export class StorageError extends defineError('StorageError', 'STORAGE_FAILURE') {}
export class ValidationError extends defineError('ValidationError', 'VALIDATION_FAILED') {}
export class DagProviderError extends defineError('DagProviderError', 'DAG_PROVIDER_INVALID') {}
export class DagCycleError extends defineError('DagCycleError', 'DAG_CYCLE') {}
export class PreconditionMismatchError extends defineError('PreconditionMismatchError', 'PRECONDITION_MISMATCH') {}
export class ReferenceFormatError extends defineError('ReferenceFormatError', 'REFERENCE_FORMAT_INVALID') {}
export class CacheCorruptionError extends defineError('CacheCorruptionError', 'CACHE_CORRUPT') {}
export class PipelineError extends defineError('PipelineError', 'PIPELINE_FAILURE') {}
export class AuthError extends defineError('AuthError', 'PROVIDER_AUTH') {}
export class RateLimitError extends defineError('RateLimitError', 'PROVIDER_RATE_LIMIT') {}
export class TimeoutError extends defineError('TimeoutError', 'PROVIDER_TIMEOUT') {}
export class ModelNotFoundError extends defineError('ModelNotFoundError', 'PROVIDER_MODEL_NOT_FOUND') {}
export class AssemblyIncompleteError extends defineError('AssemblyIncompleteError', 'ASSEMBLY_INCOMPLETE') {}
export class NetworkDeniedError extends defineError('NetworkDeniedError', 'NETWORK_DENIED') {}
export class RuleConstraintViolationError extends defineError('RuleConstraintViolationError', 'RULE_CONSTRAINT_VIOLATION') {}

// ============================================================================
// Safe-error sanitizer — shared by core ledger + bench smoke artifacts
// ============================================================================

/** Maximum characters retained from a sanitized error reason. */
const MAX_REASON_LENGTH = 200;

/**
 * Redact known secret-like patterns from a string.
 *
 * Targets: API keys (sk-*, sk-ant-*, etc.), Bearer tokens, Authorization
 * headers, key/secret/token/password params, Cookie headers, credentials
 * embedded in URLs, and long base64-looking runs.
 */
function redactSecrets(text: string): string {
  // OpenAI / Anthropic / common API key prefixes
  text = text.replace(/\b(sk-[a-zA-Z0-9_-]{10,})\b/g, '[redacted]');
  // Bearer tokens — remove field name and value entirely
  text = text.replace(/\bBearer\s+[^\s,;)]+/gi, '[redacted]');
  // Authorization headers — remove field name and value entirely
  text = text.replace(/Authorization:\s*[^\n\r,;]+/gi, '[redacted]');
  // Query / JSON / env-style secret params (key, secret, token, password, credential)
  text = text.replace(
    /(api[_-]?key|secret|token|password|credential)\s*[=:]\s*[^\s,;)\]]+/gi,
    '[redacted]',
  );
  // Cookie headers — remove field name and value entirely
  text = text.replace(/Cookie:\s*[^\n\r]+/gi, '[redacted]');
  // URLs with embedded user:pass (e.g. https://user:pass@host)
  text = text.replace(/https?:\/\/[^:@\s]+:[^@\s]+@/gi, 'https://[redacted]@');
  // Long base64-looking runs (likely JWTs or encoded secrets)
  text = text.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (match) => {
    // Avoid redacting hex hashes (40-char hex is common for git SHAs)
    if (/^[0-9a-fA-F]{40}$/.test(match)) return match;
    // A run of a single repeating character is unlikely to be a JWT or encoded secret
    if (/^(.)\1{39,}$/.test(match)) return match;
    return '[redacted-base64]';
  });
  return text;
}

/**
 * Convert any error into a safe, bounded reason string suitable for
 * persistent artifacts (provider-call ledgers, smoke records).
 *
 * - Preserves error codes from {@link NovalisticallyError} instances.
 * - Redacts API keys, auth tokens, credentials, cookies, and secrets.
 * - Caps length to {@link MAX_REASON_LENGTH} to prevent prompt/prose leaks.
 * - Never returns the raw message of an unrecognised error unredacted.
 */
export function sanitizeError(err: unknown): string {
  let base: string;

  if (err instanceof NovalisticallyError) {
    base = `[${err.code}] ${err.message}`;
  } else if (err instanceof Error) {
    base = err.message;
  } else if (typeof err === 'string') {
    base = err;
  } else {
    return 'unknown error';
  }

  // Redact any secret-like content that survived into the message
  base = redactSecrets(base);

  // Cap to prevent prompt/prose leakage through long messages
  if (base.length > MAX_REASON_LENGTH) {
    base = base.slice(0, MAX_REASON_LENGTH - 3) + '...';
  }

  return base || 'unknown error';
}
