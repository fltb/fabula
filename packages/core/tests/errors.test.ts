import { describe, expect, it } from 'vitest';
import {
  NovalisticallyError,
  ConfigError,
  StorageError,
  ValidationError,
  DagProviderError,
  DagCycleError,
  PreconditionMismatchError,
  ReferenceFormatError,
  CacheCorruptionError,
  PipelineError,
  AuthError,
  RateLimitError,
  TimeoutError,
  ModelNotFoundError,
  AssemblyIncompleteError,
  NetworkDeniedError,
  RuleConstraintViolationError,
  sanitizeError,
} from '../src/errors.ts';
import { getRetryStrategy } from '../src/pipeline/circuit-breaker.ts';

// ——— Hierarchy ———

describe('error class hierarchy', () => {
  const allErrorClasses = [
    { Class: ConfigError, code: 'CONFIG_INVALID' },
    { Class: StorageError, code: 'STORAGE_FAILURE' },
    { Class: ValidationError, code: 'VALIDATION_FAILED' },
    { Class: DagProviderError, code: 'DAG_PROVIDER_INVALID' },
    { Class: DagCycleError, code: 'DAG_CYCLE' },
    { Class: PreconditionMismatchError, code: 'PRECONDITION_MISMATCH' },
    { Class: ReferenceFormatError, code: 'REFERENCE_FORMAT_INVALID' },
    { Class: CacheCorruptionError, code: 'CACHE_CORRUPT' },
    { Class: PipelineError, code: 'PIPELINE_FAILURE' },
    { Class: AuthError, code: 'PROVIDER_AUTH' },
    { Class: RateLimitError, code: 'PROVIDER_RATE_LIMIT' },
    { Class: TimeoutError, code: 'PROVIDER_TIMEOUT' },
    { Class: ModelNotFoundError, code: 'PROVIDER_MODEL_NOT_FOUND' },
    { Class: AssemblyIncompleteError, code: 'ASSEMBLY_INCOMPLETE' },
    { Class: NetworkDeniedError, code: 'NETWORK_DENIED' },
    { Class: RuleConstraintViolationError, code: 'RULE_CONSTRAINT_VIOLATION' },
  ] as const;

  it.each(allErrorClasses)('$Class is instanceof Error and NovalisticallyError', ({ Class }) => {
    const instance = new Class('test message');
    expect(instance).toBeInstanceOf(Error);
    expect(instance).toBeInstanceOf(NovalisticallyError);
  });

  it.each(allErrorClasses)('$Class has correct code "$code"', ({ Class, code }) => {
    const instance = new Class('test message');
    expect(instance.code).toBe(code);
  });

  it.each(allErrorClasses)('$Class preserves message and name', ({ Class }) => {
    const instance = new Class('something went wrong');
    expect(instance.message).toBe('something went wrong');
    expect(instance.name).toBe(Class.name);
  });

  it('context is frozen', () => {
    const ctx = { path: '/tmp', eventId: 'E1' };
    const err = new ConfigError('bad config', ctx);
    expect(err.context).toEqual(ctx);
    expect(Object.isFrozen(err.context)).toBe(true);
  });

  it('constructor with no context defaults to empty frozen object', () => {
    const err = new ValidationError('oops');
    expect(err.context).toEqual({});
    expect(Object.isFrozen(err.context)).toBe(true);
  });
});

// ——— getRetryStrategy ———

describe('getRetryStrategy', () => {
  it('RateLimitError → backoff with variable delay', () => {
    const err = new RateLimitError('too many requests');
    const result = getRetryStrategy(err, 2);
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(3000); // 1000 * (2 + 1)
    expect(result.strategy).toBe('backoff');
  });

  it('TimeoutError → jitter', () => {
    const err = new TimeoutError('request timed out');
    const result = getRetryStrategy(err);
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBeGreaterThanOrEqual(500);
    expect(result.delayMs).toBeLessThanOrEqual(1500);
    expect(result.strategy).toBe('jitter');
  });

  it('AuthError → immediate_abort', () => {
    const err = new AuthError('invalid API key');
    const result = getRetryStrategy(err);
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBe(0);
    expect(result.strategy).toBe('immediate_abort');
  });

  it('ModelNotFoundError → immediate_abort', () => {
    const err = new ModelNotFoundError('model gpt-5 not found');
    const result = getRetryStrategy(err);
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBe(0);
    expect(result.strategy).toBe('immediate_abort');
  });

  it('ValidationError → no_retry', () => {
    const err = new ValidationError('invalid input');
    const result = getRetryStrategy(err);
    expect(result.shouldRetry).toBe(false);
    expect(result.delayMs).toBe(0);
    expect(result.strategy).toBe('no_retry');
  });

  it('unknown error defaults to backoff with 500ms', () => {
    const result = getRetryStrategy(new Error('network hiccup'));
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(500);
    expect(result.strategy).toBe('backoff');
  });

  it('string error defaults to backoff', () => {
    const result = getRetryStrategy('something broke');
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(500);
    expect(result.strategy).toBe('backoff');
  });
});

// ——— sanitizeError ———

describe('sanitizeError', () => {
  it('preserves error code for NovalisticallyError', () => {
    const err = new ConfigError('bad file', { path: '/cfg.yaml' });
    const msg = sanitizeError(err);
    expect(msg).toContain('[CONFIG_INVALID]');
    expect(msg).toContain('bad file');
  });

  it('redacts API keys from message', () => {
    const err = new Error('API key sk-abc123def456 is invalid');
    const msg = sanitizeError(err);
    expect(msg).not.toContain('sk-abc123def456');
    expect(msg).not.toMatch(/sk-[a-z0-9]+/i);
  });

  it('redacts bearer tokens', () => {
    const err = new Error('Bearer eyJhbGciOiJIUzI1NiJ9.token');
    const msg = sanitizeError(err);
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('caps length to MAX_REASON_LENGTH', () => {
    const long = 'x'.repeat(500);
    const err = new Error(long);
    const msg = sanitizeError(err);
    expect(msg.length).toBeLessThanOrEqual(203); // 200 + '...'
  });

  it('handles non-Error unknown gracefully', () => {
    expect(sanitizeError(42)).toBe('unknown error');
    expect(sanitizeError(null)).toBe('unknown error');
    expect(sanitizeError(undefined)).toBe('unknown error');
  });

  it('returns empty/whitespace-only error message as unknown error', () => {
    const err = new Error('');
    const msg = sanitizeError(err);
    expect(msg).toBe('unknown error');
  });
});
