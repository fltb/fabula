import { z } from 'zod';
import { analysisResultSchema } from './analysis.js';

const schemaVersion = z.literal(1);

const validatorIssueIdentitySchema = z
  .object({
    validator: z.string().min(1),
    eventId: z.string().min(1),
    category: z.string().min(1),
    entityId: z.string().min(1).optional(),
    attribute: z.string().min(1).optional(),
    severity: z.enum(['error', 'warning', 'info']),
    kind: z
      .enum([
        'compiler_invariant',
        'evidence_mismatch',
        'interpretive_assessment',
        'analysis_uncertainty',
      ])
      .optional(),
    observationRef: z
      .object({
        field: z.string().min(1),
        analysisPointer: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const expectedOutcomeManifestSchema = z
  .object({
    version: schemaVersion,
    issues: z.array(validatorIssueIdentitySchema),
  })
  .strict();

export const provenanceManifestSchema = z
  .object({
    version: schemaVersion,
    entries: z.array(
      z.discriminatedUnion('kind', [
        z
          .object({
            eventId: z.string().min(1),
            kind: z.literal('generated'),
            runHash: z.string().min(1),
          })
          .strict(),
        z
          .object({
            eventId: z.string().min(1),
            kind: z.literal('source_quotation'),
            edition: z.string().min(1),
            url: z.string().url(),
            rights: z.string().min(1),
            sourceHash: z.string().min(1),
            overlap: z
              .object({
                start: z.number().int().nonnegative(),
                end: z.number().int().positive(),
                hash: z.string().min(1),
              })
              .strict(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

export const responseReferenceSchema = z
  .object({
    prose: z.string().min(1),
    analysis: z.lazy(() => analysisResultSchema),
    metadata: z
      .object({
        eventId: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        seed: z.number().int(),
        promptVersion: z.string().min(1),
        promptHash: z.string().min(1),
        analysisSchemaVersion: schemaVersion,
        fixtureFormatVersion: schemaVersion,
        generatedAt: z.string().datetime(),
        reviewStatus: z.enum(['candidate', 'approved']),
        attempts: z.number().int().positive(),
        errors: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.analysis.eventId !== value.metadata.eventId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['analysis', 'eventId'],
        message: 'Reference event IDs must match',
      });
    }
    // Reject secret-like patterns in metadata string values
    const SECRET_VALUE_PATTERN =
      /(?:^|[^a-z])(?:sk-|api[_-]key|auth[_-]token|secret|password|credential)(?:$|[^a-z])/i;
    for (const [key, val] of Object.entries(value.metadata)) {
      if (typeof val === 'string' && SECRET_VALUE_PATTERN.test(val)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metadata', key],
          message: `Metadata field '${key}' contains a secret-like value`,
        });
      }
    }
  });

// ============================================================================
// Provider call ledger — per-call record for live smoke records
// ============================================================================

const providerCallLedgerEntrySchema = z
  .object({
    phase: z.enum(['pass1', 'pass2', 'pass2_verify']),
    attempt: z.number().int().positive(),
    outcome: z.enum(['success', 'failure']),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    model: z.string().min(1),
    seed: z.number().int().nullable(),
    failureReason: z.string().optional(),
  })
  .strict();

export const liveSmokeRecordSchema = z
  .object({
    version: schemaVersion,
    provider: z.string().min(1),
    model: z.string().min(1),
    seed: z.number().int(),
    events: z.array(z.string().min(1)).min(1),
    system: z.object({
      nodeVersion: z.string(),
      os: z.string(),
      arch: z.string(),
      cpu: z.string().optional(),
    }),
    versions: z.object({
      code: z.string(),
      fixture: z.string(),
      schema: schemaVersion,
      prompt: z.string(),
      capability: z.string(),
    }),
    command: z.string(),
    call: z
      .object({
        perEvent: z.array(
          z.object({
            eventId: z.string().min(1),
            ledger: z.array(providerCallLedgerEntrySchema),
          }),
        ),
        totalCalls: z.number().int().nonnegative(),
      })
      .superRefine((val, ctx) => {
        const computed = val.perEvent.reduce((sum, ev) => sum + ev.ledger.length, 0);
        if (computed !== val.totalCalls) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `totalCalls ${val.totalCalls} does not match sum of per-event ledger entries (${computed})`,
            path: ['totalCalls'],
          });
        }
      }),
    cache: z.object({
      hits: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
    }),
    failures: z.array(z.string()),
    hashes: z
      .object({
        events: z.array(
          z
            .object({
              eventId: z.string().min(1),
              proseHash: z.string().regex(/^[0-9a-f]{64}$/),
              analysisHash: z.string().regex(/^[0-9a-f]{64}$/),
              promptHash: z.string().regex(/^[0-9a-f]{64}$/),
            })
            .strict(),
        ),
      })
      .strict(),
    generatedAt: z.string().datetime(),
    reviewStatus: z.enum(['candidate', 'approved', 'failed']),
  })
  .strict();
