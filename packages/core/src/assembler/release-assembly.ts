import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import { includesPath } from '../branch/set.ts';
import type { BranchPath, BranchSet, Condition } from '../types/branch.ts';
import type {
  AssembleRequestV1,
  EditorialAssembleResult,
  EditorialError,
  PublicationManifestV1,
  SceneProseSource,
  SceneRevisionEnvelopeV1,
} from '../types/editorial.ts';
import { PublicationError } from '../editorial/errors.ts';
import { sha256 } from '../cache/pure-sha256.ts';
import { buildNovelDocument, type PromoteCandidateInput, type VerifiedHeadData } from './publication-model.ts';
import type { GameDialogueChoice } from '../types/index.ts';
import type { JsonObject } from '../contracts/json.ts';
import type { ChapterMetadata } from '../types/chapter.ts';

export interface VerifiedAssemblyScene {
  eventId: string;
  chapterNumber: number;
  narrativeOrder: number;
  head: VerifiedHeadData;
  prose: string;
  branchExistence: BranchSet;
  playerChoices?: readonly GameDialogueChoice[];
  proseSource: 'llm' | 'human_edited' | 'human_locked';
  modelUsed?: string;
  renderedAt: string;
  wordCount: number;
  editHistory: readonly never[];
}

export interface AssemblySemanticInput {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly manifest: PublicationManifestV1;
  readonly revisions: ReadonlyMap<string, SceneRevisionEnvelopeV1>;
  readonly scenes: ReadonlyMap<string, { prose: string; chapterNumber: number; metadata: JsonObject }>;
  readonly discourseSequence: readonly { sceneId: string; sequence: number; chapter: number }[];
  readonly chapterTitles?: ReadonlyMap<number, ChapterMetadata>;
}

function error(code: EditorialError['code'], message: string, eventId?: string): EditorialError {
  return { code, message, ...(eventId ? { eventId } : {}) };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toGameDialogueChoices(value: JsonObject['player_choices']): GameDialogueChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices: GameDialogueChoice[] = [];
  for (const candidate of value) {
    if (!isJsonObject(candidate) || typeof candidate.id !== 'string' || typeof candidate.label !== 'string' || typeof candidate.description !== 'string' || typeof candidate.targetEvent !== 'string' || !Array.isArray(candidate.effects)) return undefined;
    const effects: GameDialogueChoice['effects'] = [];
    for (const effect of candidate.effects) {
      if (!isJsonObject(effect) || typeof effect.entity !== 'string' || typeof effect.attribute !== 'string') return undefined;
      if (effect.narrativeHint !== undefined && typeof effect.narrativeHint !== 'string') return undefined;
      if (effect.confidence !== undefined && (typeof effect.confidence !== 'number' || !Number.isFinite(effect.confidence))) return undefined;
      if (effect.operation !== undefined && effect.operation !== 'set' && effect.operation !== 'unset') return undefined;
      effects.push({
        entity: effect.entity,
        attribute: effect.attribute,
        ...(effect.value !== undefined ? { value: effect.value } : {}),
        ...(effect.narrativeHint !== undefined ? { narrativeHint: effect.narrativeHint } : {}),
        ...(effect.confidence !== undefined ? { confidence: effect.confidence } : {}),
        ...(effect.operation !== undefined ? { operation: effect.operation } : {}),
      });
    }
    choices.push({ id: candidate.id, label: candidate.label, description: candidate.description, targetEvent: candidate.targetEvent, effects });
  }
  return choices;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const toSceneProseSource = (value: unknown): SceneProseSource =>
  value === 'human_edited' || value === 'human_locked' ? value : 'llm';

const toCondition = (value: unknown): Condition | undefined => {
  if (!isJsonObject(value)) return undefined;
  if (value.type === 'and' || value.type === 'or') {
    if (!Array.isArray(value.conditions)) return undefined;
    const conditions = value.conditions.map(toCondition);
    if (conditions.some((condition) => condition === undefined)) return undefined;
    return { type: value.type, conditions: conditions.filter((condition): condition is Condition => condition !== undefined) };
  }
  if (
    value.type !== 'equals' &&
    value.type !== 'not_equals' &&
    value.type !== 'greater_than' &&
    value.type !== 'less_than' &&
    value.type !== 'contains'
  ) {
    return undefined;
  }
  if (value.field !== undefined && typeof value.field !== 'string') return undefined;
  return {
    type: value.type,
    ...(value.field === undefined ? {} : { field: value.field }),
    ...(value.value === undefined ? {} : { value: value.value }),
  };
};

const toBranchPath = (value: unknown): BranchPath | undefined => {
  if (!isJsonObject(value) || !Array.isArray(value.decisions)) return undefined;
  const decisions = [];
  for (const candidate of value.decisions) {
    if (
      !isJsonObject(candidate) ||
      typeof candidate.atEventId !== 'string' ||
      typeof candidate.choiceId !== 'string' ||
      !isFiniteNumber(candidate.narrativeOrder)
    ) {
      return undefined;
    }
    decisions.push({
      atEventId: candidate.atEventId,
      choiceId: candidate.choiceId,
      narrativeOrder: candidate.narrativeOrder,
    });
  }
  return { decisions };
};

const toBranchSet = (value: unknown): BranchSet | undefined => {
  if (!isJsonObject(value)) return undefined;
  if (value.type === 'all') return { type: 'all' };
  if (value.type === 'paths' && Array.isArray(value.paths)) {
    const paths = value.paths.map(toBranchPath);
    if (paths.some((path) => path === undefined)) return undefined;
    return {
      type: 'paths',
      paths: paths.filter((path): path is BranchPath => path !== undefined),
    };
  }
  if (value.type === 'condition') {
    const condition = toCondition(value.condition);
    return condition ? { type: 'condition', condition } : undefined;
  }
  if (value.type === 'except') {
    const branches = toBranchSet(value.branches);
    return branches ? { type: 'except', branches } : undefined;
  }
  return undefined;
};

export async function validateManifestHeads(
  manifest: PublicationManifestV1,
  repository: CoreExecutionRepository,
  input: AssemblySemanticInput,
  branchPath?: BranchPath | null,
  requiredEvents?: ReadonlyMap<string, number>,
): Promise<{ scenes: Map<string, VerifiedAssemblyScene>; errors: EditorialError[] }> {
  const scenes = new Map<string, VerifiedAssemblyScene>();
  const errors: EditorialError[] = [];
  const entries = requiredEvents ? [...requiredEvents.keys()] : Object.keys(manifest.revision_ids);
  for (const eventId of entries) {
    const revisionId = manifest.revision_ids[eventId];
    if (!revisionId) {
      errors.push(error('PUBLICATION_INCOMPLETE', `Required event ${eventId} has no published revision`, eventId));
      continue;
    }
    const scene = input.scenes.get(eventId);
    const envelope = input.revisions.get(eventId);
    if (!scene || !envelope) {
      errors.push(error('SCENE_NOT_FOUND', `Scene ${eventId} is not present in the materialized source`, eventId));
      continue;
    }
    if (
      envelope.revisionId !== revisionId ||
      envelope.releaseDecision.status !== 'accepted' ||
      !envelope.released
    ) {
      errors.push(error('REVISION_BLOCKED', `Revision ${revisionId} for event ${eventId} is not accepted`, eventId));
      continue;
    }
    const accepted = await repository.resolveAcceptedArtifact({
      projectId: input.projectId,
      eventId,
    });
    if (
      accepted === null ||
      accepted.sourceHash !== input.sourceHash ||
      accepted.revisionId !== envelope.revisionId ||
      accepted.prose !== envelope.prose ||
      accepted.proseHash !== envelope.proseHash ||
      accepted.sceneHash !== envelope.sceneHash
    ) {
      errors.push(error('REVISION_STALE', `Accepted artifact for event ${eventId} no longer matches its manifest head`, eventId));
      continue;
    }
    if (sha256(scene.prose) !== envelope.sceneHash) {
      errors.push(error('PUBLICATION_CONTENT_CONFLICT', `Scene hash mismatch for event ${eventId}`, eventId));
      continue;
    }
    const metadata = scene.metadata;
    const branchExistence: BranchSet = toBranchSet(metadata.branch_existence) ?? { type: 'all' };
    if (branchPath && !includesPath(branchExistence, branchPath)) continue;
    const head: VerifiedHeadData = {
      revisionId: envelope.revisionId,
      proseHash: envelope.proseHash,
      prose: envelope.prose,
      sceneHash: envelope.sceneHash,
      editorialBasisHash: envelope.editorialBasisHash,
      scopeHash: envelope.scopeHash,
      validationIdentity: envelope.validationIdentity,
      proseSource: toSceneProseSource(metadata.prose_source),
      ...(typeof metadata.model_used === 'string' ? { modelUsed: metadata.model_used } : {}),
      renderedAt: typeof metadata.rendered_at === 'string' ? metadata.rendered_at : envelope.createdAt,
      wordCount: isFiniteNumber(metadata.word_count) ? metadata.word_count : 0,
      editHistory: [],
      playerChoices: toGameDialogueChoices(metadata.player_choices),
      branchExistence,
    };
    scenes.set(eventId, {
      eventId,
      chapterNumber: scene.chapterNumber,
      narrativeOrder:
        requiredEvents?.get(eventId) ??
        (isFiniteNumber(metadata.narrative_order) ? metadata.narrative_order : 0),
      head,
      prose: scene.prose,
      branchExistence,
      proseSource: head.proseSource,
      modelUsed: head.modelUsed,
      renderedAt: head.renderedAt,
      wordCount: head.wordCount,
      editHistory: [],
    });
  }
  return { scenes, errors };
}

async function assemble(
  input: AssemblySemanticInput,
  request: AssembleRequestV1,
  repository: CoreExecutionRepository,
): Promise<EditorialAssembleResult> {
  const { scenes, errors } = await validateManifestHeads(
    input.manifest,
    repository,
    input,
    request.branchPath,
  );
  if (errors.length) throw new PublicationError('Assembly inputs are incomplete', errors);
  const ordered = input.discourseSequence
    .map((entry) => scenes.get(entry.sceneId))
    .filter((scene): scene is VerifiedAssemblyScene => scene !== undefined);
  const candidates: PromoteCandidateInput[] = ordered.map((scene) => ({
    eventId: scene.eventId,
    chapterNumber: scene.chapterNumber,
    head: scene.head,
    event: {
      eventId: scene.eventId,
      narrativeOrder: scene.narrativeOrder,
      threadProgress: [],
      foreshadowing: [],
      relationshipEffects: [],
      ruleEffects: [],
    },
    scene: { prose: scene.prose },
  }));
  const titles = new Map<number, { title: string }>();
  for (const [chapter, metadata] of input.chapterTitles ?? []) {
    titles.set(chapter, { title: metadata.title });
  }
  const markdown = buildNovelDocument(
    candidates,
    titles,
    request.title ?? 'Untitled',
    input.discourseSequence.map((entry) => ({
      sceneId: entry.sceneId,
      sequence: entry.sequence,
      chapter: entry.chapter,
    })),
  );
  return {
    operationId: request.mutation.operationId,
    markdown,
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
    sceneCount: candidates.length,
    publication: {
      status: 'current',
      outputPath: '',
      novelHash: sha256(markdown),
      reasons: [],
    },
  };
}

export function canonicalAssemble(
  request: AssembleRequestV1,
  input: AssemblySemanticInput,
  repository: CoreExecutionRepository,
): Promise<EditorialAssembleResult> {
  return assemble(input, request, repository);
}

export function customAssemble(
  request: AssembleRequestV1,
  input: AssemblySemanticInput,
  repository: CoreExecutionRepository,
): Promise<EditorialAssembleResult> {
  return assemble(input, request, repository);
}
