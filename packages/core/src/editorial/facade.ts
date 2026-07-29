import * as path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { canonicalAssemble, customAssemble } from '../assembler/release-assembly.ts';
import { EntityMapper, loadProjectConfig } from '../entity/index.ts';
import { appendPlayerChoicesBlock } from '../pipeline/output.ts';
import {
  editorialMutationContextSchema,
  editorialOperationV1Schema,
  editorialScopedRequestV1Schema,
  publicationManifestV1Schema,
  sceneMetadataV1Schema,
  sourceChangePreviewV1Schema,
} from '../schemas/editorial.ts';
import { FsStorage } from '../storage/fs-storage.ts';
import { computeContentHash, computeFileHash } from '../storage/hash.ts';
import type { Storage, StorageWrite } from '../storage/types.ts';
import type {
  AssembleRequestV1,
  EditorialAssembleResult,
  EditorialError,
  EditorialMutationContext,
  EditorialOperationV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  EditorialScopedRequestV1,
  EditorialWorkspaceSnapshotV1,
  PublicationResult,
  RenderNovelResult,
  SceneActionResult,
  SceneInspection,
  SceneProseInput,
  SceneRevisionEnvelopeV1,
  SceneRevisionSummary,
  SourceChangePreviewV1,
  SourceChangeResultV1,
  SourceDocumentV1,
  SourceRevisionV1,
} from '../types/editorial.ts';
import type { GameDialogueChoice } from '../types/game-dialogue.ts';
import { EditorialOperationError, toEditorialError } from './errors.ts';
import { OperationStore } from './operation-store.ts';
import { type ProjectPaths, resolveProjectPaths } from './paths.ts';
import {
  computeCandidateOperationRequestHash,
  type EditorialCandidateExecution,
  executeEditorialRender,
  previewEditorialRun,
} from './render-service.ts';
import { SceneService } from './scene-service.ts';
import { SourceRevisionStore } from './source-store.ts';
import { SourceWorkspace } from './source-workspace.ts';
import { ProjectTransactionCoordinator, stableJson } from './transaction.ts';
import { getEditorialWorkspace as createWorkspace } from './workspace.ts';

interface WorkspaceContext {
  storage: Storage;
  paths: ProjectPaths;
  sourceWorkspace: SourceWorkspace;
  sourceRevisionStore: SourceRevisionStore;
}

function workspaceContext(projectDir: string, runtime?: EditorialRuntime): WorkspaceContext {
  const storage = runtime?.storage ?? new FsStorage();
  const config = loadProjectConfig(path.join(projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(projectDir, config?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  return {
    storage,
    paths,
    sourceWorkspace: new SourceWorkspace(storage, paths),
    sourceRevisionStore: new SourceRevisionStore(coordinator, paths),
  };
}

function parseScopedRequest(request: EditorialScopedRequestV1): EditorialScopedRequestV1 {
  return editorialScopedRequestV1Schema.parse(request) as EditorialScopedRequestV1;
}

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sceneProseInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('replacement'),
      prose: z.string(),
      expectedRevisionId: z.string().uuid().nullable(),
      expectedSceneHash: contentHashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('working_copy'),
      expectedSceneHash: contentHashSchema,
    })
    .strict(),
]);
const adoptSceneRequestSchema = editorialScopedRequestV1Schema
  .extend({
    eventId: z.string().trim().min(1),
    input: sceneProseInputSchema,
    mutation: editorialMutationContextSchema,
    note: z.string().trim().min(1).optional(),
    lockAfter: z.boolean().optional(),
  })
  .strict();
const setSceneLockRequestSchema = editorialScopedRequestV1Schema
  .extend({
    eventId: z.string().trim().min(1),
    locked: z.boolean(),
    mutation: editorialMutationContextSchema,
    note: z.string().trim().min(1).optional(),
    expectedSceneHash: contentHashSchema,
  })
  .strict();
const rollbackSceneRequestSchema = editorialScopedRequestV1Schema
  .extend({
    eventId: z.string().trim().min(1),
    revisionId: z.string().uuid(),
    mutation: editorialMutationContextSchema,
    note: z.string().trim().min(1).optional(),
  })
  .strict();

function currentPublication(storage: Storage, paths: ProjectPaths): PublicationResult {
  const raw = storage.readOptional(paths.publicationPath);
  if (raw === null) {
    return {
      status: 'unchanged',
      outputPath: paths.novelPath,
      novelHash: computeFileHash(storage, paths.novelPath),
      reasons: [],
    };
  }
  try {
    const manifest = publicationManifestV1Schema.parse(JSON.parse(raw));
    return {
      status: 'unchanged',
      outputPath: paths.novelPath,
      novelHash: manifest.novel_hash,
      reasons: [...manifest.reasons],
    };
  } catch {
    return {
      status: 'stale',
      outputPath: paths.novelPath,
      novelHash: computeFileHash(storage, paths.novelPath),
      reasons: [
        {
          code: 'PUBLICATION_INCOMPLETE',
          message: 'Publication manifest is malformed',
          path: paths.publicationPath,
        },
      ],
    };
  }
}

function actionError(
  storage: Storage,
  paths: ProjectPaths,
  eventId: string,
  mutation: EditorialMutationContext,
  error: EditorialError,
): SceneActionResult {
  const publication = currentPublication(storage, paths);
  return {
    operationId: mutation.operationId,
    eventId,
    revisionId: null,
    proseHash: null,
    sceneHash: null,
    proseSource: null,
    locked: false,
    released: false,
    promoted: false,
    releaseDecision: null,
    publication: {
      ...publication,
      status: 'stale',
      reasons: [...publication.reasons, error],
    },
    editorialErrors: [error],
  };
}
function actionRequestHash(kind: string, request: unknown): string {
  return computeContentHash(stableJson({ kind, request }));
}

function replayCandidateAction(
  context: WorkspaceContext,
  operationId: string,
  kind: 'adopt_scene' | 'rollback_scene',
  requestHash: string,
): SceneActionResult | null {
  const operationPath = path.join(context.paths.operationsDir, `${operationId}.json`);
  const raw = context.storage.readOptional(operationPath);
  if (raw === null) return null;
  const operation = editorialOperationV1Schema.parse(JSON.parse(raw)) as EditorialOperationV1;
  if (operation.kind !== kind || operation.requestHash !== requestHash) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Operation ${operationId} already exists with a different request`,
      { operationId },
    );
  }
  if (operation.status === 'succeeded' && operation.result !== null) {
    return operation.result as SceneActionResult;
  }
  if (operation.status === 'running') {
    throw new EditorialOperationError(
      'OPERATION_IN_PROGRESS',
      `Operation ${operationId} is already running`,
      { operationId },
    );
  }
  if (operation.status === 'failed' || operation.status === 'cancelled') {
    const prior = operation.errors[0];
    throw new EditorialOperationError(
      prior?.code ?? 'INVALID_OPERATION',
      prior?.message ?? `Operation ${operationId} already terminated`,
      {
        operationId,
        ...(prior?.eventId ? { eventId: prior.eventId } : {}),
        ...(prior?.path ? { path: prior.path } : {}),
      },
    );
  }
  return null;
}

function authoredChoices(
  storage: Storage,
  projectDir: string,
  eventId: string,
): readonly GameDialogueChoice[] {
  const data = new EntityMapper(projectDir, storage).loadProject();
  for (const chapter of data.chapters.values()) {
    const event = chapter.events.find((candidate) => candidate.event === eventId);
    if (event) return event.choices ?? [];
  }
  throw new EditorialOperationError('SCENE_NOT_FOUND', `Authored scene ${eventId} was not found`, {
    eventId,
  });
}

function rawProseFromInput(
  input: SceneProseInput,
  inspection: SceneInspection,
  choices: readonly GameDialogueChoice[],
): string {
  const openMarker = '<!-- FABULA:PLAYER_CHOICES:v1 -->';
  const closeMarker = '<!-- /FABULA:PLAYER_CHOICES -->';
  if (input.type === 'replacement') {
    if (input.prose.includes(openMarker) || input.prose.includes(closeMarker)) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        'Replacement prose must not contain the system player-choice block',
        { eventId: inspection.eventId },
      );
    }
    return input.prose;
  }
  const sceneContent = inspection.sceneContent;
  if (sceneContent === null) {
    throw new EditorialOperationError(
      'SCENE_NOT_FOUND',
      `Scene working copy ${inspection.eventId} does not exist`,
      { eventId: inspection.eventId },
    );
  }
  if (computeContentHash(sceneContent) !== input.expectedSceneHash) {
    throw new EditorialOperationError(
      'SCENE_CONTENT_CONFLICT',
      'Scene working-copy bytes changed after they were read',
      { eventId: inspection.eventId },
    );
  }
  if (choices.length === 0) {
    if (sceneContent.includes(openMarker) || sceneContent.includes(closeMarker)) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        'Scene without authored choices must not contain a player-choice block',
        { eventId: inspection.eventId },
      );
    }
    return sceneContent;
  }
  const suffix = appendPlayerChoicesBlock('', choices);
  if (!sceneContent.endsWith(suffix)) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'Working copy must end with exactly one canonical player-choice block',
      { eventId: inspection.eventId },
    );
  }
  const prose = sceneContent.slice(0, -suffix.length);
  if (prose.includes(openMarker) || prose.includes(closeMarker)) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'Working copy contains more than one player-choice block',
      { eventId: inspection.eventId },
    );
  }
  return prose;
}

function mapCandidateResult(
  result: RenderNovelResult,
  eventId: string,
  lockAfter: boolean,
  storage: Storage,
  paths: ProjectPaths,
): SceneActionResult {
  const scene = result.results.find((candidate) => candidate.eventId === eventId);
  const envelope = scene?.revisionId
    ? new SceneService(storage, paths).get(eventId, scene.revisionId)
    : null;
  return {
    operationId: result.operationId,
    eventId,
    revisionId: scene?.revisionId ?? null,
    proseHash: envelope?.proseHash ?? null,
    sceneHash: envelope?.sceneHash ?? null,
    proseSource: scene?.promoted ? (lockAfter ? 'human_locked' : 'human_edited') : null,
    locked: Boolean(scene?.promoted && lockAfter),
    released: scene?.released ?? false,
    promoted: scene?.promoted ?? false,
    releaseDecision: scene?.releaseDecision ?? null,
    publication: result.publication,
    editorialErrors: result.editorialErrors,
  };
}

export async function listSourceDocuments(
  request: { projectDir: string },
  runtime?: EditorialRuntime,
): Promise<SourceDocumentV1[]> {
  return workspaceContext(request.projectDir, runtime).sourceWorkspace.list();
}

export async function getSourceDocument(
  request: { projectDir: string; path: string },
  runtime?: EditorialRuntime,
): Promise<SourceDocumentV1> {
  const document = workspaceContext(request.projectDir, runtime).sourceWorkspace.get(request.path);
  if (document === null) {
    throw new EditorialOperationError(
      'SOURCE_DOCUMENT_NOT_FOUND',
      `Source document not found: ${request.path}`,
      { path: request.path },
    );
  }
  return document;
}

export function listSourceRevisions(
  request: { projectDir: string; path?: string },
  runtime?: EditorialRuntime,
): SourceRevisionV1[] {
  return workspaceContext(request.projectDir, runtime).sourceRevisionStore.list(request.path);
}

export function getSourceRevision(
  request: { projectDir: string; revisionId: string },
  runtime?: EditorialRuntime,
): SourceRevisionV1 {
  return workspaceContext(request.projectDir, runtime).sourceRevisionStore.get(request.revisionId);
}

export async function previewSourceChange(
  request: { projectDir: string; changeSet: SourceChangePreviewV1['changeSet'] },
  runtime?: EditorialRuntime,
): Promise<SourceChangePreviewV1> {
  return workspaceContext(request.projectDir, runtime).sourceWorkspace.preview(request.changeSet);
}

export async function applySourceChange(
  request: {
    projectDir: string;
    preview: SourceChangePreviewV1;
    mutation: { operationId: string; actorId: string };
    note?: string;
  },
  runtime?: EditorialRuntime,
): Promise<SourceChangeResultV1> {
  const preview = sourceChangePreviewV1Schema.parse(request.preview) as SourceChangePreviewV1;
  return workspaceContext(request.projectDir, runtime).sourceWorkspace.apply(
    preview.changeSet,
    preview.previewToken,
    request.mutation,
    request.note,
  );
}

export async function reconcileSourceWorkingCopy(
  request: {
    projectDir: string;
    mutation: { operationId: string; actorId: string };
  },
  runtime?: EditorialRuntime,
): Promise<SourceChangeResultV1 | null> {
  return workspaceContext(request.projectDir, runtime).sourceWorkspace.reconcile(request.mutation);
}

export async function inspectScenes(
  request: EditorialScopedRequestV1 & {
    selector?: import('../types/editorial.ts').SceneSelector;
  },
  runtime?: EditorialRuntime,
): Promise<SceneInspection[]> {
  const { selector, ...scopedInput } = request;
  const scoped = parseScopedRequest(scopedInput);
  const context = workspaceContext(scoped.projectDir, runtime);
  const workspace = createWorkspace(
    scoped.projectDir,
    path.relative(scoped.projectDir, context.paths.workDir),
    context.storage,
  );
  if (!scoped.branchPath) {
    if (!selector || selector.type === 'all') {
      return workspace.listScenes();
    }
    if (selector.type === 'events') {
      return selector.eventIds.map((eventId) => workspace.inspectScene(eventId));
    }
    const chapterDir = `chapter-${String(selector.chapter).padStart(2, '0')}`;
    return workspace
      .listScenes()
      .filter((scene) => scene.artifactPaths.scene.split(path.sep).includes(chapterDir));
  }
  const preview = await previewEditorialRun(
    {
      ...scoped,
      selector,
    },
    runtime ?? {},
  );
  return preview.selectedEventIds.map((eventId) => workspace.inspectScene(eventId));
}

export function getSceneRevision(
  request: { projectDir: string; eventId: string; revisionId: string },
  runtime?: EditorialRuntime,
): SceneRevisionEnvelopeV1 {
  const context = workspaceContext(request.projectDir, runtime);
  return new SceneService(context.storage, context.paths).get(request.eventId, request.revisionId);
}

export function listSceneRevisions(
  request: { projectDir: string; eventId: string },
  runtime?: EditorialRuntime,
): SceneRevisionSummary[] {
  const context = workspaceContext(request.projectDir, runtime);
  return new SceneService(context.storage, context.paths).list(request.eventId);
}

export async function getEditorialWorkspace(
  request: EditorialScopedRequestV1,
  runtime?: EditorialRuntime,
): Promise<EditorialWorkspaceSnapshotV1> {
  const scoped = parseScopedRequest(request);
  const context = workspaceContext(scoped.projectDir, runtime);
  return createWorkspace(
    scoped.projectDir,
    path.relative(scoped.projectDir, context.paths.workDir),
    context.storage,
  ).snapshot();
}

export function getEditorialOperation(
  request: { projectDir: string; operationId: string },
  runtime?: EditorialRuntime,
): EditorialOperationV1 {
  const context = workspaceContext(request.projectDir, runtime);
  return new OperationStore(
    new ProjectTransactionCoordinator(context.storage, context.paths),
    context.paths,
    { now: () => Date.now() },
  ).get(request.operationId);
}

export function listEditorialOperations(
  request: { projectDir: string },
  runtime?: EditorialRuntime,
): EditorialOperationV1[] {
  const context = workspaceContext(request.projectDir, runtime);
  return new OperationStore(
    new ProjectTransactionCoordinator(context.storage, context.paths),
    context.paths,
    { now: () => Date.now() },
  ).list();
}

export async function adoptSceneProse(
  request: EditorialScopedRequestV1 & {
    eventId: string;
    input: SceneProseInput;
    mutation: EditorialMutationContext;
    note?: string;
    lockAfter?: boolean;
  },
  runtime: EditorialRuntime = {},
): Promise<SceneActionResult> {
  const parsed = adoptSceneRequestSchema.parse(request);
  const context = workspaceContext(parsed.projectDir, runtime);
  const workspace = createWorkspace(
    parsed.projectDir,
    path.relative(parsed.projectDir, context.paths.workDir),
    context.storage,
  );
  try {
    const inspection = workspace.inspectScene(parsed.eventId);
    const prose = rawProseFromInput(
      parsed.input,
      inspection,
      parsed.input.type === 'working_copy'
        ? authoredChoices(context.storage, parsed.projectDir, parsed.eventId)
        : [],
    );
    const renderRequest: EditorialRenderRequestV1 = {
      version: 1,
      projectDir: parsed.projectDir,
      selector: { type: 'events', eventIds: [parsed.eventId] },
      mutation: parsed.mutation,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.providerProfile ? { providerProfile: parsed.providerProfile } : {}),
      ...(parsed.branchPath ? { branchPath: parsed.branchPath } : {}),
      ...(parsed.discourseBranch ? { discourseBranch: parsed.discourseBranch } : {}),
      ...(parsed.waivers ? { waivers: parsed.waivers } : {}),
    };
    const candidateExecution: EditorialCandidateExecution = {
      operationKind: 'adopt_scene',
      eventId: parsed.eventId,
      prose,
      origin: 'human_edit',
      actionRequestHash: actionRequestHash('adopt_scene', parsed),
      lockAfter: parsed.lockAfter ?? false,
      ...(parsed.note ? { note: parsed.note } : {}),
    };
    const replay = replayCandidateAction(
      context,
      parsed.mutation.operationId,
      'adopt_scene',
      computeCandidateOperationRequestHash(renderRequest, candidateExecution),
    );
    if (replay !== null) return replay;
    if (inspection.locked) {
      const staleLock = inspection.staleReasons.find(
        (reason) => reason.code === 'SCENE_LOCK_STALE',
      );
      throw new EditorialOperationError(
        staleLock ? 'SCENE_LOCK_STALE' : 'SCENE_LOCKED',
        staleLock?.message ?? `Scene ${parsed.eventId} is locked`,
        { eventId: parsed.eventId },
      );
    }
    if (
      parsed.input.type === 'replacement' &&
      (parsed.input.expectedRevisionId !== inspection.revisionId ||
        parsed.input.expectedSceneHash !== inspection.sceneHash)
    ) {
      throw new EditorialOperationError(
        'REVISION_STALE',
        'Accepted scene head changed after it was read',
        { eventId: parsed.eventId },
      );
    }
    if (prose.trim().length === 0) {
      throw new EditorialOperationError('REVISION_BLOCKED', 'Cannot adopt empty prose', {
        eventId: parsed.eventId,
      });
    }
    const renderResult = await executeEditorialRender(renderRequest, runtime, candidateExecution);
    const actionResult = renderResult as RenderNovelResult | SceneActionResult;
    if (!('results' in actionResult)) return actionResult;
    return mapCandidateResult(
      actionResult,
      parsed.eventId,
      parsed.lockAfter ?? false,
      context.storage,
      context.paths,
    );
  } catch (error) {
    return actionError(
      context.storage,
      context.paths,
      parsed.eventId,
      parsed.mutation,
      toEditorialError(error),
    );
  }
}

export async function rollbackSceneRevision(
  request: EditorialScopedRequestV1 & {
    eventId: string;
    revisionId: string;
    mutation: EditorialMutationContext;
    note?: string;
  },
  runtime: EditorialRuntime = {},
): Promise<SceneActionResult> {
  const parsed = rollbackSceneRequestSchema.parse(request);
  const context = workspaceContext(parsed.projectDir, runtime);
  const workspace = createWorkspace(
    parsed.projectDir,
    path.relative(parsed.projectDir, context.paths.workDir),
    context.storage,
  );
  try {
    const target = new SceneService(context.storage, context.paths).get(
      parsed.eventId,
      parsed.revisionId,
    );
    const targetPath = path.join(
      context.paths.sceneRevisionsDir,
      parsed.eventId,
      `${parsed.revisionId}.json`,
    );
    const renderRequest: EditorialRenderRequestV1 = {
      version: 1,
      projectDir: parsed.projectDir,
      selector: { type: 'events', eventIds: [parsed.eventId] },
      mutation: parsed.mutation,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.providerProfile ? { providerProfile: parsed.providerProfile } : {}),
      ...(parsed.branchPath ? { branchPath: parsed.branchPath } : {}),
      ...(parsed.discourseBranch ? { discourseBranch: parsed.discourseBranch } : {}),
      ...(parsed.waivers ? { waivers: parsed.waivers } : {}),
    };
    const candidateExecution: EditorialCandidateExecution = {
      operationKind: 'rollback_scene',
      eventId: parsed.eventId,
      prose: target.prose,
      origin: 'rollback',
      actionRequestHash: actionRequestHash('rollback_scene', parsed),
      restoredFromRevisionId: parsed.revisionId,
      ...(parsed.note ? { note: parsed.note } : {}),
      readSet: [
        {
          kind: 'file',
          path: targetPath,
          expectedHash: computeFileHash(context.storage, targetPath),
        },
      ],
    };
    const replay = replayCandidateAction(
      context,
      parsed.mutation.operationId,
      'rollback_scene',
      computeCandidateOperationRequestHash(renderRequest, candidateExecution),
    );
    if (replay !== null) return replay;
    const inspection = workspace.inspectScene(parsed.eventId);
    if (inspection.revisionId === null) {
      throw new EditorialOperationError(
        'SCENE_NOT_FOUND',
        `Scene ${parsed.eventId} has no accepted head`,
        { eventId: parsed.eventId },
      );
    }
    if (inspection.locked) {
      throw new EditorialOperationError(
        'SCENE_LOCKED',
        `Scene ${parsed.eventId} is locked; unlock it before rollback`,
        { eventId: parsed.eventId },
      );
    }
    if (inspection.revisionId === parsed.revisionId) {
      throw new EditorialOperationError(
        'REVISION_STALE',
        `Revision ${parsed.revisionId} is already the accepted head`,
        { eventId: parsed.eventId },
      );
    }
    const renderResult = await executeEditorialRender(renderRequest, runtime, candidateExecution);
    const actionResult = renderResult as RenderNovelResult | SceneActionResult;
    if (!('results' in actionResult)) return actionResult;
    return mapCandidateResult(actionResult, parsed.eventId, false, context.storage, context.paths);
  } catch (error) {
    return actionError(
      context.storage,
      context.paths,
      parsed.eventId,
      parsed.mutation,
      toEditorialError(error),
    );
  }
}

export async function setSceneLock(
  request: EditorialScopedRequestV1 & {
    eventId: string;
    locked: boolean;
    mutation: EditorialMutationContext;
    note?: string;
    expectedSceneHash: string;
  },
  runtime: EditorialRuntime = {},
): Promise<SceneActionResult> {
  const parsed = setSceneLockRequestSchema.parse(request);
  const context = workspaceContext(parsed.projectDir, runtime);
  const operationPath = path.join(
    context.paths.operationsDir,
    `${parsed.mutation.operationId}.json`,
  );
  const requestHash = computeContentHash(
    JSON.stringify({
      version: 1,
      kind: 'set_scene_lock',
      projectDir: parsed.projectDir,
      eventId: parsed.eventId,
      locked: parsed.locked,
      expectedSceneHash: parsed.expectedSceneHash,
      note: parsed.note ?? null,
    }),
  );
  try {
    const existingRaw = context.storage.readOptional(operationPath);
    if (existingRaw !== null) {
      const existing = editorialOperationV1Schema.parse(
        JSON.parse(existingRaw),
      ) as EditorialOperationV1;
      if (
        existing.kind === 'set_scene_lock' &&
        existing.requestHash === requestHash &&
        existing.status === 'succeeded' &&
        existing.result !== null
      ) {
        return existing.result as SceneActionResult;
      }
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Operation ${parsed.mutation.operationId} already exists with a different request`,
        { operationId: parsed.mutation.operationId },
      );
    }

    const workspace = createWorkspace(
      parsed.projectDir,
      path.relative(parsed.projectDir, context.paths.workDir),
      context.storage,
    );
    const inspection = workspace.inspectScene(parsed.eventId);
    if (
      inspection.revisionId === null ||
      inspection.sceneHash === null ||
      inspection.proseHash === null
    ) {
      throw new EditorialOperationError(
        'SCENE_NOT_FOUND',
        `Scene ${parsed.eventId} has no accepted head`,
        { eventId: parsed.eventId },
      );
    }
    if (inspection.sceneHash !== parsed.expectedSceneHash) {
      throw new EditorialOperationError(
        'SCENE_CONTENT_CONFLICT',
        'Accepted scene bytes changed after they were read',
        { eventId: parsed.eventId },
      );
    }
    const canRecoverStaleLock =
      !parsed.locked &&
      inspection.locked &&
      inspection.staleReasons.length > 0 &&
      inspection.staleReasons.every((reason) => reason.code === 'SCENE_LOCK_STALE');
    if (inspection.state !== 'current' && !canRecoverStaleLock) {
      const reason = inspection.staleReasons[0] ?? {
        code: 'REVISION_STALE' as const,
        message: `Scene ${parsed.eventId} is not current`,
        eventId: parsed.eventId,
      };
      throw new EditorialOperationError(reason.code, reason.message, {
        eventId: parsed.eventId,
        ...(reason.path ? { path: reason.path } : {}),
      });
    }

    const metadataPath = path.join(parsed.projectDir, inspection.artifactPaths.metadata);
    const metadataRaw = context.storage.read(metadataPath);
    const metadata = sceneMetadataV1Schema.parse(YAML.parse(metadataRaw));
    const head = new SceneService(context.storage, context.paths).get(
      parsed.eventId,
      inspection.revisionId,
    );
    const publication = currentPublication(context.storage, context.paths);
    const alreadyDesired = inspection.locked === parsed.locked;
    const now = new Date().toISOString();
    const result: SceneActionResult = {
      operationId: parsed.mutation.operationId,
      eventId: parsed.eventId,
      revisionId: inspection.revisionId,
      proseHash: inspection.proseHash,
      sceneHash: inspection.sceneHash,
      proseSource: parsed.locked ? 'human_locked' : 'human_edited',
      locked: parsed.locked,
      released: true,
      promoted: false,
      releaseDecision: head.releaseDecision,
      publication,
      editorialErrors: [],
    };
    const operation: EditorialOperationV1 = {
      version: 1,
      operationId: parsed.mutation.operationId,
      kind: 'set_scene_lock',
      actorId: parsed.mutation.actorId,
      requestHash,
      status: 'succeeded',
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: now,
      completedAt: now,
      result,
      errors: [],
    };
    const lockPath = path.join(context.paths.workDir, 'locks', `${parsed.eventId}.lock`);
    const readSet = [
      {
        kind: 'file' as const,
        path: operationPath,
        expectedHash: null,
      },
      {
        kind: 'file' as const,
        path: metadataPath,
        expectedHash: computeContentHash(metadataRaw),
      },
      {
        kind: 'file' as const,
        path: lockPath,
        expectedHash: computeFileHash(context.storage, lockPath),
      },
    ];
    const writes: StorageWrite[] = [
      {
        type: 'put' as const,
        path: operationPath,
        content: stableJson(operation),
        expectedHash: null,
      },
    ];
    if (!alreadyDesired) {
      const updatedMetadata = {
        ...metadata,
        prose_source: parsed.locked ? ('human_locked' as const) : ('human_edited' as const),
        edit_history: [
          ...metadata.edit_history,
          {
            action: parsed.locked ? ('locked' as const) : ('unlocked' as const),
            actor_id: parsed.mutation.actorId,
            operation_id: parsed.mutation.operationId,
            timestamp: now,
            revision_id: inspection.revisionId,
            ...(parsed.note ? { note: parsed.note } : {}),
          },
        ],
      };
      writes.push({
        type: 'put',
        path: metadataPath,
        content: `${YAML.stringify(updatedMetadata, { lineWidth: 120 })}\n`,
        expectedHash: computeContentHash(metadataRaw),
      });
      if (parsed.locked) {
        writes.push({
          type: 'put',
          path: lockPath,
          content: stableJson({
            revisionId: inspection.revisionId,
            proseHash: inspection.proseHash,
            lockedAt: now,
            actorId: parsed.mutation.actorId,
          }),
          expectedHash: computeFileHash(context.storage, lockPath),
        });
      } else if (context.storage.exists(lockPath)) {
        writes.push({
          type: 'delete',
          path: lockPath,
          expectedHash: computeFileHash(context.storage, lockPath),
        });
      }
    }
    new ProjectTransactionCoordinator(context.storage, context.paths).commit({
      transactionId: parsed.mutation.operationId,
      readSet,
      writes,
    });
    return result;
  } catch (error) {
    return actionError(
      context.storage,
      context.paths,
      parsed.eventId,
      parsed.mutation,
      toEditorialError(error),
    );
  }
}

// ─── Release-Aware Assembly ──────────────────────────────────────────────────

/**
 * Canonical assembly: validate publication-manifest heads, build the novel,
 * and atomically update the canonical novel and manifest via
 * ProjectTransactionCoordinator.  Direct edits to the canonical novel are
 * detected and surfaced as PUBLICATION_CONTENT_CONFLICT.
 */
export function assembleCanonicalNovel(
  request: AssembleRequestV1,
  runtime?: { storage?: Storage; clock?: { now(): number } },
): EditorialAssembleResult {
  const storage = runtime?.storage ?? new FsStorage();
  return canonicalAssemble(request, storage, runtime);
}

/**
 * Custom output assembly: validate the same heads but write only to the
 * custom output path.  Never touches canonical novel, manifest, or derived
 * data.  Records a terminal `assemble` operation for traceability.
 */
export function assembleCustomNovel(
  request: AssembleRequestV1,
  runtime?: { storage?: Storage; clock?: { now(): number } },
): EditorialAssembleResult {
  const storage = runtime?.storage ?? new FsStorage();
  return customAssemble(request, storage, runtime);
}
