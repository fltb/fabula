import { z } from 'zod/v3';
import type { JsonValue } from '../contracts/json.js';
import type {
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDiagnosticV1,
  SourceDocumentV1,
  SourceParseResultV1,
} from '../contracts/source.js';
import type {
  AcceptedArtifactRecord,
  AcceptedSceneRecord,
  CommitSuccess,
  OperationRecord,
  PublicationRecord,
  ReviewRecord,
  SceneRevisionRecord,
  TraceRecord,
  VersionConflict,
} from '../ports/execution-repository.js';
import type { LayeredCacheKey, RenderCacheRecord } from '../ports/render-cache-repository.js';
import type {
  StateAppendSuccess,
  StateEvent,
  StateLogReadResult,
  StateSnapshotRecord,
  StateSnapshotWriteSuccess,
  StateStreamKey,
  StateVersionConflict,
} from '../ports/state-repository.js';
import { hasAnalysisResultShape } from './analysis.ts';

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const logicalPathSchema = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith('/') && !v.includes('\\'))
  .refine((v) => v.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..'));
const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const identifierSchema = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0);
const versionSchema = z.literal(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const sourceDiagnosticV1Schema: z.ZodType<SourceDiagnosticV1> = z
  .object({
    code: identifierSchema,
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    logicalPath: logicalPathSchema.nullable(),
  })
  .strict();
export const sourceParseResultV1Schema: z.ZodType<SourceParseResultV1> = z
  .object({
    status: z.enum(['parsed', 'invalid', 'not_applicable']),
    value: jsonValueSchema.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.status === 'parsed' && v.value === null)
      c.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Parsed results require a JSON value',
      });
    if (v.status !== 'parsed' && v.value !== null)
      c.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Only parsed results may contain a value',
      });
  });
export const sourceDocumentV1Schema: z.ZodType<SourceDocumentV1> = z
  .object({
    version: versionSchema,
    logicalPath: logicalPathSchema,
    content: z.string(),
    contentHash: hashSchema,
    parseResult: sourceParseResultV1Schema,
    diagnostics: z.array(sourceDiagnosticV1Schema),
  })
  .strict();
const orderedDocuments = (docs: readonly SourceDocumentV1[], c: z.RefinementCtx) => {
  const seen = new Set<string>();
  docs.forEach((d, i) => {
    if (seen.has(d.logicalPath))
      c.addIssue({
        code: 'custom',
        path: ['documents', i],
        message: 'Document paths must be unique',
      });
    seen.add(d.logicalPath);
    if (i > 0 && docs[i - 1].logicalPath >= d.logicalPath)
      c.addIssue({ code: 'custom', path: ['documents', i], message: 'Documents must be sorted' });
  });
};
export const projectSourceSnapshotV1Schema: z.ZodType<ProjectSourceSnapshotV1> = z
  .object({
    version: versionSchema,
    documents: z.array(sourceDocumentV1Schema),
    sourceHash: hashSchema,
  })
  .strict()
  .superRefine((v, c) => orderedDocuments(v.documents, c));
export const sourceChangeV1Schema: z.ZodType<SourceChangeV1> = z
  .object({
    logicalPath: logicalPathSchema,
    beforeContent: z.string().nullable(),
    beforeHash: hashSchema.nullable(),
    afterContent: z.string().nullable(),
    afterHash: hashSchema.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.beforeContent === null) !== (v.beforeHash === null))
      c.addIssue({ code: 'custom', path: ['beforeHash'], message: 'before pairing' });
    if ((v.afterContent === null) !== (v.afterHash === null))
      c.addIssue({ code: 'custom', path: ['afterHash'], message: 'after pairing' });
  });
export const sourceAnalysisV1Schema: z.ZodType<SourceAnalysisV1> = z
  .object({
    version: versionSchema,
    current: projectSourceSnapshotV1Schema,
    candidate: projectSourceSnapshotV1Schema,
    changes: z.array(sourceChangeV1Schema),
    affectedEventIds: z.array(identifierSchema),
    diagnostics: z.array(sourceDiagnosticV1Schema),
  })
  .strict();

export const stateStreamKeySchema: z.ZodType<StateStreamKey> = z
  .object({ projectId: identifierSchema, streamId: identifierSchema, branchId: identifierSchema })
  .strict();
export const stateEventSchema: z.ZodType<StateEvent> = z
  .object({
    eventId: identifierSchema,
    sequence: nonnegativeIntegerSchema,
    type: identifierSchema,
    payload: jsonValueSchema,
  })
  .strict();
export const acceptedSceneRecordSchema: z.ZodType<AcceptedSceneRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    eventId: identifierSchema,
    sourceHash: hashSchema,
    revisionId: identifierSchema,
    prose: z.string(),
    proseHash: hashSchema,
    sceneHash: hashSchema,
    value: jsonValueSchema.optional(),
  })
  .strict();
export const sceneRevisionRecordSchema: z.ZodType<SceneRevisionRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    eventId: identifierSchema,
    revisionId: identifierSchema,
    parentRevisionId: identifierSchema.nullable(),
    sourceHash: hashSchema,
    value: jsonValueSchema,
  })
  .strict();
export const reviewRecordSchema: z.ZodType<ReviewRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    reviewId: identifierSchema,
    value: jsonValueSchema,
  })
  .strict();
export const publicationRecordSchema: z.ZodType<PublicationRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    sourceHash: hashSchema,
    value: jsonValueSchema,
  })
  .strict();
export const operationRecordSchema: z.ZodType<OperationRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    operationId: identifierSchema,
    value: jsonValueSchema,
  })
  .strict();
export const traceRecordSchema: z.ZodType<TraceRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    operationId: identifierSchema,
    value: jsonValueSchema,
  })
  .strict();
export const acceptedArtifactRecordSchema: z.ZodType<AcceptedArtifactRecord> = z
  .object({
    version: versionSchema,
    projectId: identifierSchema,
    eventId: identifierSchema,
    revisionId: identifierSchema,
    sourceHash: hashSchema,
    prose: z.string(),
    proseHash: hashSchema,
    sceneHash: hashSchema,
  })
  .strict();
export const versionConflictSchema: z.ZodType<VersionConflict> = z
  .object({
    kind: z.literal('conflict'),
    expectedVersion: nonnegativeIntegerSchema.nullable(),
    actualVersion: nonnegativeIntegerSchema.nullable(),
  })
  .strict();
export const commitSuccessSchema: z.ZodType<CommitSuccess<JsonValue>> = z
  .object({
    kind: z.literal('committed'),
    version: nonnegativeIntegerSchema,
    value: jsonValueSchema,
  })
  .strict();
export const layeredCacheKeySchema: z.ZodType<LayeredCacheKey> = z
  .object({
    version: versionSchema,
    sourceHash: hashSchema,
    layers: z.record(identifierSchema, identifierSchema),
  })
  .strict();
export const renderCacheRecordSchema: z.ZodType<RenderCacheRecord> = z
  .object({
    version: versionSchema,
    key: layeredCacheKeySchema,
    recordHash: hashSchema,
    output: jsonValueSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.key.version !== v.version)
      c.addIssue({
        code: 'custom',
        path: ['key', 'version'],
        message: 'Cache key and record versions must agree',
      });
    if (typeof v.output !== 'object' || v.output === null || Array.isArray(v.output)) {
      c.addIssue({ code: 'custom', path: ['output'], message: 'Cache output must be an object' });
      return;
    }
    const output = v.output as Record<string, unknown>;
    if (typeof output.prose !== 'string' || output.prose.length === 0)
      c.addIssue({
        code: 'custom',
        path: ['output', 'prose'],
        message: 'Cache output requires prose',
      });
    if (!hasAnalysisResultShape(output.analysis))
      c.addIssue({
        code: 'custom',
        path: ['output', 'analysis'],
        message: 'Cache output requires a complete Pass 2 analysis envelope',
      });
  });
const orderedStateEvents = (events: readonly StateEvent[], c: z.RefinementCtx) => {
  const ids = new Set<string>();
  events.forEach((e, i) => {
    if (ids.has(e.eventId))
      c.addIssue({ code: 'custom', path: [i], message: 'Event IDs must be unique' });
    ids.add(e.eventId);
    if (i > 0 && events[i - 1].sequence >= e.sequence)
      c.addIssue({ code: 'custom', path: [i], message: 'Events must be ordered' });
  });
};
export const stateLogReadResultSchema: z.ZodType<StateLogReadResult> = z
  .object({
    key: stateStreamKeySchema,
    events: z.array(stateEventSchema),
    version: nonnegativeIntegerSchema,
    firstSequence: nonnegativeIntegerSchema.nullable(),
    lastSequence: nonnegativeIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((v, c) => orderedStateEvents(v.events, c));
export const stateAppendSuccessSchema: z.ZodType<StateAppendSuccess> = z
  .object({
    kind: z.literal('appended'),
    version: nonnegativeIntegerSchema,
    events: z.array(stateEventSchema),
  })
  .strict()
  .superRefine((v, c) => orderedStateEvents(v.events, c));
export const stateVersionConflictSchema: z.ZodType<StateVersionConflict> = z
  .object({
    kind: z.literal('conflict'),
    expectedVersion: nonnegativeIntegerSchema.nullable(),
    actualVersion: nonnegativeIntegerSchema.nullable(),
  })
  .strict();
export const stateSnapshotRecordSchema: z.ZodType<StateSnapshotRecord> = z
  .object({
    version: versionSchema,
    key: stateStreamKeySchema,
    schema: identifierSchema,
    schemaVersion: positiveIntegerSchema,
    sequence: nonnegativeIntegerSchema,
    state: jsonValueSchema,
    snapshotHash: hashSchema,
  })
  .strict();
export const stateSnapshotWriteSuccessSchema: z.ZodType<StateSnapshotWriteSuccess> = z
  .object({
    kind: z.literal('saved'),
    sequence: nonnegativeIntegerSchema,
    version: nonnegativeIntegerSchema,
  })
  .strict();
export const commitResultSchema = z.union([commitSuccessSchema, versionConflictSchema]);
export const stateAppendResultSchema = z.union([
  stateAppendSuccessSchema,
  stateVersionConflictSchema,
]);
export const stateSnapshotWriteResultSchema = z.union([
  stateSnapshotWriteSuccessSchema,
  stateVersionConflictSchema,
]);

export type CoreContractSchemas = {
  projectSourceSnapshotV1Schema: typeof projectSourceSnapshotV1Schema;
  sourceDocumentV1Schema: typeof sourceDocumentV1Schema;
  sourceParseResultV1Schema: typeof sourceParseResultV1Schema;
  sourceDiagnosticV1Schema: typeof sourceDiagnosticV1Schema;
  sourceChangeV1Schema: typeof sourceChangeV1Schema;
  sourceAnalysisV1Schema: typeof sourceAnalysisV1Schema;
  stateStreamKeySchema: typeof stateStreamKeySchema;
  stateEventSchema: typeof stateEventSchema;
  acceptedSceneRecordSchema: typeof acceptedSceneRecordSchema;
  sceneRevisionRecordSchema: typeof sceneRevisionRecordSchema;
  reviewRecordSchema: typeof reviewRecordSchema;
  publicationRecordSchema: typeof publicationRecordSchema;
  operationRecordSchema: typeof operationRecordSchema;
  traceRecordSchema: typeof traceRecordSchema;
  acceptedArtifactRecordSchema: typeof acceptedArtifactRecordSchema;
  versionConflictSchema: typeof versionConflictSchema;
  commitSuccessSchema: typeof commitSuccessSchema;
  commitResultSchema: typeof commitResultSchema;
  layeredCacheKeySchema: typeof layeredCacheKeySchema;
  renderCacheRecordSchema: typeof renderCacheRecordSchema;
  stateLogReadResultSchema: typeof stateLogReadResultSchema;
  stateAppendSuccessSchema: typeof stateAppendSuccessSchema;
  stateVersionConflictSchema: typeof stateVersionConflictSchema;
  stateAppendResultSchema: typeof stateAppendResultSchema;
  stateSnapshotRecordSchema: typeof stateSnapshotRecordSchema;
  stateSnapshotWriteSuccessSchema: typeof stateSnapshotWriteSuccessSchema;
  stateSnapshotWriteResultSchema: typeof stateSnapshotWriteResultSchema;
};
