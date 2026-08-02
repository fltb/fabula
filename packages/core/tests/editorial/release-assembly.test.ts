import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalAssemble, type AssemblySemanticInput } from '../../src/assembler/release-assembly.ts';
import { PublicationError } from '../../src/editorial/errors.ts';
import { MemoryExecutionRepository } from '../../src/testing/memory-repositories.ts';
import type { PublicationManifestV1, SceneRevisionEnvelopeV1 } from '../../src/types/editorial.ts';

const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const sourceHash = 'release-source-hash';
const prose = 'Alice entered quietly and closed the door behind her.';
const revisionId = '00000000-0000-4000-8000-000000000001';
function envelope(status: 'accepted' | 'blocked' = 'accepted', sceneProse = prose): SceneRevisionEnvelopeV1 {
  const sceneHash = hash(sceneProse);
  const proseHash = hash(sceneProse);
  return {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: '00000000-0000-4000-8000-000000000002',
    planHash: 'plan-hash',
    actorId: 'renderer',
    origin: 'llm_draft',
    proseHash,
    sceneHash,
    editorialBasisHash: 'editorial-basis',
    scopeHash: 'scope-hash',
    validationIdentity: 'validator-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: { status, scopeHash: 'scope-hash', validationIdentity: 'validator-v1', reasons: [] },
    released: status === 'accepted',
    cacheHit: false,
    errors: [],
    llmPass1: null,
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: 'prompt-hash',
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  };
}

function input(revision: SceneRevisionEnvelopeV1 = envelope()): AssemblySemanticInput {
  return {
    projectId: 'release-assembly-project',
    sourceHash,
    manifest: {
      version: 1,
      status: 'current',
      branch_scope_hash: 'branch-scope',
      novel_hash: null,
      revision_ids: { E001: revisionId },
      last_assembled_at: null,
      reasons: [],
    } satisfies PublicationManifestV1,
    revisions: new Map([['E001', revision]]),
    scenes: new Map([['E001', { prose, chapterNumber: 1, metadata: { prose_source: 'llm', word_count: 9, rendered_at: '2026-07-28T00:00:00.000Z' } }]]),
    discourseSequence: [{ sceneId: 'E001', sequence: 0, chapter: 1 }],
    chapterTitles: new Map([[1, { chapter: 1, title: 'Opening', summary: '', intent: '', plannedScenes: 1 }]]),
  };
}

const request = (title?: string) => ({
  version: 1 as const,
  mutation: { operationId: crypto.randomUUID(), actorId: 'assembler' },
  ...(title ? { title } : {}),
});

async function repositoryFor(input: AssemblySemanticInput): Promise<MemoryExecutionRepository> {
  const repository = new MemoryExecutionRepository();
  for (const [eventId, revision] of input.revisions) {
    await repository.compareAndSwapAcceptedScene({
      projectId: input.projectId,
      eventId,
      expectedVersion: null,
      value: {
        version: 1,
        projectId: input.projectId,
        eventId,
        sourceHash: input.sourceHash,
        revisionId: revision.revisionId,
        prose: revision.prose,
        proseHash: revision.proseHash,
        sceneHash: revision.sceneHash,
      },
    });
  }
  return repository;
}

describe('release-aware pure assembly', () => {
  it('assembles ordered output from accepted semantic heads', async () => {
    const semantic = input();
    const result = await canonicalAssemble(
      request('Canonical Title'),
      semantic,
      await repositoryFor(semantic),
    );
    expect(result.publication.status).toBe('current');
    expect(result.sceneCount).toBe(1);
    expect(result.markdown).toContain('# Canonical Title');
    expect(result.markdown).toContain('## Chapter 1: Opening');
    expect(result.markdown).toContain(prose);
  });

  it('preserves discourse and chapter ordering for multiple accepted heads', async () => {
    const first = envelope();
    const second = { ...envelope(), revisionId: '00000000-0000-4000-8000-000000000003' };
    const semantic = {
      ...input(first),
      manifest: { ...input(first).manifest, revision_ids: { E001: first.revisionId, E002: second.revisionId } },
      revisions: new Map([['E001', first], ['E002', second]]),
      scenes: new Map([
        ['E001', { prose, chapterNumber: 1, metadata: { prose_source: 'llm', rendered_at: '2026-07-28T00:00:00.000Z' } }],
        ['E002', { prose, chapterNumber: 2, metadata: { prose_source: 'llm', rendered_at: '2026-07-28T00:00:00.000Z' } }],
      ]),
      discourseSequence: [{ sceneId: 'E001', sequence: 0, chapter: 1 }, { sceneId: 'E002', sequence: 1, chapter: 2 }],
    } satisfies AssemblySemanticInput;
    const result = await canonicalAssemble(request(), semantic, await repositoryFor(semantic));
    expect(result.markdown.indexOf(prose)).toBeLessThan(result.markdown.lastIndexOf(prose));
    expect(result.sceneCount).toBe(2);
  });

  it('fails closed when an accepted head is blocked', async () => {
    const semantic = input(envelope('blocked'));
    await expect(
      canonicalAssemble(request(), semantic, new MemoryExecutionRepository()),
    ).rejects.toThrow(PublicationError);
  });

  it('fails closed when scene content does not match the accepted envelope', async () => {
    const semantic = {
      ...input(),
      scenes: new Map([['E001', { prose: 'Tampered.', chapterNumber: 1, metadata: {} }]]),
    } satisfies AssemblySemanticInput;
    await expect(
      canonicalAssemble(request(), semantic, await repositoryFor(input())),
    ).rejects.toThrow(PublicationError);
  });

  it('rejects assembly when the accepted artifact was compiled from stale source bytes', async () => {
    const semantic = input();
    const repository = await repositoryFor(semantic);
    // Re-store the accepted head under a different source hash, simulating an
    // accepted artifact that no longer matches the assembly input snapshot.
    const current = await repository.readAcceptedScene({
      projectId: semantic.projectId,
      eventId: 'E001',
    });
    await repository.compareAndSwapAcceptedScene({
      projectId: semantic.projectId,
      eventId: 'E001',
      expectedVersion: current?.revision ?? null,
      value: {
        version: 1,
        projectId: semantic.projectId,
        eventId: 'E001',
        sourceHash: 'different-source-hash',
        revisionId,
        prose,
        proseHash: hash(prose),
        sceneHash: hash(prose),
      },
    });
    const error = await canonicalAssemble(request(), semantic, repository).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).reasons.map((reason) => reason.code)).toContain(
      'REVISION_STALE',
    );
  });

  it('rejects assembly when the accepted artifact is missing from the repository', async () => {
    const semantic = input();
    const error = await canonicalAssemble(
      request(),
      semantic,
      new MemoryExecutionRepository(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).reasons.map((reason) => reason.code)).toContain(
      'REVISION_STALE',
    );
  });
});
