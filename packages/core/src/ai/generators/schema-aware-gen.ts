// ============================================================================
// Novalistically — Schema-Aware Generation (S5)
// Zod-aware retry loop for YAML generation (Instructor pattern).
//
// Pipeline: YAML.parse(text) → schema.validate(parsed) → on Zod failure:
// collect error messages → feed back to LLM with error context → retry
// (max 3). Each retry carries specific Zod error messages so the LLM can
// correct its output.
// ============================================================================

import YAML from 'yaml';
import type { ZodError, ZodSchema } from 'zod/v3';

// ── Retry configuration ──────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;

// ── Generator function type ───────────────────────────────────────────────────

/**
 * A generator function that produces a raw YAML/JSON string from a prompt.
 * Used to abstract over different LLM providers.
 */
export type GeneratorFn = (prompt: string) => Promise<string>;

// ── Result type ──────────────────────────────────────────────────────────────

export interface SchemaAwareResult<T> {
  /** The validated result (may be partial/last-attempt on failure) */
  result: T;
  /** Number of generation attempts made */
  attempts: number;
  /** Error messages collected from failed attempts */
  errors: string[];
}

// ── Helper: extract human-readable error messages from ZodError ──────────────

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map(
    (issue) => `Path: ${issue.path.join('.')} — ${issue.message} (code: ${issue.code})`,
  );
}

// ── Helper: build error feedback prompt for the LLM ──────────────────────────

function buildRetryPrompt(
  originalPrompt: string,
  rawOutput: string,
  errors: string[],
  attempt: number,
  maxRetries: number,
): string {
  return [
    originalPrompt,
    '',
    `--- Previous attempt (${attempt}/${maxRetries}) produced a YAML output that failed validation.`,
    '--- Raw output:',
    '```yaml',
    rawOutput,
    '```',
    '--- Validation errors:',
    ...errors.map((e) => `  - ${e}`),
    '',
    'Please correct the YAML output above to fix ALL of the listed validation errors.',
    'Return ONLY valid YAML — no explanation, no markdown fences.',
  ].join('\n');
}

// ── Core retry function ──────────────────────────────────────────────────────

/**
 * Generate structured data with schema validation and retry.
 *
 * Calls the LLM generator, parses output as YAML, validates against the
 * provided Zod schema, and retries with error feedback on failure.
 *
 * @param prompt - The generation prompt
 * @param schema - A Zod schema to validate the parsed YAML against
 * @param generator - Async function that produces raw text from a prompt
 * @param maxRetries - Maximum number of generation attempts (default 3)
 * @returns The validated result with attempt/error metadata
 *
 * @example
 * ```ts
 * const { result, attempts } = await generateWithSchemaRetry(
 *   'Generate a character definition',
 *   characterDefinitionSchema,
 *   llmProvider.generate,
 * );
 * ```
 */
export async function generateWithSchemaRetry<T>(
  prompt: string,
  schema: ZodSchema<T>,
  generator: GeneratorFn,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<SchemaAwareResult<T>> {
  const errors: string[] = [];
  let lastResult: T | null = null;
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: Generate raw output
      const rawOutput = await generator(currentPrompt);

      // Step 2: Parse as YAML
      let parsed: unknown;
      try {
        parsed = YAML.parse(rawOutput);
      } catch (parseError) {
        const msg = parseError instanceof Error ? parseError.message : String(parseError);
        errors.push(`YAML parse error (attempt ${attempt}): ${msg}`);

        if (attempt < maxRetries) {
          currentPrompt = buildRetryPrompt(prompt, rawOutput, errors, attempt, maxRetries);
        }
        continue;
      }

      // Step 3: Validate against schema
      const validationResult = schema.safeParse(parsed);

      if (validationResult.success) {
        return {
          result: validationResult.data as T,
          attempts: attempt,
          errors,
        };
      }

      // Step 4: Collect Zod errors and retry
      const zodErrors = formatZodErrors(validationResult.error);
      errors.push(...zodErrors);

      if (attempt < maxRetries) {
        currentPrompt = buildRetryPrompt(prompt, rawOutput, errors, attempt, maxRetries);
      } else {
        // Last attempt failed — keep the (invalid) parsed result
        lastResult = parsed as T;
      }
    } catch (generatorError) {
      const msg = generatorError instanceof Error ? generatorError.message : String(generatorError);
      errors.push(`Generator error (attempt ${attempt}): ${msg}`);

      if (attempt < maxRetries) {
        currentPrompt = buildRetryPrompt(prompt, '', errors, attempt, maxRetries);
      }
    }
  }

  // All attempts exhausted — return last result with accumulated errors
  return {
    result: lastResult as T,
    attempts: maxRetries,
    errors,
  };
}
