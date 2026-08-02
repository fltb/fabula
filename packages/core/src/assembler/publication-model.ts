import { NARRATIVE_TEXT_COUNT_VERSION } from './count.ts';
import type { DerivedData } from '../pipeline/output.ts';
import type { BranchSet } from '../types/branch.ts';
import type {
  SceneEditHistoryEntryV1,
  SceneMetadataV1,
  SceneProseSource,
  SceneRevisionEnvelopeV1,
} from '../types/editorial.ts';
import type { GameDialogueChoice } from '../types/game-dialogue.ts';
import type { DiscourseSceneSequenceEntry } from '../types/graph.ts';
import { PublicationError } from '../editorial/errors.ts';

/** Verified accepted/current head data independent of Host persistence. */
export interface VerifiedHeadData {
  readonly revisionId: string;
  readonly proseHash: string;
  readonly prose: string;
  readonly sceneHash: string;
  readonly editorialBasisHash: string;
  readonly scopeHash: string;
  readonly validationIdentity: string;
  readonly proseSource: SceneProseSource;
  readonly modelUsed?: string;
  readonly renderedAt: string;
  readonly wordCount: number;
  readonly editHistory: readonly SceneEditHistoryEntryV1[];
  readonly playerChoices?: readonly GameDialogueChoice[];
  readonly branchExistence: BranchSet;
}

/** Event data used to compute purely derived execution summaries. */
export interface ScopeEventData {
  readonly eventId: string;
  readonly narrativeOrder: number;
  readonly threadProgress: readonly ScopeThreadProgressEntry[];
  readonly foreshadowing: readonly ScopeForeshadowEntry[];
  readonly relationshipEffects: readonly ScopeRelationshipEntry[];
  readonly ruleEffects: readonly ScopeRuleEntry[];
}

export interface ScopeThreadProgressEntry {
  readonly thread: string;
  readonly advancement: string;
  readonly progressAfter: number;
  readonly progressTotal: number;
}

export interface ScopeForeshadowEntry {
  readonly hint: string;
  readonly targetRevealChapter: number;
  readonly thread?: string;
}

export interface ScopeRelationshipEntry {
  readonly membershipAfter?: ReadonlyArray<{ readonly entityId: string }>;
  readonly dimensionSet?: ReadonlyArray<{ readonly dimensionId: string; readonly value: unknown }>;
  readonly provenance?: string;
}

export interface ScopeRuleEntry {
  readonly rule: string;
  readonly effect: string;
  readonly evidence: string;
}

/** A verified scene input for pure assembly and derived-data construction. */
export interface PromoteCandidateInput {
  readonly eventId: string;
  readonly chapterNumber: number;
  readonly head: VerifiedHeadData;
  readonly event: ScopeEventData;
  readonly scene: {
    readonly prose: string;
    readonly renderRequest?: Record<string, unknown>;
  };
}

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function collectDerivedData(
  scopeEvents: readonly ScopeEventData[],
  verifiedHeads: ReadonlyMap<string, VerifiedHeadData>,
): DerivedData {
  const threads: Record<string, unknown> = {};
  const foreshadowing: Array<Record<string, unknown>> = [];
  const relationships: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];

  for (const event of scopeEvents) {
    if (!verifiedHeads.has(event.eventId)) continue;

    for (const progress of event.threadProgress) {
      threads[progress.thread] = {
        advancement: progress.advancement,
        progressAfter: progress.progressAfter,
        progressTotal: progress.progressTotal,
      };
    }

    for (const hint of event.foreshadowing) {
      foreshadowing.push({
        eventId: event.eventId,
        hint: hint.hint,
        targetChapter: hint.targetRevealChapter,
        thread: hint.thread,
      });
    }

    for (const effect of event.relationshipEffects) {
      const participants = effect.membershipAfter?.map((member) => member.entityId) ?? [];
      const direction = effect.dimensionSet?.find((dimension) => dimension.dimensionId === 'direction');
      const type = effect.dimensionSet?.find((dimension) => dimension.dimensionId === 'type');
      const intensity = effect.dimensionSet?.find((dimension) => dimension.dimensionId === 'intensity');
      relationships.push({
        participants: participants.length >= 2 ? [participants[0], participants[1]] : [],
        effect: effect.provenance?.replace('compat:RelationshipChange:', '') ?? 'change',
        direction: stringValue(direction?.value),
        newState:
          type || intensity
            ? {
                type: stringValue(type?.value),
                intensity: numberValue(intensity?.value),
              }
            : undefined,
      });
    }

    for (const effect of event.ruleEffects) {
      rules.push({
        rule: effect.rule,
        effect: effect.effect,
        evidence: effect.evidence,
        eventId: event.eventId,
      });
    }
  }

  return { threads, foreshadowing, relationships, rules };
}

export function buildSceneMetadataV1(
  eventId: string,
  narrativeOrder: number,
  head: VerifiedHeadData,
): SceneMetadataV1 {
  return {
    schema_version: 1,
    event: eventId,
    narrative_order: narrativeOrder,
    revision_id: head.revisionId,
    prose_source: head.proseSource,
    prose_hash: head.proseHash,
    scene_hash: head.sceneHash,
    editorial_basis_hash: head.editorialBasisHash,
    scope_hash: head.scopeHash,
    validation_identity: head.validationIdentity,
    model_used: head.modelUsed,
    rendered_at: head.renderedAt,
    word_count: head.wordCount,
    text_count_version: NARRATIVE_TEXT_COUNT_VERSION,
    edit_history: [...head.editHistory],
    branch_existence: head.branchExistence,
    player_choices: head.playerChoices ? [...head.playerChoices] : undefined,
  };
}

export function envelopeToVerifiedHead(
  envelope: SceneRevisionEnvelopeV1,
  proseSource: SceneProseSource,
): VerifiedHeadData {
  return {
    revisionId: envelope.revisionId,
    proseHash: envelope.proseHash,
    prose: envelope.prose,
    sceneHash: envelope.sceneHash,
    editorialBasisHash: envelope.editorialBasisHash,
    scopeHash: envelope.scopeHash,
    validationIdentity: envelope.validationIdentity,
    proseSource,
    modelUsed: envelope.modelUsed,
    renderedAt: envelope.createdAt,
    wordCount: 0,
    editHistory: [],
    branchExistence: { type: 'all' },
  };
}

/**
 * Build the complete novel document in the mandatory discourse sequence.
 * Every candidate must occur exactly once in that sequence.
 */
export function buildNovelDocument(
  candidates: readonly PromoteCandidateInput[],
  chapterMetadata: ReadonlyMap<number, { title: string }>,
  novelTitle: string,
  sceneSequence: readonly DiscourseSceneSequenceEntry[],
): string {
  const parts: string[] = [`# ${novelTitle}`];
  const byId = new Map<string, PromoteCandidateInput>();
  for (const candidate of candidates) {
    if (byId.has(candidate.eventId)) {
      throw new PublicationError('Duplicate candidate', [{
        code: 'REVISION_STALE',
        message: `Duplicate candidate for event "${candidate.eventId}" in buildNovelDocument`,
        eventId: candidate.eventId,
      }]);
    }
    byId.set(candidate.eventId, candidate);
  }

  let currentChapter: number | null = null;
  const seen = new Set<string>();
  for (const entry of sceneSequence) {
    const candidate = byId.get(entry.sceneId);
    if (!candidate) {
      throw new PublicationError('Candidate not found for scene sequence entry', [{
        code: 'PUBLICATION_INCOMPLETE',
        message: `Scene sequence entry "${entry.sceneId}" has no matching candidate in buildNovelDocument`,
        eventId: entry.sceneId,
      }]);
    }
    if (seen.has(entry.sceneId)) {
      throw new PublicationError('Duplicate scene in sequence', [{
        code: 'REVISION_STALE',
        message: `Scene "${entry.sceneId}" appears more than once in the scene sequence`,
        eventId: entry.sceneId,
      }]);
    }
    seen.add(entry.sceneId);

    if (entry.chapter !== candidate.chapterNumber) {
      throw new PublicationError('Chapter mismatch in scene sequence', [{
        code: 'REVISION_STALE',
        message: `Scene "${entry.sceneId}" has chapter ${entry.chapter} in sequence but candidate has chapter ${candidate.chapterNumber}`,
        eventId: entry.sceneId,
      }]);
    }

    if (entry.chapter !== currentChapter) {
      currentChapter = entry.chapter;
      const title = chapterMetadata.get(currentChapter)?.title;
      parts.push(
        '',
        title ? `## Chapter ${currentChapter}: ${title}` : `## Chapter ${currentChapter}`,
        '',
      );
    }
    parts.push(candidate.scene.prose.trimEnd(), '');
  }

  for (const candidate of candidates) {
    if (!seen.has(candidate.eventId)) {
      throw new PublicationError('Candidate not in scene sequence', [{
        code: 'PUBLICATION_INCOMPLETE',
        message: `Candidate "${candidate.eventId}" is not covered by the scene sequence`,
        eventId: candidate.eventId,
      }]);
    }
  }

  return `${parts.join('\n').trimEnd()}\n`;
}
