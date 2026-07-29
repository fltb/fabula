// ============================================================================
// Editorial Publisher — transaction‑aware safe publication of scene promotions
// ============================================================================
//
// Design:
//   collectDerivedData — pure collection from verified accepted/current heads
//   buildSceneMetadataV1 — strict snake‑case SceneMetadataV1 builder
//   EditorialPublisher — validates candidate read set, atomically writes
//     scene/metadata/request/derived/manifest, determines novel staleness.
//
//   Only a full‑scope promotion with zero reasons writes a 'current' manifest
//   and updates novel output. Partial/blocked promotions retain old novel
//   bytes/hash/assembled‑at and produce a 'stale' manifest with reasons.
// ============================================================================

import * as path from 'node:path';
import YAML from 'yaml';
import { NARRATIVE_TEXT_COUNT_VERSION } from '../assembler/count.ts';
import type { DerivedData } from '../pipeline/output.ts';
import { computeContentHash } from '../storage/hash.ts';
import type { StorageWrite, TransactionReadExpectation } from '../storage/types.ts';
import type { BranchSet } from '../types/branch.ts';
import type {
  EditorialError,
  EditorialMutationContext,
  PublicationManifestV1,
  PublicationResult,
  SceneEditHistoryEntryV1,
  SceneMetadataV1,
  SceneProseSource,
  SceneRevisionEnvelopeV1,
} from '../types/editorial.ts';
import type { GameDialogueChoice } from '../types/game-dialogue.ts';
import { PublicationError } from './errors.ts';
import type { ProjectPaths } from './paths.ts';
import { type ProjectTransactionCoordinator, stableJson } from './transaction.ts';

// ─── Input Types ────────────────────────────────────────────────────────────

/** Verified accepted/current head data from a scene revision envelope. */
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

/** Event data for derived collection (non‑prose metadata extracted from events). */
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

/** A single candidate for promotion. */
export interface PromoteCandidateInput {
  readonly eventId: string;
  readonly chapterNumber: number;
  readonly head: VerifiedHeadData;
  /** True only for a newly promoted head; verified unchanged heads are read-only. */
  readonly promote?: boolean;
  /** Read-set captured before candidate evaluation. */
  readonly readSet?: readonly TransactionReadExpectation[];
  /** Accepted candidate envelope to install as the latest response atomically with its head. */
  readonly latestEnvelope?: SceneRevisionEnvelopeV1;
  /** Optional lock installed with an accepted human head. */
  readonly lock?: {
    readonly actorId: string;
    readonly lockedAt: string;
  };
  readonly event: ScopeEventData;
  readonly scene: {
    readonly prose: string;
    readonly renderRequest?: Record<string, unknown>;
  };
}

/** The scope for a publish operation — which branch, events, and mutation context. */
export interface PublishScope {
  readonly projectDir: string;
  readonly branchScopeHash: string;
  readonly scopeEventIds: readonly string[];
  readonly scopeEvents: readonly ScopeEventData[];
  readonly mutationContext: EditorialMutationContext;
}

// ─── Derived Data Collection ───────────────────────────────────────────────

/**
 * Collect derived reference data from every verified accepted/current head
 * in scope. Only events present in `verifiedHeads` contribute derived entries.
 *
 * Mirrors the shape of DerivedData in pipeline/output.ts but sources its
 * data from scope events filtered by verified heads rather than render results.
 */
export function collectDerivedData(
  scopeEvents: readonly ScopeEventData[],
  verifiedHeads: ReadonlyMap<string, VerifiedHeadData>,
): DerivedData {
  const threads: Record<string, unknown> = {};
  const foreshadowing: Array<Record<string, unknown>> = [];
  const relationships: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];

  for (const ev of scopeEvents) {
    if (!verifiedHeads.has(ev.eventId)) continue;

    // Thread progress — keyed by thread ID
    for (const tp of ev.threadProgress) {
      threads[tp.thread] = {
        advancement: tp.advancement,
        progressAfter: tp.progressAfter,
        progressTotal: tp.progressTotal,
      };
    }

    // Foreshadowing — array of { eventId, hint, targetChapter }
    for (const f of ev.foreshadowing) {
      foreshadowing.push({
        eventId: ev.eventId,
        hint: f.hint,
        targetChapter: f.targetRevealChapter,
        thread: f.thread,
      });
    }

    // Relationship effects — derive participants, direction, type, intensity
    for (const re of ev.relationshipEffects) {
      const participants = re.membershipAfter?.map((m) => m.entityId) ?? [];
      const directionDim = re.dimensionSet?.find((d) => d.dimensionId === 'direction');
      const typeDim = re.dimensionSet?.find((d) => d.dimensionId === 'type');
      const intensityDim = re.dimensionSet?.find((d) => d.dimensionId === 'intensity');
      relationships.push({
        participants: participants.length >= 2 ? [participants[0], participants[1]] : [],
        effect: re.provenance?.replace('compat:RelationshipChange:', '') ?? 'change',
        direction: (directionDim?.value as string) ?? '',
        newState:
          typeDim || intensityDim
            ? {
                type: (typeDim?.value as string) ?? '',
                intensity: (intensityDim?.value as number) ?? 0,
              }
            : undefined,
      });
    }

    // Rule effects — each entry carries the rule as key
    for (const r of ev.ruleEffects) {
      rules.push({
        rule: r.rule,
        effect: r.effect,
        evidence: r.evidence,
        eventId: ev.eventId,
      });
    }
  }

  return { threads, foreshadowing, relationships, rules };
}

// ─── Scene Metadata Builder ────────────────────────────────────────────────

/** Build a strict snake_case SceneMetadataV1 object from verified head data. */
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

// ============================================================================
// Utility: Convert SceneRevisionEnvelope to VerifiedHeadData
// ============================================================================

/**
 * Convert a SceneRevisionEnvelopeV1 to VerifiedHeadData for the publisher.
 * Extracts all metadata fields from the envelope into the publisher-consumable shape.
 */
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
    wordCount: 0, // computed externally
    editHistory: [],
    branchExistence: { type: 'all' },
  };
}
// ============================================================================
// Novel Document Builder
// ============================================================================

/**
 * Build the full novel markdown document from verified head revisions.
 *
 * @param verifiedHeads     Map of eventId → verified head data (already sorted).
 * @param chapterMetadata   Map of chapter number → { title }.
 * @param novelTitle        The novel's title.
 * @param choicesByEventId  Optional map of eventId → game dialogue choices
 *                          for appending player-choice blocks.
 * @returns The novel markdown string, with chapter headings and scene prose.
 */
export function buildNovelDocument(
  candidates: readonly PromoteCandidateInput[],
  chapterMetadata: ReadonlyMap<number, { title: string }>,
  novelTitle: string,
): string {
  const parts: string[] = [`# ${novelTitle}`];
  const sorted = [...candidates].sort(
    (left, right) =>
      left.event.narrativeOrder - right.event.narrativeOrder ||
      left.eventId.localeCompare(right.eventId),
  );
  let currentChapter: number | null = null;
  for (const candidate of sorted) {
    if (candidate.chapterNumber !== currentChapter) {
      currentChapter = candidate.chapterNumber;
      const title = chapterMetadata.get(currentChapter)?.title ?? `Chapter ${currentChapter}`;
      parts.push('', `## ${title}`, '');
    }
    parts.push(candidate.scene.prose.trimEnd(), '');
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

// ─── Publication Manifest Helpers ──────────────────────────────────────────

/**
 * Detect whether the novel has been directly edited by comparing its current
 * content hash against the expected hash from the publication manifest.
 * Returns the actual hash if a direct edit is detected, null otherwise.
 */
export function detectDirectNovelEdit(
  storage: { readOptional(path: string): string | null },
  novelPath: string,
  expectedNovelHash: string | null,
): string | null {
  const content = storage.readOptional(novelPath);
  if (content === null) return null;
  const actualHash = computeContentHash(content);
  if (expectedNovelHash !== null && actualHash !== expectedNovelHash) {
    return actualHash;
  }
  return null;
}

// ─── Editorial Publisher ───────────────────────────────────────────────────

export interface PublishOptions {
  /** The scope (branch, events, mutation context). */
  readonly scope: PublishScope;
  /** Candidates to promote. */
  readonly candidates: readonly PromoteCandidateInput[];
  /** Previous manifest — read before publish to derive state. */
  readonly previousManifest: PublicationManifestV1;
  /**
   * SHA-256 hash of the previous manifest content as read from storage.
   * This is the expected hash for readSet verification.
   * When the caller modifies `previousManifest` in memory (e.g. updating
   * status/reasons), the readSet MUST check the ORIGINAL stored hash,
   * not the hash of the modified in-memory object.
   */
  readonly previousManifestHash: string | null;
  /** Novel document content (null = skip novel write). */
  readonly novelContent: string | null;
  /** SHA-256 content hash of novelContent (null if no novel). */
  readonly novelHash: string | null;
  /** Reasons preventing a current publication in this invocation. */
  readonly reasons?: readonly EditorialError[];
  /** Global publication/derived read-set captured before provider execution. */
  readonly readSet?: readonly TransactionReadExpectation[];
  /** Publication gate: novel requires novelContent; tree requires supplemental output. */
  readonly publicationMode?: 'novel' | 'tree';
  /** Additional authoritative outputs committed with scene/derived/manifest writes. */
  readonly additionalWrites?: readonly StorageWrite[];
  /** Result output path for non-novel publication modes. */
  readonly outputPath?: string;
}

/**
 * Transaction-aware publisher for editorial scene promotions.
 *
 * Each publish() call:
 *   1. Collects derived data from every verified accepted/current head
 *   2. Validates read set (no active operation conflicts)
 *   3. Builds storage writes for scene files, derived data, manifest
 *   4. Determines novel staleness: only full-scope promotion with zero
 *      reasons produces 'current' and writes the novel
 *   5. Commits as a single atomic workspace transaction
 *
 * Publication invariants:
 *   - Single-scene promotion preserves other derived entries
 *   - Second conflict leaves first head/derived but novel stale
 *   - Blocked latest does not invalidate accepted predecessor
 *   - Direct novel conflict preserves bytes/evidence
 *   - All metadata strict snake_case V1
 */
export class EditorialPublisher {
  constructor(
    private readonly coordinator: ProjectTransactionCoordinator,
    private readonly paths: ProjectPaths,
  ) {}

  /**
   * Promote candidates atomically within the workspace transaction.
   *
   * @returns PublicationResult describing the novel state after publication.
   * @throws PublicationError if read set validation fails.
   */
  publish(options: PublishOptions): PublicationResult {
    const {
      scope,
      candidates,
      previousManifest,
      previousManifestHash,
      novelContent,
      novelHash,
      reasons: invocationReasons = [],
      publicationMode = 'novel',
      additionalWrites = [],
      outputPath = this.paths.novelPath,
    } = options;

    // Build verified heads map
    const verifiedHeads = new Map<string, VerifiedHeadData>();
    for (const c of candidates) {
      verifiedHeads.set(c.eventId, c.head);
    }

    // ── Step 1: Collect derived data from verified heads ────────────
    const derived = collectDerivedData(scope.scopeEvents, verifiedHeads);

    // ── Step 2: Build the pre-evaluation read set ─────────────────
    const readSet: TransactionReadExpectation[] = [
      ...(options.readSet ?? []),
      ...candidates.flatMap((candidate) => candidate.readSet ?? []),
    ];
    const publicationExpectation = readSet.find(
      (expectation) =>
        expectation.kind === 'file' && expectation.path === this.paths.publicationPath,
    );
    if (publicationExpectation === undefined) {
      readSet.push({
        kind: 'file',
        path: this.paths.publicationPath,
        expectedHash: previousManifestHash,
      });
    }

    const expectedFileHash = (filePath: string): string | null => {
      const expectation = readSet.find(
        (candidate) => candidate.kind === 'file' && candidate.path === filePath,
      );
      if (expectation?.kind !== 'file') {
        throw new PublicationError('Publication read set is incomplete', [
          {
            code: 'REVISION_STALE',
            message: `No pre-evaluation read expectation for ${filePath}`,
            path: filePath,
          },
        ]);
      }
      return expectation.expectedHash;
    };

    // Check for active operation conflict
    if (
      previousManifest.active_operation_id &&
      previousManifest.active_operation_id !== scope.mutationContext.operationId &&
      previousManifest.active_operation_id !== ''
    ) {
      throw new PublicationError('Active operation conflict', [
        {
          code: 'OPERATION_IN_PROGRESS',
          message: `Operation ${previousManifest.active_operation_id} is active, cannot publish`,
          operationId: previousManifest.active_operation_id,
        },
      ]);
    }

    // Track promoted event IDs
    const promotedEventIds = new Set<string>();
    for (const c of candidates) {
      promotedEventIds.add(c.eventId);
    }

    // ── Step 3: Build writes ───────────────────────────────────────
    const writes: StorageWrite[] = [];

    // 3a. Scene files for each candidate
    for (const candidate of candidates) {
      if (candidate.promote === false) continue;
      if (!candidate.latestEnvelope) {
        throw new PublicationError('Promoted candidate is missing its latest envelope', [
          {
            code: 'REVISION_STALE',
            message: `Promoted scene ${candidate.eventId} has no atomic latest-response write`,
            eventId: candidate.eventId,
            operationId: scope.mutationContext.operationId,
          },
        ]);
      }
      if (
        candidate.latestEnvelope.eventId !== candidate.eventId ||
        candidate.latestEnvelope.revisionId !== candidate.head.revisionId ||
        candidate.latestEnvelope.proseHash !== candidate.head.proseHash ||
        candidate.latestEnvelope.sceneHash !== candidate.head.sceneHash ||
        candidate.latestEnvelope.releaseDecision.status !== 'accepted' ||
        !candidate.latestEnvelope.released
      ) {
        throw new PublicationError('Promoted candidate envelope is inconsistent', [
          {
            code: 'REVISION_STALE',
            message: `Promoted scene ${candidate.eventId} does not match its accepted revision`,
            eventId: candidate.eventId,
            operationId: scope.mutationContext.operationId,
          },
        ]);
      }
      if (candidate.latestEnvelope) {
        const latestPath = path.posix.join(this.paths.responsesDir, `${candidate.eventId}.json`);
        writes.push({
          type: 'put',
          path: latestPath,
          content: stableJson(candidate.latestEnvelope),
          expectedHash: expectedFileHash(latestPath),
        });
      }
      if (candidate.lock) {
        const lockPath = path.posix.join(this.paths.workDir, 'locks', `${candidate.eventId}.lock`);
        writes.push({
          type: 'put',
          path: lockPath,
          content: stableJson({
            revisionId: candidate.head.revisionId,
            proseHash: candidate.head.proseHash,
            lockedAt: candidate.lock.lockedAt,
            actorId: candidate.lock.actorId,
          }),
          expectedHash: expectedFileHash(lockPath),
        });
      }
      promotedEventIds.add(candidate.eventId);
      const sceneDir = path.posix.join(
        scope.projectDir,
        'scenes',
        `chapter-${String(candidate.chapterNumber).padStart(2, '0')}`,
      );
      const markdownPath = path.posix.join(sceneDir, `${candidate.eventId}.md`);
      writes.push({
        type: 'put',
        path: markdownPath,
        content: candidate.scene.prose,
        expectedHash: expectedFileHash(markdownPath),
      });

      const metadata = buildSceneMetadataV1(
        candidate.eventId,
        candidate.event.narrativeOrder,
        candidate.head,
      );
      const metadataPath = path.posix.join(sceneDir, `${candidate.eventId}.yaml`);
      writes.push({
        type: 'put',
        path: metadataPath,
        content: `${YAML.stringify(metadata, { lineWidth: 120 })}\n`,
        expectedHash: expectedFileHash(metadataPath),
      });

      if (candidate.scene.renderRequest) {
        const requestPath = path.posix.join(sceneDir, `${candidate.eventId}_render_request.yaml`);
        writes.push({
          type: 'put',
          path: requestPath,
          content: `${YAML.stringify(candidate.scene.renderRequest, { lineWidth: 120 })}\n`,
          expectedHash: expectedFileHash(requestPath),
        });
      }
    }

    // 3b. Derived data — CAS: only overwrite if current content matches
    const derivedDir = this.paths.derivedDir;
    const derivedFiles = [
      { name: 'threads.yaml', data: derived.threads },
      { name: 'foreshadowing.yaml', data: derived.foreshadowing },
      { name: 'relationships.yaml', data: derived.relationships },
      { name: 'rules.yaml', data: derived.rules },
    ] as const;
    for (const derivedFile of derivedFiles) {
      const derivedPath = path.posix.join(derivedDir, derivedFile.name);
      writes.push({
        type: 'put',
        path: derivedPath,
        content: YAML.stringify(derivedFile.data, { lineWidth: 120 }),
        expectedHash: expectedFileHash(derivedPath),
      });
    }
    for (const write of additionalWrites) {
      writes.push({
        ...write,
        expectedHash: expectedFileHash(write.path),
      });
    }

    // ── Step 4: Compute publication state ──────────────────────────

    const allPromoted = scope.scopeEventIds.every((eventId) => verifiedHeads.has(eventId));
    const hasRequiredOutput =
      publicationMode === 'tree'
        ? additionalWrites.length > 0
        : novelContent !== null && novelHash !== null;
    const isCurrent =
      allPromoted &&
      scope.scopeEventIds.length > 0 &&
      hasRequiredOutput &&
      invocationReasons.length === 0;
    const status: 'current' | 'stale' = isCurrent ? 'current' : 'stale';

    // Merge revision IDs: preserve previous non-promoted heads, overlay promoted
    const revisionIds: Record<string, string> = {};
    for (const [eid, rid] of Object.entries(previousManifest.revision_ids)) {
      if (!promotedEventIds.has(eid)) {
        revisionIds[eid] = rid;
      }
    }
    for (const c of candidates) {
      revisionIds[c.eventId] = c.head.revisionId;
    }

    // Novel: only full-scope current promotion writes novel.
    // Otherwise keep old novel bytes/hash/assembled-at.
    const effectiveNovelHash: string | null =
      publicationMode === 'novel' && isCurrent && novelHash !== null
        ? novelHash
        : previousManifest.novel_hash;
    const effectiveAssembledAt: string | null =
      publicationMode === 'novel' && isCurrent && novelContent !== null
        ? new Date().toISOString()
        : previousManifest.last_assembled_at;

    const reasons: EditorialError[] = isCurrent
      ? []
      : [...previousManifest.reasons, ...invocationReasons];
    // ── Step 5: Build manifest ─────────────────────────────────────
    const manifest: PublicationManifestV1 = {
      version: 1,
      status,
      branch_scope_hash: scope.branchScopeHash,
      novel_hash: effectiveNovelHash,
      revision_ids: revisionIds,
      last_assembled_at: effectiveAssembledAt,
      reasons,
      ...(previousManifest.active_operation_id
        ? { active_operation_id: previousManifest.active_operation_id }
        : {}),
    };

    writes.push({
      type: 'put',
      path: this.paths.publicationPath,
      content: stableJson(manifest),
      // CAS: only overwrite if current content matches expected hash.
      // For first publish, this is null (file doesn't exist).
      // For subsequent publishes, this is the current file hash (verified
      // by readSet above — the readSet check happens at commit time before
      // writes, so this is consistent).
      expectedHash: previousManifestHash,
    });

    // ── Step 6: Write novel only when full-scope current ───────────
    if (publicationMode === 'novel' && isCurrent && novelContent !== null && novelHash !== null) {
      const observedNovelHash = expectedFileHash(this.paths.novelPath);
      if (observedNovelHash !== previousManifest.novel_hash) {
        throw new PublicationError('Canonical novel has untracked edits', [
          {
            code: 'PUBLICATION_CONTENT_CONFLICT',
            message: 'Canonical novel bytes do not match the published manifest',
            path: this.paths.novelPath,
            operationId: scope.mutationContext.operationId,
          },
        ]);
      }
      writes.push({
        type: 'put',
        path: this.paths.novelPath,
        content: novelContent,
        expectedHash: observedNovelHash,
      });
    }

    // ── Step 7: Commit transaction ─────────────────────────────────
    this.coordinator.commit({
      transactionId: scope.mutationContext.operationId,
      readSet,
      writes,
    });

    return {
      status,
      outputPath,
      novelHash: effectiveNovelHash,
      reasons,
    };
  }
}
