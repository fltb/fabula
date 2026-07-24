// ============================================================================
// Novalistically — Schema-Aware Generation — Unit Tests (S5)
// ============================================================================
//
// Tests use mock generator functions, not real LLM calls.
// Coverage: valid YAML passes on first try, invalid YAML retries and
// succeeds, 3 failures returns last result with accumulated errors.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { generateWithSchemaRetry } from '../../src/ai/generators/schema-aware-gen.ts';

// ── Test schema ──────────────────────────────────────────────────────────────

const testSchema = z
  .object({
    name: z.string().min(1),
    age: z.number().int().positive(),
    role: z.enum(['warrior', 'mage', 'rogue']),
  })
  .strict();

type TestCharacter = z.infer<typeof testSchema>;

// ── Mock generator factory ───────────────────────────────────────────────────

function makeMockGenerator(
  outputs: Array<string | Error>,
) {
  let callIndex = 0;
  return vi.fn(async (_prompt: string): Promise<string> => {
    if (callIndex >= outputs.length) {
      return '';
    }
    const output = outputs[callIndex++];
    if (output instanceof Error) {
      throw output;
    }
    return output;
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateWithSchemaRetry', () => {
  // ── Valid YAML passes on first try ─────────────────────────────────────────

  it('returns validated result on first attempt for valid YAML', async () => {
    const generator = makeMockGenerator([
      'name: Aragorn\nage: 87\nrole: warrior\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
    );

    expect(attempts).toBe(1);
    expect(errors).toEqual([]);
    expect(result).toEqual({
      name: 'Aragorn',
      age: 87,
      role: 'warrior',
    });
    expect(generator).toHaveBeenCalledTimes(1);
  });

  // ── Invalid YAML syntax retries and succeeds on second try ─────────────────

  it('retries on YAML parse error and succeeds on second attempt', async () => {
    const generator = makeMockGenerator([
      'name: Legolas\nage: {bad yaml\nrole: rogue\n',
      'name: Legolas\nage: 2931\nrole: rogue\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
    );

    expect(attempts).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes('YAML parse error'))).toBe(true);
    expect(result).toEqual({
      name: 'Legolas',
      age: 2931,
      role: 'rogue',
    });
    expect(generator).toHaveBeenCalledTimes(2);
  });


  it('retries on Zod validation error and succeeds on second attempt', async () => {
    const generator = makeMockGenerator([
      'name: Gimli\nage: -5\nrole: warrior\n',
      'name: Gimli\nage: 139\nrole: warrior\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
    );

    expect(attempts).toBe(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes('age') && e.includes('greater than 0'))).toBe(true);
    expect(result).toEqual({
      name: 'Gimli',
      age: 139,
      role: 'warrior',
    });
    expect(generator).toHaveBeenCalledTimes(2);
  });

  // ── Three failures returns last result with errors ─────────────────────────

  it('returns last result with accumulated errors after 3 failures', async () => {
    const generator = makeMockGenerator([
      'name: Frodo\nage: invalid\nrole: hobbit\n',
      'name: Frodo\nage: \nrole: \n',
      'name: \nage: 0\nrole: invalid_role\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
    );

    expect(attempts).toBe(3);
    // Should have collected errors from all 3 attempts
    // - attempt 1: age is not a number + role invalid enum
    // - attempt 2: age is NaN + role empty
    // - attempt 3: name empty + age not positive + role invalid enum
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(result).toBeDefined();
    // result is last attempt's (invalid) parsed data
    expect(generator).toHaveBeenCalledTimes(3);
  });

  // ── Generator throws error ─────────────────────────────────────────────────

  it('handles generator throwing an error', async () => {
    const generator = makeMockGenerator([
      new Error('API timeout'),
      'name: Gandalf\nage: 7000\nrole: mage\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
    );

    expect(attempts).toBe(2);
    expect(errors.some((e) => e.includes('API timeout'))).toBe(true);
    expect(result).toEqual({
      name: 'Gandalf',
      age: 7000,
      role: 'mage',
    });
    expect(generator).toHaveBeenCalledTimes(2);
  });

  // ── Custom maxRetries ──────────────────────────────────────────────────────

  it('respects custom maxRetries parameter', async () => {
    const generator = makeMockGenerator([
      'name: invalid\n',
      'name: still invalid\n',
      'name: still invalid 2\n',
      'name: still invalid 3\n',
      'name: Boromir\nage: 41\nrole: warrior\n',
    ]);

    const { result, attempts } = await generateWithSchemaRetry<TestCharacter>(
      'Generate a character',
      testSchema,
      generator,
      5,
    );

    expect(attempts).toBe(5);
    // The 5th (last) attempt's output is valid
    expect(result).toEqual({
      name: 'Boromir',
      age: 41,
      role: 'warrior',
    });
    expect(generator).toHaveBeenCalledTimes(5);
  });

  // ── Works with any Zod schema ──────────────────────────────────────────────

  it('works with simple zod schemas (string)', async () => {
    const stringSchema = z.string();
    const generator = makeMockGenerator([
      'hello world\n',
    ]);

    const { result, attempts, errors } = await generateWithSchemaRetry<string>(
      'Generate a string',
      stringSchema,
      generator,
    );

    expect(attempts).toBe(1);
    expect(errors).toEqual([]);
    expect(result).toBe('hello world');
  });

  it('works with simple zod schemas (number array)', async () => {
    const numArraySchema = z.array(z.number());
    const generator = makeMockGenerator([
      '- 1\n- 2\n- 3\n',
    ]);

    const { result, attempts } = await generateWithSchemaRetry<number[]>(
      'Generate numbers',
      numArraySchema,
      generator,
    );

    expect(attempts).toBe(1);
    expect(result).toEqual([1, 2, 3]);
  });
});
