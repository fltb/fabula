import { z } from 'zod';
import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import { ReviewManager } from '../review/manager.ts';
import type { CommentFilter } from '../review/types.ts';
import { editorialMutationContextSchema } from '../schemas/editorial.ts';
import { newReviewCommentSchema } from '../schemas/review.ts';
import type { EditorialMutationContext, EditorialRuntime } from '../types/editorial.ts';
import type { NewReviewComment, ReviewComment } from '../types/review.ts';
import { EditorialOperationError } from './errors.ts';
import { reviewServices } from './facade.ts';

const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const base = {
  projectId: z.string().trim().min(1),
  mutation: editorialMutationContextSchema,
  expectedLedgerHash: hashSchema.optional(),
};
const addSchema = z.object({ ...base, input: newReviewCommentSchema }).strict();
const replaceSchema = z
  .object({ ...base, commentId: z.string().trim().min(1), input: newReviewCommentSchema })
  .strict();
const updateSchema = z
  .object({
    ...base,
    commentId: z.string().trim().min(1),
    action: z.enum(['resolve', 'wontfix', 'reopen', 'escalate']),
  })
  .strict();

function manager(projectId: string, runtime?: EditorialRuntime): ReviewManager {
  const execution = runtime?.services?.execution;
  if (!execution)
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'CoreExecutionRepository is required for review operations',
    );
  return new ReviewManager(execution, projectId, reviewServices(runtime));
}

async function validateLineTarget(
  execution: CoreExecutionRepository,
  projectId: string,
  input: NewReviewComment,
): Promise<void> {
  if (input.target.type !== 'line') return;
  const scene = await execution.resolveAcceptedArtifact({ projectId, eventId: input.target.id });
  if (!scene)
    throw new EditorialOperationError(
      'SCENE_NOT_FOUND',
      `Line review target ${input.target.id} has no accepted scene`,
      { eventId: input.target.id },
    );
  if (
    !input.target.lineBasis ||
    input.target.lineBasis.revisionId !== scene.revisionId ||
    input.target.lineBasis.proseHash !== scene.proseHash
  )
    throw new EditorialOperationError(
      'REVISION_STALE',
      `Line review basis is stale for ${input.target.id}`,
      { eventId: input.target.id },
    );
  const lineCount = scene.prose.split(/\r?\n/).length;
  if ((input.target.lineRange?.[1] ?? 0) > lineCount)
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Line range exceeds ${input.target.id} line count ${lineCount}`,
      { eventId: input.target.id },
    );
}

export async function listReviewComments(
  request: { projectId: string; filter?: CommentFilter },
  runtime?: EditorialRuntime,
): Promise<ReviewComment[]> {
  return manager(request.projectId, runtime).getComments(request.filter);
}
export async function addReviewComment(
  request: {
    projectId: string;
    input: NewReviewComment;
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): Promise<ReviewComment> {
  const parsed = addSchema.parse(request);
  const execution = runtime?.services?.execution;
  if (!execution)
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'CoreExecutionRepository is required for review operations',
    );
  await validateLineTarget(execution, parsed.projectId, parsed.input);
  return manager(parsed.projectId, runtime).addReviewComment(
    parsed.input,
    parsed.mutation.actorId,
    { expectedLedgerHash: parsed.expectedLedgerHash ?? undefined },
  );
}
export async function replaceReviewComment(
  request: {
    projectId: string;
    commentId: string;
    input: NewReviewComment;
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): Promise<ReviewComment> {
  const parsed = replaceSchema.parse(request);
  const execution = runtime?.services?.execution;
  if (!execution)
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'CoreExecutionRepository is required for review operations',
    );
  await validateLineTarget(execution, parsed.projectId, parsed.input);
  return manager(parsed.projectId, runtime).replaceReviewComment(
    parsed.commentId,
    parsed.input,
    parsed.mutation.actorId,
    { expectedLedgerHash: parsed.expectedLedgerHash ?? undefined },
  );
}
export async function updateReviewComment(
  request: {
    projectId: string;
    commentId: string;
    action: 'resolve' | 'wontfix' | 'reopen' | 'escalate';
    mutation: EditorialMutationContext;
    expectedLedgerHash?: string | null;
  },
  runtime?: EditorialRuntime,
): Promise<ReviewComment> {
  const parsed = updateSchema.parse(request);
  return manager(parsed.projectId, runtime).updateReviewComment(
    parsed.commentId,
    parsed.action,
    parsed.mutation.actorId,
    { expectedLedgerHash: parsed.expectedLedgerHash ?? undefined },
  );
}
