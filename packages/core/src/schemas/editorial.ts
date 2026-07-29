import { z } from 'zod';
import { analysisResultSchema } from './analysis.ts';
import { gameDialogueChoicesSchema } from './game-dialogue.ts';
import { reviewCommentSchema } from './review.ts';

const nonEmptyString = z.string().trim().min(1);
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().datetime();

export const editorialMutationContextSchema = z
  .object({ operationId: uuidSchema, actorId: nonEmptyString })
  .strict();

export const branchPathV1Schema = z
  .object({
    decisions: z.array(
      z
        .object({
          atEventId: nonEmptyString,
          choiceId: nonEmptyString,
          narrativeOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.enum(['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'and', 'or']),
      field: z.string().optional(),
      value: z.unknown().optional(),
      conditions: z.array(conditionSchema).optional(),
    })
    .strict(),
);

export const branchSetV1Schema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('all') }).strict(),
    z.object({ type: z.literal('paths'), paths: z.array(branchPathV1Schema) }).strict(),
    z.object({ type: z.literal('condition'), condition: conditionSchema }).strict(),
    z.object({ type: z.literal('except'), branches: branchSetV1Schema }).strict(),
  ]),
);

export const editorialErrorSchema = z
  .object({
    code: z.enum([
      'INVALID_OPERATION',
      'OPERATION_IN_PROGRESS',
      'OPERATION_INTERRUPTED',
      'OPERATION_CANCELLED',
      'PROVIDER_REQUIRED',
      'SOURCE_DOCUMENT_NOT_FOUND',
      'SOURCE_CHANGED',
      'REVIEW_NOT_FOUND',
      'REVISION_NOT_FOUND',
      'STORAGE_CONFLICT',
      'INVALID_SELECTOR',
      'SCENE_NOT_FOUND',
      'SCENE_NOT_IN_BRANCH',
      'INVALID_REVIEW_SELECTION',
      'NO_ACCEPTED_BASE',
      'NO_OPEN_FEEDBACK',
      'SCENE_LOCKED',
      'SCENE_LOCK_STALE',
      'SCENE_CONTENT_CONFLICT',
      'PUBLICATION_CONTENT_CONFLICT',
      'REVISION_BLOCKED',
      'REVISION_STALE',
      'PUBLICATION_INCOMPLETE',
      'INVALID_SOURCE_CHANGE',
    ]),
    message: nonEmptyString,
    eventId: z.string().optional(),
    path: z.string().optional(),
    operationId: z.string().optional(),
  })
  .strict();

export const transactionReadExpectationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      path: nonEmptyString,
      expectedHash: contentHashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('directory'),
      path: nonEmptyString,
      expectedManifestHash: contentHashSchema,
    })
    .strict(),
]);

const tokenUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

const releaseDecisionSchema = z
  .object({
    status: z.enum(['accepted', 'pending_waiver', 'blocked']),
    scopeHash: nonEmptyString,
    validationIdentity: nonEmptyString,
    reasons: z.array(z.string()),
    waiverId: z.string().optional(),
  })
  .strict();

const validationIssueSchema = z
  .object({
    validator: nonEmptyString,
    severity: z.enum(['error', 'warning', 'info']),
    event: z.string(),
    entity: z.string(),
    attribute: z.string().optional(),
    message: z.string(),
    fixSuggestion: z.string(),
    fixAction: z.enum([
      'add_knowledge',
      'remove_line',
      'change_value',
      'add_precondition',
      'declare_flashback',
      'manual',
      'add_field',
      'create_file',
      'edit_file',
    ]),
    fixTarget: z
      .object({ file: z.string(), field: z.string().optional(), value: z.unknown().optional() })
      .strict(),
  })
  .strict();

const validationResultSchema = z
  .object({
    passed: z.boolean(),
    errors: z.array(validationIssueSchema),
    warnings: z.array(validationIssueSchema),
    infos: z.array(validationIssueSchema),
  })
  .strict();

const providerCallLedgerEntrySchema = z
  .object({
    phase: z.enum(['pass1', 'pass2', 'pass2_verify']),
    attempt: z.number().int().positive(),
    outcome: z.enum(['success', 'failure']),
    requestHash: contentHashSchema,
    model: nonEmptyString,
    seed: z.number().int().nullable(),
    failureReason: z.string().optional(),
  })
  .strict();

const messageSchema = z
  .object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })
  .strict();

const renderRequestRecordSchema = z
  .object({
    phase: z.enum(['pass1', 'pass2']),
    attempt: z.number().int().positive(),
    requestHash: contentHashSchema,
    messages: z.array(messageSchema),
    responseContent: z.string().nullable().optional(),
  })
  .strict();

export const sceneRevisionEnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    revisionId: uuidSchema,
    parentRevisionId: uuidSchema.nullable(),
    restoredFromRevisionId: uuidSchema.optional(),
    operationId: uuidSchema,
    planHash: contentHashSchema,
    actorId: nonEmptyString,
    eventId: nonEmptyString,
    origin: z.enum(['llm_draft', 'llm_revision', 'human_edit', 'rollback']),
    prose: z.string(),
    proseHash: contentHashSchema,
    sceneHash: contentHashSchema,
    editorialBasisHash: contentHashSchema,
    scopeHash: contentHashSchema,
    validationIdentity: nonEmptyString,
    modelUsed: z.string().optional(),
    feedbackHash: contentHashSchema.nullable(),
    reviewIds: z.array(nonEmptyString),
    analysis: z.lazy(() => analysisResultSchema).nullable(),
    validation: validationResultSchema.nullable(),
    releaseDecision: releaseDecisionSchema,
    released: z.boolean(),
    cacheHit: z.boolean(),
    errors: z.array(z.string()),
    llmPass1: tokenUsageSchema,
    llmPass2: tokenUsageSchema.nullable(),
    attempts: z.number().int().nonnegative(),
    needsReview: z.boolean(),
    promptHash: contentHashSchema,
    pass2Rejection: z.enum(['empty', 'parse', 'validation']).optional(),
    providerCalls: z.array(providerCallLedgerEntrySchema),
    promotionReadSet: z.array(transactionReadExpectationSchema),
    requestRecords: z.array(renderRequestRecordSchema),
    createdAt: isoDateSchema,
  })
  .strict();

const sourceRevisionDocumentV1Schema = z
  .object({
    path: nonEmptyString,
    beforeHash: contentHashSchema.nullable(),
    afterHash: contentHashSchema.nullable(),
    beforeContent: z.string().nullable(),
    afterContent: z.string().nullable(),
  })
  .strict();

export const sourceRevisionV1Schema = z
  .object({
    version: z.literal(1),
    revisionId: uuidSchema,
    parentRevisionId: uuidSchema.nullable(),
    operationId: uuidSchema,
    actorId: nonEmptyString,
    origin: z.enum(['api_edit', 'external_edit']),
    note: z.string().optional(),
    projectBeforeHash: contentHashSchema,
    projectAfterHash: contentHashSchema,
    changeSetHash: contentHashSchema,
    documents: z.array(sourceRevisionDocumentV1Schema).min(1),
    affectedEventIds: z.array(nonEmptyString),
    createdAt: isoDateSchema,
  })
  .strict();

export const sourceHeadV1Schema = z
  .object({
    version: z.literal(1),
    revisionId: uuidSchema.nullable(),
    projectSourceHash: contentHashSchema,
    documents: z.record(z.string(), contentHashSchema),
  })
  .strict();

const sceneEditHistoryEntryV1Schema = z
  .object({
    action: z.enum([
      'llm_generated',
      'llm_revised',
      'human_adopted',
      'locked',
      'unlocked',
      'rollback',
    ]),
    actor_id: nonEmptyString,
    operation_id: uuidSchema,
    timestamp: isoDateSchema,
    note: z.string().optional(),
    revision_id: uuidSchema.optional(),
    review_ids: z.array(nonEmptyString).optional(),
  })
  .strict();

export const sceneMetadataV1Schema = z
  .object({
    schema_version: z.literal(1),
    event: nonEmptyString,
    narrative_order: z.number().int(),
    revision_id: uuidSchema,
    prose_source: z.enum(['llm', 'human_edited', 'human_locked']),
    prose_hash: contentHashSchema,
    scene_hash: contentHashSchema,
    editorial_basis_hash: contentHashSchema,
    scope_hash: contentHashSchema,
    validation_identity: nonEmptyString,
    model_used: z.string().optional(),
    rendered_at: isoDateSchema,
    word_count: z.number().int().nonnegative(),
    text_count_version: z.number().int().positive(),
    edit_history: z.array(sceneEditHistoryEntryV1Schema),
    branch_existence: branchSetV1Schema,
    player_choices: gameDialogueChoicesSchema.optional(),
  })
  .strict();

export const publicationManifestV1Schema = z
  .object({
    version: z.literal(1),
    status: z.enum(['current', 'stale']),
    branch_scope_hash: nonEmptyString,
    novel_hash: contentHashSchema.nullable(),
    revision_ids: z.record(z.string(), uuidSchema),
    last_assembled_at: isoDateSchema.nullable(),
    active_operation_id: uuidSchema.optional(),
    reasons: z.array(editorialErrorSchema),
  })
  .strict();

export const sceneSelectorSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('events'), eventIds: z.array(nonEmptyString).min(1) }).strict(),
    z.object({ type: z.literal('chapter'), chapter: z.number().int().positive() }).strict(),
    z.object({ type: z.literal('all') }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.type === 'events' && new Set(value.eventIds).size !== value.eventIds.length) {
      context.addIssue({ code: 'custom', message: 'eventIds must be unique' });
    }
  });

const revisionRequestSchema = z
  .object({
    reviewIds: z.array(nonEmptyString).min(1).optional(),
    instruction: nonEmptyString.optional(),
  })
  .strict();

const waiverRecordSchema = z
  .object({
    gateId: nonEmptyString,
    signedBy: nonEmptyString,
    signedAt: isoDateSchema,
    reason: nonEmptyString,
  })
  .strict();

export const editorialRenderRequestV1Schema = z
  .object({
    version: z.literal(1),
    projectDir: nonEmptyString,
    selector: sceneSelectorSchema.optional(),
    revision: revisionRequestSchema.optional(),
    mutation: editorialMutationContextSchema,
    model: nonEmptyString.optional(),
    providerProfile: nonEmptyString.optional(),
    branchPath: branchPathV1Schema.optional(),
    discourseBranch: nonEmptyString.optional(),
    waivers: z.array(waiverRecordSchema).optional(),
    batch: z
      .object({
        batchSize: z.number().int().positive().optional(),
        windowSize: z.number().int().positive().optional(),
        failFast: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maxRounds: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Strict schema for preview requests — same as editorialRenderRequestV1Schema
 * but without the required `mutation` field. Preview does not need a mutation
 * context because it performs no writes.
 */
export const editorialPreviewRequestV1Schema = z
  .object({
    version: z.literal(1),
    projectDir: nonEmptyString,
    selector: sceneSelectorSchema.optional(),
    revision: revisionRequestSchema.optional(),
    model: nonEmptyString.optional(),
    providerProfile: nonEmptyString.optional(),
    branchPath: branchPathV1Schema.optional(),
    discourseBranch: nonEmptyString.optional(),
    waivers: z.array(waiverRecordSchema).optional(),
    batch: z
      .object({
        batchSize: z.number().int().positive().optional(),
        windowSize: z.number().int().positive().optional(),
        failFast: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maxRounds: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Strict schema for game dialogue tree render requests — same as
 * editorialRenderRequestV1Schema but without selector, revision, branchPath,
 * or discourseBranch (mirrors the RenderGameDialogueTreeRequestV1 type).
 */
export const renderGameDialogueTreeRequestV1Schema = z
  .object({
    version: z.literal(1),
    projectDir: nonEmptyString,
    mutation: editorialMutationContextSchema,
    model: nonEmptyString.optional(),
    providerProfile: nonEmptyString.optional(),
    waivers: z.array(waiverRecordSchema).optional(),
    batch: z
      .object({
        batchSize: z.number().int().positive().optional(),
        windowSize: z.number().int().positive().optional(),
        failFast: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maxRounds: z.number().int().positive().optional(),
  })
  .strict();

export const editorialScopedRequestV1Schema = z
  .object({
    version: z.literal(1),
    projectDir: nonEmptyString,
    model: nonEmptyString.optional(),
    providerProfile: nonEmptyString.optional(),
    branchPath: branchPathV1Schema.optional(),
    discourseBranch: nonEmptyString.optional(),
    waivers: z.array(waiverRecordSchema).optional(),
  })
  .strict();

export const sourceDocumentChangeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('put'),
      path: nonEmptyString,
      expectedHash: contentHashSchema.nullable(),
      content: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal('delete'), path: nonEmptyString, expectedHash: contentHashSchema })
    .strict(),
]);

export const sourceChangeSetV1Schema = z
  .object({
    version: z.literal(1),
    expectedProjectSourceHash: contentHashSchema,
    changes: z.array(sourceDocumentChangeSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = value.changes.map((change) => change.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', message: 'Source change paths must be unique' });
    }
  });

export const sourceChangePreviewV1Schema = z
  .object({
    version: z.literal(1),
    changeSet: sourceChangeSetV1Schema,
    previewToken: contentHashSchema,
    documents: z.array(
      z
        .object({
          path: nonEmptyString,
          beforeContent: z.string().nullable(),
          afterContent: z.string().nullable(),
        })
        .strict(),
    ),
    projectBeforeHash: contentHashSchema,
    projectAfterHash: contentHashSchema,
    affectedEventIds: z.array(nonEmptyString),
    validation: z.object({ valid: z.boolean(), errors: z.array(editorialErrorSchema) }).strict(),
  })
  .strict();

export const editorialProgressEventV1Schema = z
  .object({
    version: z.literal(1),
    operationId: uuidSchema,
    sequence: z.number().int().positive(),
    timestamp: isoDateSchema,
    kind: z.enum([
      'operation_started',
      'scene_started',
      'cache_hit',
      'provider_started',
      'candidate_archived',
      'scene_promoted',
      'publication_updated',
      'operation_completed',
      'operation_failed',
      'operation_cancelled',
    ]),
    eventId: z.string().optional(),
    phase: z.enum(['pass1', 'pass2', 'promotion', 'publication']).optional(),
    completedScenes: z.number().int().nonnegative().optional(),
    totalScenes: z.number().int().nonnegative().optional(),
    disposition: z
      .enum([
        'candidate_promoted',
        'candidate_blocked',
        'candidate_pending_waiver',
        'candidate_stale',
        'head_reused',
        'locked_reused',
        'no_revision_needed',
        'skipped_by_lock',
        'preflight_failed',
        'cancelled',
      ])
      .optional(),
  })
  .strict();

const publicationResultSchema = z
  .object({
    status: z.enum(['current', 'stale', 'unchanged']),
    outputPath: z.string(),
    novelHash: contentHashSchema.nullable(),
    reasons: z.array(editorialErrorSchema),
  })
  .strict();

const sceneResultSchema = z
  .object({
    eventId: nonEmptyString,
    prose: z.string(),
    wordCount: z.number().int().nonnegative(),
    cacheHit: z.boolean(),
    released: z.boolean(),
    revisionId: uuidSchema.nullable(),
    promoted: z.boolean(),
    locked: z.boolean(),
    disposition: z.enum([
      'candidate_promoted',
      'candidate_blocked',
      'candidate_pending_waiver',
      'candidate_stale',
      'head_reused',
      'locked_reused',
      'no_revision_needed',
      'skipped_by_lock',
      'preflight_failed',
      'cancelled',
    ]),
    releaseDecision: releaseDecisionSchema.nullable(),
    analysis: z.lazy(() => analysisResultSchema).nullable(),
    validationErrors: z.number().int().nonnegative(),
    validationIssueMessages: z.array(z.string()),
    providerCalls: z.array(providerCallLedgerEntrySchema),
    promptHash: contentHashSchema,
    pass2Rejection: z.string().optional(),
    errors: z.array(z.string()),
    editorialErrors: z.array(editorialErrorSchema),
  })
  .strict();

const renderResultSchema = z
  .object({
    operationId: uuidSchema,
    results: z.array(sceneResultSchema),
    errors: z.array(z.string()),
    editorialErrors: z.array(editorialErrorSchema),
    publication: publicationResultSchema,
  })
  .strict();

const treeResultSchema = z
  .object({
    operationId: uuidSchema,
    tree: z
      .object({
        eventScopes: z.record(z.string(), branchSetV1Schema),
        representativePathByEventId: z.record(z.string(), branchPathV1Schema),
        choicesByEventId: z.record(z.string(), gameDialogueChoicesSchema),
      })
      .strict(),
    results: z.array(sceneResultSchema),
    errors: z.array(z.string()),
    editorialErrors: z.array(editorialErrorSchema),
    dialogueTree: z.string().optional(),
    outputPath: z.string().optional(),
    publication: publicationResultSchema,
  })
  .strict();

const sourceResultSchema = z
  .object({
    operationId: uuidSchema,
    sourceRevisionId: uuidSchema,
    projectSourceHash: contentHashSchema,
    changedDocuments: z.array(
      z
        .object({
          path: nonEmptyString,
          contentHash: contentHashSchema.nullable(),
        })
        .strict(),
    ),
    affectedEventIds: z.array(nonEmptyString),
    publication: publicationResultSchema,
  })
  .strict();

const sceneActionResultSchema = z
  .object({
    operationId: uuidSchema,
    eventId: nonEmptyString,
    revisionId: uuidSchema.nullable(),
    proseHash: contentHashSchema.nullable(),
    sceneHash: contentHashSchema.nullable(),
    proseSource: z.enum(['llm', 'human_edited', 'human_locked']).nullable(),
    locked: z.boolean(),
    released: z.boolean(),
    promoted: z.boolean(),
    releaseDecision: releaseDecisionSchema.nullable(),
    publication: publicationResultSchema,
    editorialErrors: z.array(editorialErrorSchema),
  })
  .strict();

const assembleResultSchema = z
  .object({
    operationId: uuidSchema,
    markdown: z.string(),
    wordCount: z.number().int().nonnegative(),
    sceneCount: z.number().int().nonnegative(),
    publication: publicationResultSchema,
  })
  .strict();

export const editorialOperationV1Schema = z
  .object({
    version: z.literal(1),
    operationId: uuidSchema,
    kind: z.enum([
      'render',
      'revise',
      'render_tree',
      'adopt_scene',
      'rollback_scene',
      'assemble',
      'apply_source',
      'set_scene_lock',
      'add_review',
      'replace_review',
      'update_review',
    ]),
    actorId: nonEmptyString,
    requestHash: contentHashSchema,
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    startedAt: isoDateSchema,
    heartbeatAt: isoDateSchema,
    leaseExpiresAt: isoDateSchema,
    lastSequence: z.number().int().nonnegative().optional(),
    completedAt: isoDateSchema.optional(),
    errors: z.array(editorialErrorSchema),
    result: z
      .union([
        renderResultSchema,
        treeResultSchema,
        sceneActionResultSchema,
        sourceResultSchema,
        assembleResultSchema,
        reviewCommentSchema,
      ])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result === null) return;
    const schema =
      value.kind === 'render' || value.kind === 'revise'
        ? renderResultSchema
        : value.kind === 'render_tree'
          ? treeResultSchema
          : value.kind === 'assemble'
            ? assembleResultSchema
            : value.kind === 'apply_source'
              ? sourceResultSchema
              : value.kind === 'add_review' ||
                  value.kind === 'replace_review' ||
                  value.kind === 'update_review'
                ? reviewCommentSchema
                : sceneActionResultSchema;
    const parsed = schema.safeParse(value.result);
    if (!parsed.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: `Result does not match operation kind: ${parsed.error.message}`,
      });
    }
  });
