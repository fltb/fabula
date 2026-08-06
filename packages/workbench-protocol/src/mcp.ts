export type McpScopeV1 =
  | 'mcp:read'
  | 'mcp:render'
  | 'mcp:author'
  | 'mcp:submit'
  | 'mcp:reference:read'
  | 'mcp:reference:write'
  | 'mcp:admin';

export const MCP_SCOPES_V1: readonly McpScopeV1[] = [
  'mcp:read',
  'mcp:render',
  'mcp:author',
  'mcp:submit',
  'mcp:reference:read',
  'mcp:reference:write',
  'mcp:admin',
];

export const AUTHORING_DOCUMENT_LIMITS_V1 = {
  defaultReadCharacters: 64 * 1024,
  maxReadCharacters: 256 * 1024,
  maxEditBytes: 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
} as const;

export interface McpJsonSchemaProperty {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: McpJsonSchemaProperty;
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, McpJsonSchemaProperty>>;
  readonly required?: readonly string[];
}

export interface McpJsonSchemaV1 {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, McpJsonSchemaProperty>>;
  readonly required?: readonly string[];
}

export interface McpToolDescriptorV1 {
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly scopes: readonly McpScopeV1[];
  readonly inputSchema: McpJsonSchemaV1;
  readonly outputSchema: McpJsonSchemaV1;
}

const EMPTY_SCHEMA: McpJsonSchemaV1 = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};
const RESULT_SCHEMA: McpJsonSchemaV1 = {
  type: 'object',
  additionalProperties: false,
  properties: { result: { type: 'object', additionalProperties: false, properties: {} } },
  required: ['result'],
};
const string = { type: 'string', minLength: 1 };
const nullableString = { type: ['string', 'null'] };
const authoringVersion = { type: 'number', const: 2 };
/** Wire version of the canonical graph route selector (WorkbenchGraphViewVersion). */
const graphViewVersion = { type: 'number', const: 1 };

/**
 * Bounds are part of the wire contract, rather than implementation hints.
 * Reference routes are project-scoped by the Host, so no project path or
 * caller identity is accepted by any reference tool.
 */
export const REFERENCE_MCP_LIMITS_V1 = {
  maxReferenceIdLength: 128,
  maxNameLength: 256,
  maxMediaTypeLength: 128,
  maxMetadataTextLength: 4096,
  maxIdempotencyKeyLength: 128,
  maxCursorLength: 256,
  maxPageSize: 50,
  maxQueryLength: 256,
  maxTagCount: 64,
  maxTagLength: 128,
  maxAuthorCount: 64,
  maxAuthorLength: 256,
  maxReferenceBytes: 1_073_741_824,
  maxOffset: 1_073_741_824,
  maxRangeBytes: 1_048_576,
  maxChunkBytes: 1_048_576,
  maxChunkBase64Length: 1_398_104,
  maxLocatorLength: 512,
  maxQuoteLength: 4096,
  maxCitations: 32,
} as const;

const referenceVersion = { type: 'number', const: 1 };
const referenceId = {
  type: 'string',
  minLength: 1,
  maxLength: REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
};
const referenceName = {
  type: 'string',
  minLength: 1,
  maxLength: REFERENCE_MCP_LIMITS_V1.maxNameLength,
};
const mediaType = {
  type: 'string',
  minLength: 1,
  maxLength: REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength,
};
const hash = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' };
const offset = {
  type: 'integer',
  minimum: 0,
  maximum: REFERENCE_MCP_LIMITS_V1.maxOffset,
};
const rangeLength = {
  type: 'integer',
  minimum: 1,
  maximum: REFERENCE_MCP_LIMITS_V1.maxRangeBytes,
};
const pageSize = {
  type: 'integer',
  minimum: 1,
  maximum: REFERENCE_MCP_LIMITS_V1.maxPageSize,
};
const cursor = { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxCursorLength };

function objectProperty(
  properties: Record<string, McpJsonSchemaProperty>,
  required: readonly string[] = [],
): McpJsonSchemaProperty {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function arrayProperty(
  items: McpJsonSchemaProperty,
  minItems = 0,
  maxItems?: number,
): McpJsonSchemaProperty {
  return {
    type: 'array',
    ...(minItems > 0 ? { minItems } : {}),
    ...(maxItems === undefined ? {} : { maxItems }),
    items,
  };
}

function schema(
  properties: Record<string, McpJsonSchemaProperty>,
  required: readonly string[] = [],
): McpJsonSchemaV1 {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
const boundedMetadataText = {
  type: 'string',
  minLength: 1,
  maxLength: REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength,
};
const nullableMetadataText = {
  type: ['string', 'null'],
  maxLength: REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength,
};
const referenceRangeProperty = objectProperty(
  { version: referenceVersion, offset, length: rangeLength },
  ['version', 'offset', 'length'],
);
const referenceItemProperty = objectProperty(
  {
    version: referenceVersion,
    referenceId,
    displayName: referenceName,
    originalName: referenceName,
    mediaType,
    contentHash: hash,
    byteLength: {
      type: 'integer',
      minimum: 0,
      maximum: REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
    },
    title: nullableMetadataText,
    authors: arrayProperty(
      { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxAuthorLength },
      0,
      REFERENCE_MCP_LIMITS_V1.maxAuthorCount,
    ),
    sourceUrl: nullableMetadataText,
    license: nullableMetadataText,
    tags: arrayProperty(
      { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxTagLength },
      0,
      REFERENCE_MCP_LIMITS_V1.maxTagCount,
    ),
    createdAt: boundedMetadataText,
    updatedAt: boundedMetadataText,
  },
  [
    'version',
    'referenceId',
    'displayName',
    'originalName',
    'mediaType',
    'contentHash',
    'byteLength',
    'title',
    'authors',
    'sourceUrl',
    'license',
    'tags',
    'createdAt',
    'updatedAt',
  ],
);
const referenceChunkProperty = objectProperty(
  {
    version: referenceVersion,
    referenceId,
    chunkId: referenceId,
    ordinal: { type: 'integer', minimum: 0, maximum: REFERENCE_MCP_LIMITS_V1.maxOffset },
    range: referenceRangeProperty,
    byteLength: {
      type: 'integer',
      minimum: 1,
      maximum: REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
    },
    contentHash: hash,
    chunkHash: hash,
    locator: { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxLocatorLength },
    quote: {
      type: ['string', 'null'],
      maxLength: REFERENCE_MCP_LIMITS_V1.maxQuoteLength,
    },
  },
  [
    'version',
    'referenceId',
    'chunkId',
    'ordinal',
    'range',
    'byteLength',
    'contentHash',
    'chunkHash',
    'locator',
    'quote',
  ],
);
const referenceContentProperty = objectProperty(
  {
    version: referenceVersion,
    referenceId,
    mediaType,
    contentHash: hash,
    byteLength: {
      type: 'integer',
      minimum: 0,
      maximum: REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
    },
    range: referenceRangeProperty,
    dataBase64: {
      type: 'string',
      minLength: 1,
      maxLength: REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length,
    },
    nextOffset: {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: REFERENCE_MCP_LIMITS_V1.maxOffset,
    },
  },
  [
    'version',
    'referenceId',
    'mediaType',
    'contentHash',
    'byteLength',
    'range',
    'dataBase64',
    'nextOffset',
  ],
);
const _referenceCitationProperty = objectProperty(
  {
    version: referenceVersion,
    citationId: referenceId,
    referenceId,
    chunkId: referenceId,
    contentHash: hash,
    chunkHash: hash,
    quote: { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxQuoteLength },
    locator: { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxLocatorLength },
    authoritative: { type: 'boolean', const: false },
  },
  [
    'version',
    'citationId',
    'referenceId',
    'chunkId',
    'contentHash',
    'chunkHash',
    'quote',
    'locator',
    'authoritative',
  ],
);
const referenceJobProperty = objectProperty(
  {
    version: referenceVersion,
    jobId: referenceId,
    operation: { type: 'string', enum: ['import', 'delete', 'retry'] },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    referenceId: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
    },
    bytesReceived: {
      type: 'integer',
      minimum: 0,
      maximum: REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
    },
    totalBytes: {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
    },
    contentHash: {
      type: ['string', 'null'],
      minLength: 64,
      maxLength: 64,
      pattern: '^[0-9a-f]{64}$',
    },
    errorCode: nullableMetadataText,
    errorMessage: nullableMetadataText,
    createdAt: boundedMetadataText,
    updatedAt: boundedMetadataText,
  },
  [
    'version',
    'jobId',
    'operation',
    'status',
    'referenceId',
    'bytesReceived',
    'totalBytes',
    'contentHash',
    'errorCode',
    'errorMessage',
    'createdAt',
    'updatedAt',
  ],
);

function referenceResult(
  properties: Record<string, McpJsonSchemaProperty>,
  required: readonly string[],
): McpJsonSchemaV1 {
  return schema(
    {
      result: objectProperty({ version: referenceVersion, ...properties }, [
        'version',
        ...required,
      ]),
    },
    ['result'],
  );
}

const adminVersion = { type: 'number', const: 1 };
const adminRole = { type: 'string', enum: ['reader', 'author', 'maintainer'] };
const adminTtlMs = { type: 'integer', minimum: 1, maximum: 2_592_000_000 };
const adminProjectId = { type: 'string', minLength: 1, maxLength: 4096 };
const adminProjectProperty = objectProperty(
  {
    projectId: adminProjectId,
    displayName: { type: 'string', minLength: 1, maxLength: 4096 },
    root: { type: 'string', minLength: 1, maxLength: 4096 },
  },
  ['projectId', 'displayName', 'root'],
);
const adminConfigurationProperty = objectProperty(
  {
    version: adminVersion,
    projects: { type: 'array', items: adminProjectProperty },
    defaultProjectId: { type: ['string', 'null'], maxLength: 4096 },
    provider: {
      ...objectProperty(
        {
          kind: { type: 'string', const: 'ai-sdk' },
          baseUrl: { type: ['string', 'null'], maxLength: 4096 },
          model: { type: ['string', 'null'], maxLength: 4096 },
        },
        ['kind', 'baseUrl', 'model'],
      ),
      type: ['object', 'null'],
    },
    network: objectProperty(
      {
        mode: { type: 'string', enum: ['loopback', 'lan', 'unix'] },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        allowedHosts: { type: 'array', items: { type: 'string', maxLength: 4096 } },
        allowedOrigins: { type: 'array', items: { type: 'string', maxLength: 4096 } },
        unixSocket: { type: ['string', 'null'], maxLength: 4096 },
      },
      ['mode', 'port', 'allowedHosts', 'allowedOrigins', 'unixSocket'],
    ),
  },
  ['version', 'projects', 'defaultProjectId', 'provider', 'network'],
);

/**
 * Strict scene selector shared by the three render-surface tools. The
 * discriminated union rejects keys that belong to the other variants, so
 * clients cannot smuggle cross-variant fields.
 */
const sceneSelectorProperty: McpJsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['all', 'chapter', 'events'] },
    chapter: { type: 'integer', minimum: 1, multipleOf: 1 },
    eventIds: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['type'],
};

/**
 * Strict canonical graph route selector (wire mirror of
 * `WorkbenchRouteSelectorV1`): exactly version + branchPath, with optional
 * discourseBranch. Unknown keys or wrong types are rejected by the schema and
 * again by the registry handler.
 */
const graphRouteSelectorProperty: McpJsonSchemaProperty = objectProperty(
  {
    version: graphViewVersion,
    branchPath: objectProperty(
      {
        decisions: {
          type: 'array',
          items: objectProperty(
            {
              atEventId: string,
              choiceId: string,
              narrativeOrder: { type: 'integer', minimum: 0 },
            },
            ['atEventId', 'choiceId', 'narrativeOrder'],
          ),
        },
      },
      ['decisions'],
    ),
    discourseBranch: string,
  },
  ['version', 'branchPath'],
);

/**
 * ISS snapshot carried by a working-layer validation (wire mirror of Core `ISSSnapshot`).
 */
// ─── Review & release-gate wire DTOs (plan Step 5) ───────────────────────────

/** Wire version shared by the six review/release-gate tools. */
const reviewVersion = { type: 'number', const: 1 };
const reviewCommentId = { type: 'string', minLength: 1, maxLength: 128 };
const reviewTargetType = {
  type: 'string',
  enum: ['novel', 'chapter', 'scene', 'line', 'character', 'worldrule'],
};
const reviewSeverity = { type: 'string', enum: ['nit', 'suggestion', 'blocking'] };
const reviewCategory = {
  type: 'string',
  enum: [
    'style',
    'pacing',
    'character_voice',
    'plot_logic',
    'world_consistency',
    'reader_experience',
  ],
};
const reviewCommentStatus = {
  type: 'string',
  enum: ['open', 'addressed', 'resolved', 'wontfix', 'superseded'],
};
const reviewCommentContent = { type: 'string', minLength: 1, maxLength: 65536 };
const reviewReason = { type: 'string', minLength: 1, maxLength: 4096 };
/** Strict review target selector (wire mirror of Core `NewReviewComment.target`). */
const reviewTargetProperty = objectProperty(
  {
    type: reviewTargetType,
    id: string,
    lineRange: arrayProperty({ type: 'integer', minimum: 1 }, 2, 2),
    lineBasis: objectProperty({ revisionId: string, proseHash: hash }, ['revisionId', 'proseHash']),
  },
  ['type', 'id'],
);
const reviewApplicationProperty = objectProperty(
  { eventId: string, revisionId: string, operationId: string, appliedAt: string },
  ['eventId', 'revisionId', 'operationId', 'appliedAt'],
);
/** Full projected comment (wire mirror of Core `ReviewComment`). */
const reviewCommentProperty = objectProperty(
  {
    id: reviewCommentId,
    author: { type: 'string', enum: ['human', 'llm'] },
    actorId: string,
    target: reviewTargetProperty,
    severity: reviewSeverity,
    category: reviewCategory,
    content: reviewCommentContent,
    status: reviewCommentStatus,
    applications: arrayProperty(reviewApplicationProperty, 0),
    supersedesId: nullableString,
    resolvedBy: nullableString,
    createdAt: string,
    resolvedAt: nullableString,
  },
  [
    'id',
    'author',
    'actorId',
    'target',
    'severity',
    'category',
    'content',
    'status',
    'applications',
    'supersedesId',
    'resolvedBy',
    'createdAt',
    'resolvedAt',
  ],
);
/** A recorded gate decision (wire mirror of Core `ReviewGateDecisionV1`). */
const reviewGateDecisionProperty = objectProperty(
  {
    gateId: string,
    decision: { type: 'string', enum: ['waived', 'rejected', 'accepted'] },
    revisionId: string,
    capabilityVersion: { type: 'integer', minimum: 1 },
    reason: reviewReason,
    actorId: string,
    createdAt: string,
  },
  ['gateId', 'decision', 'revisionId', 'capabilityVersion', 'reason', 'actorId', 'createdAt'],
);
/** Current gate state (wire mirror of Core `ReviewGateV1`). */
const reviewGateProperty = objectProperty(
  {
    gateId: string,
    sourceHash: hash,
    eventId: string,
    proseHash: hash,
    scopeHash: hash,
    validationIdentity: string,
    warningFingerprints: arrayProperty(string, 0),
    revisionId: string,
    openedAt: string,
    openedBy: string,
    status: { type: 'string', enum: ['open', 'decided', 'superseded'] },
    decision: { ...reviewGateDecisionProperty, type: ['object', 'null'] },
    supersededAt: nullableString,
    supersededBy: nullableString,
    supersedeReason: nullableString,
  },
  [
    'gateId',
    'sourceHash',
    'eventId',
    'proseHash',
    'scopeHash',
    'validationIdentity',
    'warningFingerprints',
    'revisionId',
    'openedAt',
    'openedBy',
    'status',
    'decision',
    'supersededAt',
    'supersededBy',
    'supersedeReason',
  ],
);
/** Re-evaluated release decision (wire mirror of Core `ReleaseDecision`). */
const releaseDecisionProperty = objectProperty(
  {
    status: { type: 'string', enum: ['accepted', 'pending_waiver', 'blocked'] },
    scopeHash: hash,
    validationIdentity: string,
    reasons: arrayProperty(string, 0),
    waiverId: nullableString,
    gateId: nullableString,
  },
  ['status', 'scopeHash', 'validationIdentity', 'reasons', 'waiverId', 'gateId'],
);
/** Gate resolution outcome (wire mirror of Core `ReleaseGateResolutionV1`). */
const releaseGateResolutionProperty = objectProperty(
  {
    version: reviewVersion,
    projectId: string,
    gateId: string,
    eventId: string,
    candidateRevisionId: string,
    outcome: { type: 'string', enum: ['accepted', 'rejected', 'stale', 'superseded'] },
    acceptedRevisionId: nullableString,
    decision: releaseDecisionProperty,
    reason: reviewReason,
    actorId: string,
    capabilityVersion: { type: 'integer', minimum: 1 },
    decidedAt: string,
  },
  [
    'version',
    'projectId',
    'gateId',
    'eventId',
    'candidateRevisionId',
    'outcome',
    'acceptedRevisionId',
    'decision',
    'reason',
    'actorId',
    'capabilityVersion',
    'decidedAt',
  ],
);

// ─── Publication wire DTOs (plan Step 6.6) ───────────────────────────────────

/**
 * Bounds of the publication MCP surface. `maxPublicationReadBytes` caps a
 * single `nova_publication_read` slice (a reader pages with offset/limit);
 * `maxPublicationIdLength`/`maxPublicationTitleLength` bound the identity and
 * title fields of `nova_publish` / `nova_publication_get`.
 */
export const PUBLICATION_MCP_LIMITS_V1 = {
  maxPublicationIdLength: 128,
  maxPublicationTitleLength: 256,
  maxPublicationReadBytes: 256 * 1024,
} as const;

/** Wire version shared by the three publication tools. */
const publicationVersion = { type: 'number', const: 1 };
const publicationId = {
  type: 'string',
  minLength: 1,
  maxLength: PUBLICATION_MCP_LIMITS_V1.maxPublicationIdLength,
};
const publicationTitle = {
  type: 'string',
  minLength: 1,
  maxLength: PUBLICATION_MCP_LIMITS_V1.maxPublicationTitleLength,
};
const publicationReadOffset = { type: 'integer', minimum: 0, maximum: 2_147_483_647 };
const publicationReadLimit = {
  type: 'integer',
  minimum: 1,
  maximum: PUBLICATION_MCP_LIMITS_V1.maxPublicationReadBytes,
};
/** Stored publication record value (project-relative paths only). */
const publicationValueProperty = objectProperty(
  {
    sourceHash: hash,
    scopeHash: hash,
    revisionIds: arrayProperty({ type: 'string', minLength: 1 }, 0),
    novelHash: hash,
    relativeOutputPath: string,
    byteLength: { type: 'integer', minimum: 0 },
    actorId: string,
    operationId: string,
    createdAt: string,
    status: { type: 'string', enum: ['current', 'stale'] },
  },
  [
    'sourceHash',
    'scopeHash',
    'revisionIds',
    'novelHash',
    'relativeOutputPath',
    'byteLength',
    'actorId',
    'operationId',
    'createdAt',
    'status',
  ],
);
/** One durable publication row (identity + value, never an absolute Host path). */
const publicationRecordProperty = objectProperty(
  {
    publicationId,
    kind: { type: 'string', enum: ['canonical', 'custom'] },
    value: publicationValueProperty,
    updatedAt: string,
  },
  ['publicationId', 'kind', 'value', 'updatedAt'],
);

const workingValidationIssProperty: McpJsonSchemaProperty = objectProperty(
  {
    overall: { type: 'number' },
    target: { type: 'number' },
    dimensions: arrayProperty(
      objectProperty(
        {
          name: string,
          score: { type: 'number' },
          max: { type: 'number' },
          threshold: { type: 'number' },
          status: { type: 'string', enum: ['green', 'yellow', 'red'] },
          gaps: arrayProperty(
            objectProperty(
              {
                entity: string,
                id: string,
                file: string,
                suggestion: string,
                fixAction: {
                  type: 'string',
                  enum: ['create_file', 'edit_file', 'add_field', 'change_value'],
                },
                fixTarget: string,
                template: string,
              },
              ['suggestion', 'fixAction', 'fixTarget'],
            ),
            0,
          ),
        },
        ['name', 'score', 'max', 'threshold', 'status', 'gaps'],
      ),
      0,
    ),
  },
  ['overall', 'target', 'dimensions'],
);

function inputFor(name: string): McpJsonSchemaV1 {
  if (name === 'nova_source_get') {
    return schema(
      {
        logicalPath: string,
        offset: { type: 'number', minimum: 0 },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: AUTHORING_DOCUMENT_LIMITS_V1.maxReadCharacters,
        },
      },
      ['logicalPath'],
    );
  }
  if (name === 'nova_authoring_document_list') {
    return schema({ version: authoringVersion }, ['version']);
  }
  if (name === 'nova_authoring_status') {
    return schema({ version: authoringVersion }, ['version']);
  }
  if (name === 'nova_authoring_document_read') {
    return schema(
      {
        version: authoringVersion,
        documentId: string,
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: AUTHORING_DOCUMENT_LIMITS_V1.maxDocumentBytes,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: AUTHORING_DOCUMENT_LIMITS_V1.maxReadCharacters,
        },
      },
      ['version', 'documentId'],
    );
  }
  if (name === 'nova_authoring_document_edit') {
    return schema(
      {
        version: authoringVersion,
        documentId: string,
        expectedWorkspaceDigest: string,
        expectedAcceptedSourceHash: nullableString,
        expectedStateVectorHash: string,
        replacementText: { type: 'string', maxLength: AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes },
        edits: {
          type: 'array',
          minItems: 1,
          items: objectProperty(
            {
              start: {
                type: 'integer',
                minimum: 0,
                maximum: AUTHORING_DOCUMENT_LIMITS_V1.maxDocumentBytes,
              },
              end: {
                type: 'integer',
                minimum: 0,
                maximum: AUTHORING_DOCUMENT_LIMITS_V1.maxDocumentBytes,
              },
              replacementText: {
                type: 'string',
                maxLength: AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes,
              },
            },
            ['start', 'end', 'replacementText'],
          ),
        },
      },
      [
        'version',
        'documentId',
        'expectedWorkspaceDigest',
        'expectedAcceptedSourceHash',
        'expectedStateVectorHash',
      ],
    );
  }
  if (name === 'nova_authoring_document_create') {
    return schema(
      {
        version: authoringVersion,
        logicalPath: string,
        kind: { type: 'string', enum: ['prose', 'raw-yaml'] },
        expectedWorkspaceDigest: string,
        expectedAcceptedSourceHash: nullableString,
      },
      ['version', 'logicalPath', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash'],
    );
  }
  if (name === 'nova_authoring_document_move') {
    return schema(
      {
        version: authoringVersion,
        documentId: string,
        logicalPath: string,
        expectedWorkspaceDigest: string,
        expectedAcceptedSourceHash: nullableString,
      },
      [
        'version',
        'documentId',
        'logicalPath',
        'expectedWorkspaceDigest',
        'expectedAcceptedSourceHash',
      ],
    );
  }
  if (name === 'nova_authoring_document_delete') {
    return schema(
      {
        version: authoringVersion,
        documentId: string,
        expectedWorkspaceDigest: string,
        expectedAcceptedSourceHash: nullableString,
      },
      ['version', 'documentId', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash'],
    );
  }
  if (name === 'nova_authoring_submit') {
    return schema(
      {
        version: authoringVersion,
        expectedWorkspaceDigest: string,
        message: { type: 'string', maxLength: 4096 },
      },
      ['version', 'expectedWorkspaceDigest'],
    );
  }
  if (name === 'nova_operation_get') {
    return schema({ version: authoringVersion, operationHandle: string }, [
      'version',
      'operationHandle',
    ]);
  }
  if (name === 'nova_operation_cancel') {
    return schema({ version: authoringVersion, operationHandle: string }, [
      'version',
      'operationHandle',
    ]);
  }
  if (name === 'nova_authoring_conflict_read') {
    return schema({ version: authoringVersion }, ['version']);
  }
  if (name === 'nova_conflict_resolve') {
    return schema(
      {
        version: authoringVersion,
        choice: {
          type: 'string',
          enum: ['keep-working', 'accept-external', 'apply-proposed-disjoint-merge'],
        },
        candidateHash: nullableString,
      },
      ['version', 'choice', 'candidateHash'],
    );
  }
  if (name === 'nova_entity_get') return schema({ entityId: string }, ['entityId']);
  if (name === 'nova_entity_list') return schema({ kind: string });
  if (name === 'nova_source_preview') {
    return schema({ changes: { type: 'array', minItems: 1 } }, ['changes']);
  }
  if (name === 'nova_graph') {
    return schema(
      { ...graphRouteSelectorProperty.properties },
      graphRouteSelectorProperty.required ?? [],
    );
  }
  if (name === 'nova_render' || name === 'nova_render_tree') {
    return schema(
      {
        sceneSelector: sceneSelectorProperty,
        model: string,
        referenceChunks: {
          type: 'array',
          maxItems: REFERENCE_MCP_LIMITS_V1.maxCitations,
          items: objectProperty({ referenceId, chunkId: referenceId }, ['referenceId', 'chunkId']),
        },
      },
      ['sceneSelector'],
    );
  }
  if (name === 'nova_revise') {
    return schema(
      {
        sceneSelector: sceneSelectorProperty,
        model: string,
        referenceChunks: {
          type: 'array',
          maxItems: REFERENCE_MCP_LIMITS_V1.maxCitations,
          items: objectProperty({ referenceId, chunkId: referenceId }, ['referenceId', 'chunkId']),
        },
        instruction: { type: 'string', maxLength: 4096 },
        reviewIds: {
          type: 'array',
          maxItems: 256,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
      ['sceneSelector'],
    );
  }
  if (name === 'nova_event_state_diff') {
    return schema({ eventId: string }, ['eventId']);
  }
  if (name === 'nova_review_list') {
    return schema(
      {
        version: reviewVersion,
        status: reviewCommentStatus,
        severity: reviewSeverity,
        targetType: reviewTargetType,
        targetId: string,
        eventId: string,
      },
      ['version'],
    );
  }
  if (name === 'nova_review_get') {
    return schema({ version: reviewVersion, commentId: reviewCommentId }, ['version', 'commentId']);
  }
  if (name === 'nova_review_add') {
    return schema(
      {
        version: reviewVersion,
        target: reviewTargetProperty,
        severity: reviewSeverity,
        category: reviewCategory,
        content: reviewCommentContent,
      },
      ['version', 'target', 'severity', 'category', 'content'],
    );
  }
  if (name === 'nova_review_update') {
    return schema(
      {
        version: reviewVersion,
        commentId: reviewCommentId,
        action: {
          type: 'string',
          enum: ['replace', 'resolve', 'wontfix', 'reopen', 'escalate'],
        },
        target: reviewTargetProperty,
        severity: reviewSeverity,
        category: reviewCategory,
        content: reviewCommentContent,
      },
      ['version', 'commentId', 'action'],
    );
  }
  if (name === 'nova_release_gate_list') {
    return schema({ version: reviewVersion, eventId: string }, ['version']);
  }
  if (name === 'nova_release_gate_decide') {
    return schema(
      {
        version: reviewVersion,
        eventId: string,
        candidateRevisionId: string,
        decision: { type: 'string', enum: ['accept', 'reject'] },
        reason: reviewReason,
      },
      ['version', 'eventId', 'candidateRevisionId', 'decision', 'reason'],
    );
  }
  if (name === 'nova_publish') {
    return schema(
      {
        version: publicationVersion,
        branchPath: graphRouteSelectorProperty,
        discourseBranch: string,
        title: publicationTitle,
      },
      ['version'],
    );
  }
  if (name === 'nova_publication_get') {
    return schema({ version: publicationVersion, publicationId }, ['version', 'publicationId']);
  }
  if (name === 'nova_publication_read') {
    return schema(
      {
        version: publicationVersion,
        publicationId,
        offset: publicationReadOffset,
        limit: publicationReadLimit,
      },
      ['version', 'publicationId', 'offset', 'limit'],
    );
  }
  if (name === 'nova_authoring_validate') {
    return schema(
      {
        version: authoringVersion,
        expectedWorkspaceDigest: string,
        expectedAcceptedSourceHash: nullableString,
      },
      ['version', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash'],
    );
  }
  if (name === 'nova_revision_list') {
    return schema({ version: authoringVersion, cursor }, ['version']);
  }
  if (name === 'nova_revision_get') {
    return schema({ version: authoringVersion, revisionId: string }, ['version', 'revisionId']);
  }
  if (name === 'nova_revision_diff') {
    return schema({ version: authoringVersion, fromRevisionId: string, toRevisionId: string }, [
      'version',
      'fromRevisionId',
      'toRevisionId',
    ]);
  }
  if (name === 'nova_revision_restore') {
    return schema(
      {
        version: authoringVersion,
        revisionId: string,
        expectedAcceptedRevisionId: nullableString,
        expectedSourceHash: nullableString,
      },
      ['version', 'revisionId'],
    );
  }
  if (name === 'nova_reference_list') {
    return schema({ version: referenceVersion, pageSize, cursor }, ['version']);
  }
  if (name === 'nova_reference_get') {
    return schema({ version: referenceVersion, referenceId }, ['version', 'referenceId']);
  }
  if (name === 'nova_reference_search') {
    return schema(
      {
        version: referenceVersion,
        query: { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxQueryLength },
        pageSize,
        cursor,
        filters: objectProperty({
          referenceId,
          mediaType,
          tag: { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxTagLength },
        }),
      },
      ['version', 'query'],
    );
  }
  if (name === 'nova_reference_chunk_get') {
    return schema({ version: referenceVersion, referenceId, chunkId: referenceId }, [
      'version',
      'referenceId',
      'chunkId',
    ]);
  }
  if (name === 'nova_reference_content_read') {
    return schema({ version: referenceVersion, referenceId, offset, limit: rangeLength }, [
      'version',
      'referenceId',
      'offset',
      'limit',
    ]);
  }
  if (name === 'nova_reference_import_begin') {
    return schema(
      {
        version: referenceVersion,
        referenceId,
        originalName: referenceName,
        displayName: referenceName,
        mediaType,
        byteLength: {
          type: 'integer',
          minimum: 0,
          maximum: REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
        },
        contentHash: hash,
        title: boundedMetadataText,
        authors: arrayProperty(
          { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxAuthorLength },
          0,
          REFERENCE_MCP_LIMITS_V1.maxAuthorCount,
        ),
        sourceUrl: boundedMetadataText,
        license: boundedMetadataText,
        tags: arrayProperty(
          { type: 'string', minLength: 1, maxLength: REFERENCE_MCP_LIMITS_V1.maxTagLength },
          0,
          REFERENCE_MCP_LIMITS_V1.maxTagCount,
        ),
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: REFERENCE_MCP_LIMITS_V1.maxIdempotencyKeyLength,
        },
      },
      [
        'version',
        'referenceId',
        'originalName',
        'mediaType',
        'byteLength',
        'contentHash',
        'idempotencyKey',
      ],
    );
  }
  if (name === 'nova_reference_import_chunk') {
    return schema(
      {
        version: referenceVersion,
        jobId: referenceId,
        offset,
        byteLength: {
          type: 'integer',
          minimum: 1,
          maximum: REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
        },
        chunkHash: hash,
        dataBase64: {
          type: 'string',
          minLength: 1,
          maxLength: REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length,
        },
      },
      ['version', 'jobId', 'offset', 'byteLength', 'chunkHash', 'dataBase64'],
    );
  }
  if (name === 'nova_reference_import_commit') {
    return schema({ version: referenceVersion, jobId: referenceId, contentHash: hash }, [
      'version',
      'jobId',
      'contentHash',
    ]);
  }
  if (name === 'nova_reference_job_get' || name === 'nova_reference_retry') {
    return schema({ version: referenceVersion, jobId: referenceId }, ['version', 'jobId']);
  }
  if (name === 'nova_reference_delete') {
    return schema({ version: referenceVersion, referenceId }, ['version', 'referenceId']);
  }
  if (name === 'nova_admin_config_get') {
    return schema({});
  }
  if (name === 'nova_admin_project_list' || name === 'nova_admin_device_list') {
    return schema({ version: adminVersion }, ['version']);
  }
  if (name === 'nova_admin_config_preview' || name === 'nova_admin_config_apply') {
    return schema(
      {
        version: adminVersion,
        expectedRevision: nullableString,
        configuration: adminConfigurationProperty,
      },
      ['version', 'expectedRevision', 'configuration'],
    );
  }
  if (
    name === 'nova_admin_project_validate' ||
    name === 'nova_admin_project_create' ||
    name === 'nova_admin_project_update'
  ) {
    return schema(
      {
        version: adminVersion,
        projectId: adminProjectId,
        displayName: { type: 'string', minLength: 1, maxLength: 4096 },
        root: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      ['version', 'projectId', 'displayName', 'root'],
    );
  }
  if (
    name === 'nova_admin_project_delete' ||
    name === 'nova_admin_project_open' ||
    name === 'nova_admin_project_close' ||
    name === 'nova_admin_project_recover'
  ) {
    return schema({ version: adminVersion, projectId: adminProjectId }, ['version', 'projectId']);
  }
  if (name === 'nova_admin_membership_list' || name === 'nova_admin_invite_list') {
    return schema({ version: adminVersion, projectId: adminProjectId }, ['version']);
  }
  if (name === 'nova_admin_membership_upsert') {
    return schema(
      { version: adminVersion, userId: adminProjectId, projectId: adminProjectId, role: adminRole },
      ['version', 'userId', 'projectId', 'role'],
    );
  }
  if (name === 'nova_admin_membership_revoke') {
    return schema({ version: adminVersion, userId: adminProjectId, projectId: adminProjectId }, [
      'version',
      'userId',
      'projectId',
    ]);
  }
  if (name === 'nova_admin_invite_create') {
    return schema(
      { version: adminVersion, projectId: adminProjectId, role: adminRole, ttlMs: adminTtlMs },
      ['version', 'projectId', 'role', 'ttlMs'],
    );
  }
  if (name === 'nova_admin_invite_revoke') {
    return schema({ version: adminVersion, inviteId: adminProjectId }, ['version', 'inviteId']);
  }
  if (name === 'nova_admin_device_pair_begin') {
    return schema(
      {
        version: adminVersion,
        kind: { type: 'string', enum: ['project', 'admin'] },
        projectId: adminProjectId,
        role: adminRole,
        ttlMs: adminTtlMs,
      },
      ['version'],
    );
  }
  if (name === 'nova_admin_device_revoke') {
    return schema({ version: adminVersion, deviceId: adminProjectId }, ['version', 'deviceId']);
  }
  if (name === 'nova_admin_operation_list') {
    return schema({ version: adminVersion, limit: { type: 'integer', minimum: 1, maximum: 100 } }, [
      'version',
    ]);
  }
  if (name === 'nova_admin_operation_get') {
    return schema({ version: adminVersion, operationHandle: adminProjectId }, [
      'version',
      'operationHandle',
    ]);
  }
  if (name === 'nova_admin_plugins_discovered') {
    return schema({ version: adminVersion, projectId: adminProjectId }, ['version', 'projectId']);
  }
  return EMPTY_SCHEMA;
}

function outputFor(name: string): McpJsonSchemaV1 {
  if (name === 'nova_reference_list' || name === 'nova_reference_search') {
    return referenceResult(
      {
        items: arrayProperty(referenceItemProperty, 0, REFERENCE_MCP_LIMITS_V1.maxPageSize),
        nextCursor: {
          type: ['string', 'null'],
          maxLength: REFERENCE_MCP_LIMITS_V1.maxCursorLength,
        },
      },
      ['items', 'nextCursor'],
    );
  }
  if (name === 'nova_reference_get') {
    return referenceResult({ item: referenceItemProperty }, ['item']);
  }
  if (name === 'nova_reference_chunk_get') {
    return referenceResult({ chunk: referenceChunkProperty }, ['chunk']);
  }
  if (name === 'nova_reference_content_read') {
    return referenceResult({ content: referenceContentProperty }, ['content']);
  }
  if (
    name === 'nova_reference_import_begin' ||
    name === 'nova_reference_import_chunk' ||
    name === 'nova_reference_import_commit' ||
    name === 'nova_reference_job_get' ||
    name === 'nova_reference_retry'
  ) {
    return referenceResult({ job: referenceJobProperty }, ['job']);
  }
  if (name === 'nova_reference_delete') {
    return referenceResult(
      {
        job: referenceJobProperty,
        deletedReferenceId: referenceId,
      },
      ['job', 'deletedReferenceId'],
    );
  }
  if (name === 'nova_review_list' || name === 'nova_release_gate_list') {
    return schema(
      {
        result: objectProperty(
          {
            version: reviewVersion,
            items: arrayProperty(
              name === 'nova_review_list' ? reviewCommentProperty : reviewGateProperty,
              0,
            ),
          },
          ['version', 'items'],
        ),
      },
      ['result'],
    );
  }
  if (name === 'nova_review_get') {
    return schema(
      {
        result: objectProperty(
          {
            version: reviewVersion,
            comment: { ...reviewCommentProperty, type: ['object', 'null'] },
          },
          ['version', 'comment'],
        ),
      },
      ['result'],
    );
  }
  if (name === 'nova_review_add' || name === 'nova_review_update') {
    return schema(
      {
        result: objectProperty({ version: reviewVersion, comment: reviewCommentProperty }, [
          'version',
          'comment',
        ]),
      },
      ['result'],
    );
  }
  if (name === 'nova_release_gate_decide') {
    return schema(
      {
        result: objectProperty(
          { version: reviewVersion, resolution: releaseGateResolutionProperty },
          ['version', 'resolution'],
        ),
      },
      ['result'],
    );
  }
  if (name === 'nova_publication_get') {
    return schema(
      {
        version: publicationVersion,
        publication: { ...publicationRecordProperty, type: ['object', 'null'] },
      },
      ['version', 'publication'],
    );
  }
  if (name === 'nova_publication_read') {
    return schema(
      {
        version: publicationVersion,
        publicationId,
        offset: publicationReadOffset,
        limit: publicationReadLimit,
        content: string,
        byteLength: { type: 'integer', minimum: 0 },
        totalByteLength: { type: 'integer', minimum: 0 },
      },
      ['version', 'publicationId', 'offset', 'limit', 'content', 'byteLength', 'totalByteLength'],
    );
  }
  if (name === 'nova_publish') {
    return schema(
      {
        status: { type: 'string', enum: ['queued'] },
        operationHandle: string,
      },
      ['status', 'operationHandle'],
    );
  }
  if (name === 'nova_authoring_validate') {
    return schema(
      {
        version: authoringVersion,
        layer: { type: 'string', const: 'working' },
        projectId: string,
        workspaceDigest: string,
        acceptedSourceHash: nullableString,
        candidateSourceHash: string,
        passed: { type: 'boolean' },
        diagnostics: arrayProperty(
          objectProperty(
            {
              code: string,
              severity: { type: 'string', enum: ['error', 'warning', 'info'] },
              message: string,
              logicalPath: nullableString,
            },
            ['code', 'severity', 'message', 'logicalPath'],
          ),
          0,
        ),
        iss: workingValidationIssProperty,
        results: objectProperty({}, []),
      },
      [
        'version',
        'layer',
        'projectId',
        'workspaceDigest',
        'acceptedSourceHash',
        'candidateSourceHash',
        'passed',
        'diagnostics',
        'iss',
        'results',
      ],
    );
  }
  return RESULT_SCHEMA;
}

function descriptor(name: string, scopes: readonly McpScopeV1[]): McpToolDescriptorV1 {
  return {
    version: 1,
    name,
    description: name,
    scopes,
    inputSchema: inputFor(name),
    outputSchema: outputFor(name),
  };
}

const project = [
  'nova_status',
  'nova_validate',
  'nova_source_list',
  'nova_source_get',
  'nova_source_preview',
  'nova_entity_get',
  'nova_entity_list',
  'nova_graph',
  'nova_render',
  'nova_revise',
  'nova_render_tree',
  'nova_revision_list',
  'nova_revision_get',
  'nova_revision_diff',
  'nova_event_state_diff',
].map((name) =>
  descriptor(
    name,
    name === 'nova_render' || name === 'nova_revise' || name === 'nova_render_tree'
      ? ['mcp:render']
      : ['mcp:read'],
  ),
);
const publicationTools = [
  { name: 'nova_publish', scopes: ['mcp:submit'] as const },
  { name: 'nova_publication_get', scopes: ['mcp:read'] as const },
  { name: 'nova_publication_read', scopes: ['mcp:read'] as const },
];
const publication = publicationTools.map((entry) => descriptor(entry.name, entry.scopes));
const authoringNames = [
  'nova_authoring_document_list',
  'nova_authoring_document_read',
  'nova_authoring_document_edit',
  'nova_authoring_document_create',
  'nova_authoring_document_move',
  'nova_authoring_document_delete',
  'nova_authoring_status',
  'nova_authoring_validate',
  'nova_authoring_submit',
  'nova_operation_get',
  'nova_operation_cancel',
  'nova_authoring_conflict_read',
  'nova_conflict_resolve',
  'nova_revision_restore',
] as const;
const submitToolNames = new Set<string>([
  'nova_authoring_submit',
  'nova_operation_get',
  'nova_operation_cancel',
  'nova_authoring_conflict_read',
  'nova_conflict_resolve',
  'nova_revision_restore',
]);
const authoring = authoringNames.map((name) =>
  descriptor(name, submitToolNames.has(name) ? ['mcp:submit'] : ['mcp:author']),
);
const reviewTools = [
  { name: 'nova_review_list', scopes: ['mcp:read'] as const },
  { name: 'nova_review_get', scopes: ['mcp:read'] as const },
  { name: 'nova_review_add', scopes: ['mcp:author'] as const },
  { name: 'nova_review_update', scopes: ['mcp:author'] as const },
  { name: 'nova_release_gate_list', scopes: ['mcp:read'] as const },
  { name: 'nova_release_gate_decide', scopes: ['mcp:submit'] as const },
];
const review = reviewTools.map((entry) => descriptor(entry.name, entry.scopes));
const references = [
  'nova_reference_list',
  'nova_reference_get',
  'nova_reference_search',
  'nova_reference_chunk_get',
  'nova_reference_content_read',
  'nova_reference_import_begin',
  'nova_reference_import_chunk',
  'nova_reference_import_commit',
  'nova_reference_job_get',
  'nova_reference_retry',
  'nova_reference_delete',
].map((name) =>
  descriptor(
    name,
    name.includes('import') || name.includes('retry') || name.includes('delete')
      ? ['mcp:reference:write']
      : ['mcp:reference:read'],
  ),
);
const admin = [
  'nova_admin_config_get',
  'nova_admin_config_preview',
  'nova_admin_config_apply',
  'nova_admin_project_list',
  'nova_admin_project_validate',
  'nova_admin_project_create',
  'nova_admin_project_update',
  'nova_admin_project_delete',
  'nova_admin_project_open',
  'nova_admin_project_close',
  'nova_admin_project_recover',
  'nova_admin_membership_list',
  'nova_admin_membership_upsert',
  'nova_admin_membership_revoke',
  'nova_admin_invite_list',
  'nova_admin_invite_create',
  'nova_admin_invite_revoke',
  'nova_admin_device_list',
  'nova_admin_device_pair_begin',
  'nova_admin_device_revoke',
  'nova_admin_operation_list',
  'nova_admin_operation_get',
  'nova_admin_plugins_discovered',
].map((name) => descriptor(name, ['mcp:admin']));

export const MCP_TOOL_CATALOG_V1: readonly McpToolDescriptorV1[] = [
  ...project,
  ...authoring,
  ...review,
  ...publication,
  ...references,
  ...admin,
];

function strictProperty(property: McpJsonSchemaProperty): boolean {
  if (typeof property !== 'object' || property === null || !('type' in property)) return false;
  if (property.type === 'object') {
    if (property.additionalProperties !== false || typeof property.properties !== 'object') {
      return false;
    }
    return Object.values(property.properties).every(strictProperty);
  }
  return property.items === undefined || strictProperty(property.items);
}

function strictSchema(schema: McpJsonSchemaV1): boolean {
  if (schema.type !== 'object' || schema.additionalProperties !== false) return false;
  return Object.values(schema.properties).every(strictProperty);
}

export function assertMcpToolCatalogParity(
  catalog: readonly McpToolDescriptorV1[] = MCP_TOOL_CATALOG_V1,
): void {
  const seen = new Set<string>();
  for (const item of catalog) {
    if (item.version !== 1 || seen.has(item.name)) {
      throw new TypeError('MCP catalog has duplicate name or missing version');
    }
    seen.add(item.name);
    if (!strictSchema(item.inputSchema) || !strictSchema(item.outputSchema)) {
      throw new TypeError(`MCP schema for ${item.name} is not strict`);
    }
    for (const forbidden of ['actorId', 'operationId']) {
      if (forbidden in item.inputSchema.properties || forbidden in item.outputSchema.properties) {
        throw new TypeError(`MCP schema for ${item.name} accepts server identity`);
      }
    }
    if (item.scopes.length === 0 || item.scopes.some((scope) => !MCP_SCOPES_V1.includes(scope))) {
      throw new TypeError(`MCP scope drift: ${item.name}`);
    }
  }
}
