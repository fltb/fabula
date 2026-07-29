import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import { loadProjectConfig } from '../entity/index.ts';
import { FsStorage } from '../storage/fs-storage.ts';
import { computeContentHash } from '../storage/hash.ts';
import type { Storage, StorageWrite } from '../storage/types.ts';
import type {
  EditorialMutationContext,
  EditorialOperationKind,
  EditorialOperationV1,
  EditorialRuntime,
} from '../types/editorial.ts';
import type {
  NewReviewComment,
  ReviewComment,
  ReviewLedgerV1,
} from '../types/review.ts';
import type { CommentFilter } from '../review/types.ts';
import { ReviewManager } from '../review/manager.ts';
import {
  editorialMutationContextSchema,
  editorialOperationV1Schema,
} from '../schemas/editorial.ts';
import {
  newReviewCommentSchema,
  reviewLedgerV1Schema,
} from '../schemas/review.ts';
import { EditorialOperationError } from './errors.ts';
import { canonicalJson } from './identity.ts';
import { resolveProjectPaths, type ProjectPaths } from './paths.ts';
import { ProjectTransactionCoordinator, stableJson } from './transaction.ts';
import { getEditorialWorkspace as createWorkspace } from './workspace.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const reviewMutationBase = {
  projectDir: z.string().trim().min(1),
  mutation: editorialMutationContextSchema,
  expectedLedgerHash: hashSchema.optional(),
};
const addReviewRequestSchema = z.object({
  ...reviewMutationBase,
  input: newReviewCommentSchema,
}).strict();
const replaceReviewRequestSchema = z.object({
  ...reviewMutationBase,
  commentId: z.string().trim().min(1),
  input: newReviewCommentSchema,
}).strict();
const updateReviewRequestSchema = z.object({
  ...reviewMutationBase,
  commentId: z.string().trim().min(1),
  action: z.enum(['resolve', 'wontfix', 'reopen', 'escalate']),
}).strict();

interface ReviewContext {
  storage: Storage;
  paths: ProjectPaths;
  coordinator: ProjectTransactionCoordinator;
  manager: ReviewManager;
}

function reviewContext(
  projectDir: string,
  runtime?: EditorialRuntime,
): ReviewContext {
  const storage = runtime?.storage ?? new FsStorage();
  const config = loadProjectConfig(path.join(projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(projectDir, config?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  return {
    storage,
    paths,
    coordinator,
    manager: new ReviewManager(storage, coordinator, paths.reviewLedgerPath),
  };
}

function validateLineTarget(
  context: ReviewContext,
  projectDir: string,
  input: NewReviewComment,
): void {
  if (input.target.type !== 'line') return;
  const workspace = createWorkspace(
    projectDir,
    path.relative(projectDir, context.paths.workDir),
    context.storage,
  );
  const scene = workspace.inspectScene(input.target.id);
  if (
    scene.revisionId === null ||
    scene.proseHash === null ||
    scene.sceneContent === null
  ) {
    throw new EditorialOperationError(
      'SCENE_NOT_FOUND',
      `Line review target ${input.target.id} has no accepted scene`,
      { eventId: input.target.id },
    );
  }
  if (
    input.target.lineBasis?.revisionId !== scene.revisionId ||
    input.target.lineBasis.proseHash !== scene.proseHash
  ) {
    throw new EditorialOperationError(
      'REVISION_STALE',
      `Line review basis is stale for ${input.target.id}`,
      { eventId: input.target.id },
    );
  }
  const lineCount = scene.sceneContent.split(/\r?\n/).length;
  if ((input.target.lineRange?.[1] ?? 0) > lineCount) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Line range exceeds ${input.target.id} line count ${lineCount}`,
      { eventId: input.target.id },
    );
  }
}

function existingMutationResult(
  context: ReviewContext,
  operationId: string,
  requestHash: string,
): ReviewComment | null {
  const operationPath = path.join(
    context.paths.operationsDir,
    `${operationId}.json`,
  );
  const raw = context.storage.readOptional(operationPath);
  if (raw === null) return null;
  const operation = editorialOperationV1Schema.parse(
    JSON.parse(raw),
  ) as EditorialOperationV1;
  if (
    operation.requestHash === requestHash &&
    operation.status === 'succeeded' &&
    operation.result !== null &&
    'id' in operation.result &&
    typeof operation.result.id === 'string'
  ) {
    return operation.result as ReviewComment;
  }
  throw new EditorialOperationError(
    'INVALID_OPERATION',
    `Operation ${operationId} already exists with a different request`,
    { operationId },
  );
}

function commitReviewMutation(
  context: ReviewContext,
  kind: EditorialOperationKind,
  mutation: EditorialMutationContext,
  requestHash: string,
  beforeHash: string | null,
  ledger: ReviewLedgerV1,
  result: ReviewComment,
): ReviewComment {
  const parsedLedger = reviewLedgerV1Schema.parse(ledger) as ReviewLedgerV1;
  const now = new Date().toISOString();
  const operation: EditorialOperationV1 = {
    version: 1,
    operationId: mutation.operationId,
    kind,
    actorId: mutation.actorId,
    requestHash,
    status: 'succeeded',
    startedAt: now,
    heartbeatAt: now,
    leaseExpiresAt: now,
    completedAt: now,
    result,
    errors: [],
  };
  const operationPath = path.join(
    context.paths.operationsDir,
    `${mutation.operationId}.json`,
  );
  const writes: StorageWrite[] = [
    {
      type: 'put',
      path: context.paths.reviewLedgerPath,
      content: stableJson(parsedLedger),
      expectedHash: beforeHash,
    },
    {
      type: 'put',
      path: operationPath,
      content: stableJson(operation),
      expectedHash: null,
    },
  ];
  context.coordinator.commit({
    transactionId: mutation.operationId,
    readSet: [
      {
        kind: 'file',
        path: context.paths.reviewLedgerPath,
        expectedHash: beforeHash,
      },
      { kind: 'file', path: operationPath, expectedHash: null },
    ],
    writes,
  });
  return result;
}

function assertExpectedLedgerHash(
  expected: string | null | undefined,
  actual: string | null,
  ledgerPath: string,
): void {
  if (expected !== undefined && expected !== actual) {
    throw new EditorialOperationError(
      'STORAGE_CONFLICT',
      'Expected review ledger hash does not match current content',
      { path: ledgerPath },
    );
  }
}

export function listReviewComments(
  request: { projectDir: string; filter?: CommentFilter },
  runtime?: EditorialRuntime,
): ReviewComment[] {
  return reviewContext(request.projectDir, runtime).manager.getComments(
    request.filter,
  );
}

export function addReviewComment(
  request: {
    projectDir: string;
    input: NewReviewComment;
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): ReviewComment {
  const parsed = addReviewRequestSchema.parse(request);
  const context = reviewContext(parsed.projectDir, runtime);
  const requestHash = computeContentHash(canonicalJson({
    kind: 'add_review',
    projectDir: parsed.projectDir,
    input: parsed.input,
    expectedLedgerHash: parsed.expectedLedgerHash ?? null,
  }));
  const existing = existingMutationResult(
    context,
    parsed.mutation.operationId,
    requestHash,
  );
  if (existing) return existing;
  validateLineTarget(context, parsed.projectDir, parsed.input);
  const snapshot = context.manager.readLedger();
  assertExpectedLedgerHash(
    parsed.expectedLedgerHash,
    snapshot.contentHash,
    context.paths.reviewLedgerPath,
  );
  const comment: ReviewComment = {
    id: `rev_${crypto.randomUUID()}`,
    author: 'human',
    actorId: parsed.mutation.actorId,
    target: parsed.input.target,
    severity: parsed.input.severity,
    category: parsed.input.category,
    content: parsed.input.content,
    status: 'open',
    applications: [],
    createdAt: new Date().toISOString(),
  };
  return commitReviewMutation(
    context,
    'add_review',
    parsed.mutation,
    requestHash,
    snapshot.contentHash,
    {
      ...snapshot.ledger,
      comments: [...snapshot.ledger.comments, comment],
    },
    comment,
  );
}

export function replaceReviewComment(
  request: {
    projectDir: string;
    commentId: string;
    input: NewReviewComment;
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): ReviewComment {
  const parsed = replaceReviewRequestSchema.parse(request);
  const context = reviewContext(parsed.projectDir, runtime);
  const requestHash = computeContentHash(canonicalJson({
    kind: 'replace_review',
    projectDir: parsed.projectDir,
    commentId: parsed.commentId,
    input: parsed.input,
    expectedLedgerHash: parsed.expectedLedgerHash ?? null,
  }));
  const existing = existingMutationResult(
    context,
    parsed.mutation.operationId,
    requestHash,
  );
  if (existing) return existing;
  validateLineTarget(context, parsed.projectDir, parsed.input);
  const snapshot = context.manager.readLedger();
  assertExpectedLedgerHash(
    parsed.expectedLedgerHash,
    snapshot.contentHash,
    context.paths.reviewLedgerPath,
  );
  const index = snapshot.ledger.comments.findIndex(
    (comment) => comment.id === parsed.commentId,
  );
  if (index < 0) {
    throw new EditorialOperationError(
      'REVIEW_NOT_FOUND',
      `Review ${parsed.commentId} was not found`,
    );
  }
  const original = snapshot.ledger.comments[index];
  if (original.status === 'superseded') {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Review ${parsed.commentId} is already superseded`,
    );
  }
  const now = new Date().toISOString();
  const replacement: ReviewComment = {
    id: `rev_${crypto.randomUUID()}`,
    author: 'human',
    actorId: parsed.mutation.actorId,
    target: parsed.input.target,
    severity: parsed.input.severity,
    category: parsed.input.category,
    content: parsed.input.content,
    status: 'open',
    applications: [],
    supersedesId: original.id,
    createdAt: now,
  };
  const comments = [...snapshot.ledger.comments];
  comments[index] = {
    ...original,
    status: 'superseded',
    resolvedAt: now,
    resolvedBy: parsed.mutation.actorId,
  };
  comments.push(replacement);
  return commitReviewMutation(
    context,
    'replace_review',
    parsed.mutation,
    requestHash,
    snapshot.contentHash,
    { ...snapshot.ledger, comments },
    replacement,
  );
}

export function updateReviewComment(
  request: {
    projectDir: string;
    commentId: string;
    action: 'resolve' | 'wontfix' | 'reopen' | 'escalate';
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): ReviewComment {
  const parsed = updateReviewRequestSchema.parse(request);
  const context = reviewContext(parsed.projectDir, runtime);
  const requestHash = computeContentHash(canonicalJson({
    kind: 'update_review',
    projectDir: parsed.projectDir,
    commentId: parsed.commentId,
    action: parsed.action,
    expectedLedgerHash: parsed.expectedLedgerHash ?? null,
  }));
  const existing = existingMutationResult(
    context,
    parsed.mutation.operationId,
    requestHash,
  );
  if (existing) return existing;
  const snapshot = context.manager.readLedger();
  assertExpectedLedgerHash(
    parsed.expectedLedgerHash,
    snapshot.contentHash,
    context.paths.reviewLedgerPath,
  );
  const index = snapshot.ledger.comments.findIndex(
    (comment) => comment.id === parsed.commentId,
  );
  if (index < 0) {
    throw new EditorialOperationError(
      'REVIEW_NOT_FOUND',
      `Review ${parsed.commentId} was not found`,
    );
  }
  const current = snapshot.ledger.comments[index];
  if (current.status === 'superseded') {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Review ${parsed.commentId} is superseded`,
    );
  }
  const now = new Date().toISOString();
  let updated: ReviewComment;
  if (parsed.action === 'resolve' || parsed.action === 'wontfix') {
    updated = {
      ...current,
      status: parsed.action === 'resolve' ? 'resolved' : 'wontfix',
      resolvedAt: now,
      resolvedBy: parsed.mutation.actorId,
    };
  } else if (parsed.action === 'reopen') {
    const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = current;
    updated = { ...rest, status: 'open' };
  } else {
    const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...rest } = current;
    updated = { ...rest, severity: 'blocking', status: 'open' };
  }
  const comments = [...snapshot.ledger.comments];
  comments[index] = updated;
  return commitReviewMutation(
    context,
    'update_review',
    parsed.mutation,
    requestHash,
    snapshot.contentHash,
    { ...snapshot.ledger, comments },
    updated,
  );
}
