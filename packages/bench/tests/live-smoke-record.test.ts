// ============================================================================
// Live smoke record builder — focused tests
// ============================================================================

import { NovalisticallyError, sanitizeError } from '@novalistically/core';
import type { RenderNovelResult } from '@novalistically/core/editorial';
import type { ProviderCallLedgerEntry } from '@novalistically/core/tooling';
import { liveSmokeRecordSchema } from '@novalistically/core/tooling';
import { describe, expect, it } from 'vitest';
import { buildLiveSmokeRecord } from '../src/live-smoke.js';

// ============================================================================
// Helpers
// ============================================================================

function makeProviderCalls(
  opts: {
    pass1Success?: boolean;
    pass2Success?: boolean;
    pass2VerifySuccess?: boolean;
    attempts?: number;
    pass1FailureReason?: string;
    pass2FailureReason?: string;
  } = {},
): ProviderCallLedgerEntry[] {
  const calls: ProviderCallLedgerEntry[] = [];
  const attempts = opts.attempts ?? 1;
  const dummyHash = 'a'.repeat(64);

  for (let a = 1; a <= attempts; a++) {
    if (opts.pass1Success ?? true) {
      calls.push({
        phase: 'pass1',
        attempt: a,
        outcome: 'success',
        requestHash: dummyHash,
        model: 'test-model',
        seed: null,
      });
    } else {
      calls.push({
        phase: 'pass1',
        attempt: a,
        outcome: 'failure',
        requestHash: dummyHash,
        model: 'test-model',
        seed: null,
        failureReason: opts.pass1FailureReason ?? 'mock pass1 error',
      });
      continue; // no pass2 if pass1 failed
    }

    if (opts.pass2Success ?? true) {
      calls.push({
        phase: 'pass2',
        attempt: a,
        outcome: 'success',
        requestHash: dummyHash,
        model: 'test-model',
        seed: 42,
      });
      if (opts.pass2VerifySuccess ?? false) {
        calls.push({
          phase: 'pass2_verify',
          attempt: a,
          outcome: 'success',
          requestHash: dummyHash,
          model: 'test-model',
          seed: 42,
        });
      }
    } else {
      calls.push({
        phase: 'pass2',
        attempt: a,
        outcome: 'failure',
        requestHash: dummyHash,
        model: 'test-model',
        seed: 42,
        failureReason: opts.pass2FailureReason ?? 'mock pass2 error',
      });
    }
  }

  return calls;
}
function makeResult(opts: {
  eventId: string;
  prose?: string;
  errors?: string[];
  released?: boolean;
  analysis?: unknown;
  providerCalls?: ProviderCallLedgerEntry[];
  validationErrors?: number;
  cacheHit?: boolean;
}): RenderNovelResult['results'][number] {
  const resolvedCalls = opts.providerCalls ?? makeProviderCalls();
  return {
    eventId: opts.eventId,
    prose: opts.prose ?? 'Generated prose.',
    wordCount: 3,
    cacheHit: opts.cacheHit ?? false,
    errors: opts.errors ?? [],
    released: opts.released ?? true,
    validationErrors: opts.validationErrors ?? 0,
    validationIssueMessages: [],
    analysis: ('analysis' in opts
      ? opts.analysis
      : { entities: [] }) as RenderNovelResult['results'][number]['analysis'],
    providerCalls: resolvedCalls,
    promptHash: resolvedCalls.length > 0 ? 'a'.repeat(64) : '',
  };
}

function baseInput(overrides: Partial<Parameters<typeof buildLiveSmokeRecord>[0]> = {}) {
  return {
    provider: 'ai-sdk',
    model: 'test-model',
    seed: 42,
    command: 'test',
    versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
    result: {
      results: [
        makeResult({ eventId: 'E0' }),
        makeResult({ eventId: 'E1' }),
        makeResult({ eventId: 'E2' }),
        makeResult({ eventId: 'E3' }),
        makeResult({ eventId: 'E4' }),
        makeResult({ eventId: 'E5' }),
        makeResult({ eventId: 'E6' }),
      ],
      errors: [],
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('buildLiveSmokeRecord — ledger totals', () => {
  it('derives totalCalls exactly from per-event ledger entries', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({ eventId: 'E0', providerCalls: makeProviderCalls({ attempts: 1 }) }),
          makeResult({ eventId: 'E1', providerCalls: makeProviderCalls({ attempts: 1 }) }),
        ],
        errors: [],
      },
      requiredEvents: ['E0', 'E1'],
    });

    const output = buildLiveSmokeRecord(input);
    const record = output.record as Record<string, unknown>;
    const call = record.call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;

    // Each event: pass1 success + pass2 success = 2 calls
    expect(perEvent[0].ledger).toHaveLength(2);
    expect(perEvent[1].ledger).toHaveLength(2);
    expect(call.totalCalls).toBe(4);
  });

  it('counts pass2_verify calls in the ledger', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E0',
            providerCalls: makeProviderCalls({ pass2VerifySuccess: true }),
          }),
        ],
        errors: [],
      },
      requiredEvents: ['E0'],
    });

    const output = buildLiveSmokeRecord(input);
    const call = (output.record as Record<string, unknown>).call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;

    // pass1 + pass2 + pass2_verify = 3 calls
    expect(perEvent[0].ledger).toHaveLength(3);
    expect(call.totalCalls).toBe(3);
  });
});

describe('buildLiveSmokeRecord — retry totals (Pass 2)', () => {
  it('captures multiple attempts in the ledger', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E0',
            providerCalls: makeProviderCalls({ attempts: 3 }),
          }),
        ],
        errors: [],
      },
      requiredEvents: ['E0'],
    });

    const output = buildLiveSmokeRecord(input);
    const call = (output.record as Record<string, unknown>).call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;
    const ledger = perEvent[0].ledger as Array<Record<string, unknown>>;

    // 3 attempts × 2 calls each = 6 entries
    expect(ledger).toHaveLength(6);
    expect(call.totalCalls).toBe(6);

    // Verify attempt numbers
    const attempts = ledger.map((e) => e.attempt);
    expect(attempts).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('records failure reasons for failed attempts', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E0',
            providerCalls: [
              {
                phase: 'pass1',
                attempt: 1,
                outcome: 'failure',
                requestHash: 'a'.repeat(64),
                model: 'test-model',
                seed: null,
                failureReason: 'timeout',
              },
              {
                phase: 'pass1',
                attempt: 2,
                outcome: 'success',
                requestHash: 'a'.repeat(64),
                model: 'test-model',
                seed: null,
              },
              {
                phase: 'pass2',
                attempt: 2,
                outcome: 'failure',
                requestHash: 'a'.repeat(64),
                model: 'test-model',
                seed: 42,
                failureReason: 'invalid json',
              },
            ],
          }),
        ],
        errors: [],
      },
      requiredEvents: ['E0'],
    });

    const output = buildLiveSmokeRecord(input);
    const call = (output.record as Record<string, unknown>).call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;
    const ledger = perEvent[0].ledger as Array<Record<string, unknown>>;

    expect(ledger).toHaveLength(3);
    expect(call.totalCalls).toBe(3);
    expect(ledger[0]).toMatchObject({
      phase: 'pass1',
      attempt: 1,
      outcome: 'failure',
      failureReason: 'timeout',
    });
    expect(ledger[1]).toMatchObject({ phase: 'pass1', attempt: 2, outcome: 'success' });
    expect(ledger[2]).toMatchObject({
      phase: 'pass2',
      attempt: 2,
      outcome: 'failure',
      failureReason: 'invalid json',
    });
  });
});

describe('buildLiveSmokeRecord — event-specific failures', () => {
  it('attributes empty prose failure to the specific event', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({ eventId: 'E0', prose: '', released: false }),
          makeResult({ eventId: 'E1' }),
        ],
        errors: [],
      },
      requiredEvents: ['E0', 'E1'],
    });

    const output = buildLiveSmokeRecord(input);
    expect(output.success).toBe(false);

    const failures = (output.record as Record<string, unknown>).failures as string[];
    expect(failures).toContainEqual(expect.stringContaining('E0'));
    expect(failures).toContainEqual(expect.stringContaining('empty prose'));
  });

  it('attributes validation errors to the specific event', () => {
    const input = baseInput({
      result: {
        results: [makeResult({ eventId: 'E2', validationErrors: 3, released: false })],
        errors: [],
      },
      requiredEvents: [],
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    expect(failures).toContainEqual(expect.stringContaining('E2'));
    expect(failures).toContainEqual(expect.stringContaining('3 validation error'));
  });

  it('attributes missing analysis to the specific event', () => {
    const input = baseInput({
      result: {
        results: [makeResult({ eventId: 'E3', analysis: null, released: false })],
        errors: [],
      },
      requiredEvents: [],
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    expect(failures).toContainEqual(expect.stringContaining('E3'));
    expect(failures).toContainEqual(expect.stringContaining('no analysis'));
  });

  it('rejects null analysis with redacted Pass2 failure as failed (not candidate) with full evidence', () => {
    const secretReason = 'LLM error: api_key=sk-pass2-null-analysis-999 at endpoint auth';
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E1',
            analysis: null,
            released: false,
            providerCalls: makeProviderCalls({
              pass2Success: false,
              pass2FailureReason: secretReason,
            }),
          }),
        ],
        errors: [],
      },
      requiredEvents: ['E1'],
    });

    const output = buildLiveSmokeRecord(input);
    expect(output.success).toBe(false);

    const record = output.record as Record<string, unknown>;
    expect(record.reviewStatus).toBe('failed');

    // Schema must accept record despite failures
    const schemaResult = liveSmokeRecordSchema.safeParse(record);
    expect(schemaResult.success).toBe(true);

    // Failures contain null-analysis indicator and event ID, not secret
    const failures = record.failures as string[];
    expect(failures).toContainEqual(expect.stringContaining('E1'));
    expect(failures).toContainEqual(expect.stringContaining('no analysis'));
    const failureText = failures.join(' ');
    expect(failureText).not.toContain('sk-pass2-null-analysis-999');

    // Ledger entries retained with valid 64-hex requestHash
    const call = record.call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;
    const ledger = perEvent[0].ledger as Array<Record<string, unknown>>;
    expect(ledger.length).toBeGreaterThanOrEqual(2); // pass1 success + pass2 failure
    expect(ledger[0].phase).toBe('pass1');
    expect(ledger[0].outcome).toBe('success');
    expect(String(ledger[0].requestHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger[1].phase).toBe('pass2');
    expect(ledger[1].outcome).toBe('failure');
    expect(String(ledger[1].requestHash)).toMatch(/^[0-9a-f]{64}$/);
    // Pass2 failure reason redacted
    const failureReason = String(ledger[1].failureReason ?? '');
    expect(failureReason).not.toContain('sk-pass2-null-analysis-999');
    expect(failureReason).toContain('[redacted]');

    // Full hashes present with valid 64-hex strings
    const hashes = record.hashes as Record<string, unknown>;
    const events = hashes.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('E1');
    expect(String(events[0].proseHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(events[0].analysisHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(events[0].promptHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes global errors in failures', () => {
    const input = baseInput({
      result: {
        results: [makeResult({ eventId: 'E0' })],
        errors: ['Release gate rejected: E1'],
      },
      requiredEvents: ['E0'],
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    expect(failures).toContain('Release gate rejected: E1');
  });

  it('requires exactly E0–E6 for candidate success', () => {
    // Only E0-E5 rendered (missing E6)
    const input = baseInput({
      result: {
        results: ['E0', 'E1', 'E2', 'E3', 'E4', 'E5'].map((id) => makeResult({ eventId: id })),
        errors: [],
      },
    });

    const output = buildLiveSmokeRecord(input);
    expect(output.success).toBe(false);
    expect((output.record as Record<string, unknown>).reviewStatus).toBe('failed');
  });

  it('marks success when all E0–E6 are present and released', () => {
    const input = baseInput();

    const output = buildLiveSmokeRecord(input);
    expect(output.success).toBe(true);
    expect((output.record as Record<string, unknown>).reviewStatus).toBe('candidate');
  });
});

describe('liveSmokeRecordSchema — malformed totals', () => {
  const validHash64 = 'a'.repeat(64);

  it('rejects totalCalls that does not match ledger sum', () => {
    const record = {
      version: 1,
      provider: 'ai-sdk',
      model: 'test',
      seed: 1,
      events: ['E0'],
      system: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64', cpu: 'test' },
      versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
      command: 'test',
      call: {
        perEvent: [
          {
            eventId: 'E0',
            ledger: [
              {
                phase: 'pass1',
                attempt: 1,
                outcome: 'success',
                requestHash: validHash64,
                model: 'test-model',
                seed: null,
              },
              {
                phase: 'pass2',
                attempt: 1,
                outcome: 'success',
                requestHash: validHash64,
                model: 'test-model',
                seed: 42,
              },
            ],
          },
        ],
        totalCalls: 999, // should be 2
      },
      cache: { hits: 0, misses: 1 },
      failures: [],
      hashes: {
        events: [
          {
            eventId: 'E0',
            proseHash: validHash64,
            analysisHash: validHash64,
            promptHash: validHash64,
          },
        ],
      },
      generatedAt: '2026-07-20T00:00:00.000Z',
      reviewStatus: 'candidate',
    };

    const result = liveSmokeRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('totalCalls'))).toBe(true);
    }
  });

  it('rejects negative totalCalls', () => {
    const record = {
      version: 1,
      provider: 'ai-sdk',
      model: 'test',
      seed: 1,
      events: ['E0'],
      system: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64', cpu: 'test' },
      versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
      command: 'test',
      call: {
        perEvent: [],
        totalCalls: -1,
      },
      cache: { hits: 0, misses: 0 },
      failures: [],
      hashes: { events: [] },
      generatedAt: '2026-07-20T00:00:00.000Z',
      reviewStatus: 'failed',
    };

    const result = liveSmokeRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects ledger entry with invalid phase', () => {
    const record = {
      version: 1,
      provider: 'ai-sdk',
      model: 'test',
      seed: 1,
      events: ['E0'],
      system: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64', cpu: 'test' },
      versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
      command: 'test',
      call: {
        perEvent: [
          {
            eventId: 'E0',
            ledger: [
              {
                phase: 'invalid_phase',
                attempt: 1,
                outcome: 'success',
                requestHash: validHash64,
                model: 'test-model',
                seed: null,
              },
            ],
          },
        ],
        totalCalls: 1,
      },
      cache: { hits: 0, misses: 1 },
      failures: [],
      hashes: {
        events: [
          {
            eventId: 'E0',
            proseHash: validHash64,
            analysisHash: validHash64,
            promptHash: validHash64,
          },
        ],
      },
      generatedAt: '2026-07-20T00:00:00.000Z',
      reviewStatus: 'failed',
    };

    const result = liveSmokeRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it('rejects record with extra secret-like top-level fields', () => {
    const validOutput = buildLiveSmokeRecord(baseInput()).record;
    const bad = { ...validOutput, apiKey: 'sk-secret', authHeader: 'Bearer xyz' };
    const result = liveSmokeRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('liveSmokeRecordSchema — Pass2 failure entries', () => {
  it('accepts record with Pass2 failure entries containing valid 64-hex requestHash and redacted reason', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E0',
            released: false,
            providerCalls: makeProviderCalls({
              pass2Success: false,
              pass2FailureReason: 'LLM error: api_key=sk-leaked-in-fail-999',
            }),
          }),
        ],
        errors: [],
      },
    });

    const output = buildLiveSmokeRecord(input);
    expect(output.success).toBe(false);

    const record = output.record as Record<string, unknown>;

    // Schema must accept the record despite Pass2 failures
    const schemaResult = liveSmokeRecordSchema.safeParse(record);
    expect(schemaResult.success).toBe(true);

    // Ledger entries: pass1 success + pass2 failure
    const call = record.call as Record<string, unknown>;
    const perEvent = call.perEvent as Array<Record<string, unknown>>;
    const ledger = perEvent[0].ledger as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(2);

    // Both entries must have valid 64-hex requestHash
    expect(String(ledger[0].requestHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(ledger[1].requestHash)).toMatch(/^[0-9a-f]{64}$/);

    // Pass2 failure reason must be redacted
    expect(ledger[1].outcome).toBe('failure');
    const failureReason = String(ledger[1].failureReason ?? '');
    expect(failureReason).not.toContain('sk-leaked-in-fail-999');
    expect(failureReason).toContain('[redacted]');
  });
});

// ============================================================================
// sanitizeError — safe-error redaction
// ============================================================================

describe('sanitizeError — redacts secret-like content', () => {
  it('redacts OpenAI-style API keys', () => {
    const result = sanitizeError('Request failed with key sk-proj-abc123xyz789secretkey');
    expect(result).not.toContain('sk-proj-abc123xyz789secretkey');
    expect(result).toContain('[redacted]');
  });

  it('redacts Anthropic-style API keys', () => {
    const result = sanitizeError('Auth failure: key=sk-ant-api03-abc123def456ghi789jkl is invalid');
    expect(result).not.toContain('sk-ant-api03-abc123def456ghi789jkl');
    expect(result).toContain('[redacted]');
  });

  it('redacts Bearer tokens', () => {
    const result = sanitizeError(
      'HTTP 401: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNl5K4p4fEhGZVpBdRHzRZSQhVxhONqmjRqJxHA',
    );
    expect(result).not.toContain('eyJhbGci');
    expect(result).not.toMatch(/Bearer/i);
    expect(result).toContain('[redacted]');
  });
  it('redacts Authorization header values', () => {
    const result = sanitizeError('Response 403: Authorization: Bearer token123abc');
    expect(result).not.toContain('token123abc');
    expect(result).not.toMatch(/Authorization/i);
    expect(result).not.toMatch(/Bearer/i);
    expect(result).toContain('[redacted]');
  });

  it('redacts api_key params in query-style strings', () => {
    const result = sanitizeError('Invalid request: api_key=sk-secret-value-here, model=gpt-4');
    expect(result).toContain('[redacted]');
    expect(result).not.toContain('api_key');
    expect(result).not.toContain('sk-secret-value-here');
  });

  it('redacts secret/token/password params', () => {
    const result = sanitizeError(
      'Config error: secret=mysecret123, token=abctoken, password=supersecret',
    );
    expect(result).toContain('[redacted]');
    expect(result).not.toContain('secret=');
    expect(result).not.toContain('token=');
    expect(result).not.toContain('password=');
    expect(result).not.toContain('mysecret123');
    expect(result).not.toContain('abctoken');
    expect(result).not.toContain('supersecret');
  });

  it('redacts credential params', () => {
    const result = sanitizeError('credential=abc123xyz');
    expect(result).toContain('[redacted]');
    expect(result).not.toContain('credential=');
  });

  it('redacts Cookie headers', () => {
    const result = sanitizeError('Request had Cookie: sessionId=abc123; auth=secret123');
    expect(result).not.toContain('sessionId=abc123');
    expect(result).not.toMatch(/Cookie/i);
    expect(result).toContain('[redacted]');
  });

  it('redacts URLs with embedded credentials', () => {
    const result = sanitizeError(
      'Failed to connect to https://user:password123@api.example.com/v1',
    );
    expect(result).toContain('https://[redacted]@');
    expect(result).not.toContain('password123');
  });

  it('preserves NovalisticallyError codes', () => {
    const err = new NovalisticallyError('PROVIDER_AUTH', 'Invalid credentials', { path: '/auth' });
    const result = sanitizeError(err);
    expect(result).toContain('[PROVIDER_AUTH]');
    expect(result).toContain('Invalid credentials');
  });

  it('preserves supplied NovalisticallyError codes', () => {
    const err = new NovalisticallyError('PIPELINE_FAILURE', 'Scene render timed out', {
      eventId: 'E3',
    });
    const result = sanitizeError(err);
    expect(result).toContain('[PIPELINE_FAILURE]');
    expect(result).toContain('Scene render timed out');
  });

  it('handles plain Error instances', () => {
    const result = sanitizeError(new Error('Something broke'));
    expect(result).toBe('Something broke');
  });

  it('handles string inputs', () => {
    const result = sanitizeError('just a string message');
    expect(result).toBe('just a string message');
  });

  it('handles non-error, non-string inputs', () => {
    expect(sanitizeError(null)).toBe('unknown error');
    expect(sanitizeError(undefined)).toBe('unknown error');
    expect(sanitizeError(42)).toBe('unknown error');
    expect(sanitizeError({ code: 'X' })).toBe('unknown error');
  });

  it('caps long messages to prevent prompt/prose leakage', () => {
    const longMessage = `Error: ${'_'.repeat(300)}`;
    const result = sanitizeError(longMessage);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns unknown error for empty strings after redaction', () => {
    // A string that becomes empty after redaction is not possible with our
    // current patterns, but we safeguard the return value.
    const result = sanitizeError('');
    // empty string after redaction falls through to the `|| 'unknown error'` guard
    expect(result).toBe('unknown error');
  });
});

// ============================================================================
// Secret-exposure: smoke records must never serialize secrets
// ============================================================================

describe('buildLiveSmokeRecord — secret redaction in failures', () => {
  it('strips API keys from provider error in global failures', () => {
    const input = baseInput({
      result: {
        results: [],
        errors: ['Failed to create LLM provider: API key sk-proj-leaked-key-12345 is invalid'],
      },
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    const failureText = failures.join(' ');
    expect(failureText).not.toContain('sk-proj-leaked-key-12345');
    expect(failureText).toContain('[redacted]');
  });

  it('strips Bearer tokens from provider error in global failures', () => {
    const input = baseInput({
      result: {
        results: [],
        errors: [
          'Provider error: Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.secretpayload.signature',
        ],
      },
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    const failureText = failures.join(' ');
    expect(failureText).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(failureText).not.toMatch(/Bearer/i);
    expect(failureText).not.toMatch(/Authorization/i);
    expect(failureText).toContain('[redacted]');
  });

  it('strips secrets from per-event ledger failureReason', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E0',
            released: false,
            providerCalls: [
              {
                phase: 'pass1',
                attempt: 1,
                outcome: 'failure' as const,
                requestHash: 'a'.repeat(64),
                model: 'test-model',
                seed: null,
                failureReason: 'LLM error: api_key=sk-leaked-in-ledger-999',
              },
            ],
          }),
        ],
        errors: [],
      },
      requiredEvents: [],
    });

    const output = buildLiveSmokeRecord(input);
    const perEvent = (output.record as Record<string, unknown>).call as {
      perEvent: Array<{ ledger: Array<{ failureReason?: string }> }>;
    };
    const ledgerEntry = perEvent.perEvent[0].ledger[0];
    expect(ledgerEntry.failureReason).toBeDefined();
    expect(ledgerEntry.failureReason).not.toContain('sk-leaked-in-ledger-999');
    expect(ledgerEntry.failureReason).toContain('[redacted]');
  });

  it('strips bearer/API-key substrings from per-event release errors', () => {
    const input = baseInput({
      result: {
        results: [
          makeResult({
            eventId: 'E2',
            released: false,
            errors: [
              'Pass 1 attempt 1 failed: HTTP 401 Unauthorized — invalid API key: sk-event-leak-bearer-123',
              'Pass 2 attempt 1 failed: HTTP 403: Bearer eyJhbGciOiJSUzI1NiJ9.secret.sig',
            ],
          }),
        ],
        errors: [],
      },
      requiredEvents: [],
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    const failureText = failures.join(' ');
    expect(failureText).not.toContain('sk-event-leak-bearer-123');
    expect(failureText).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(failureText).not.toMatch(/Bearer/i);
    expect(failureText).toContain('[redacted]');
    expect(failureText).toContain('E2');
  });

  it('strips Cookie headers from release error in global failures', () => {
    const input = baseInput({
      result: {
        results: [],
        errors: ['Network error: Cookie: session=abcdef; auth_token=ghijkl'],
      },
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    const failureText = failures.join(' ');
    expect(failureText).not.toContain('auth_token=ghijkl');
    expect(failureText).not.toMatch(/Cookie/i);
    expect(failureText).toContain('[redacted]');
  });

  it('redacts URL credentials from release error', () => {
    const input = baseInput({
      result: {
        results: [],
        errors: ['Connection failed: https://admin:secretpass@api.internal.io/v2'],
      },
    });

    const output = buildLiveSmokeRecord(input);
    const failures = (output.record as Record<string, unknown>).failures as string[];
    const failureText = failures.join(' ');
    expect(failureText).toContain('https://[redacted]@');
    expect(failureText).not.toContain('secretpass');
    expect(failureText).not.toContain('admin');
  });
});
