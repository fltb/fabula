import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AssemblySemanticInput,
  assembleRelease,
  canonicalAssemble,
  customAssemble,
} from '../../src/assembler/release-assembly.ts';
import { computeScopeHash } from '../../src/editorial/identity.ts';
import { MemoryExecutionRepository } from '../../src/testing/memory-repositories.ts';
import type { BranchPath } from '../../src/types/branch.ts';
import type {
  AssembleReleaseOutcomeV1,
  AssembleRequestV1,
  EditorialRuntime,
  PublicationManifestV1,
  SceneRevisionEnvelopeV1,
} from '../../src/types/editorial.ts';

const hash = (value: string): string =>
  crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');

const sourceHash = 'release-facade-source-hash';
const proseA = 'Alice entered quietly and closed the door behind her.';
const proseB = 'Bob waited in the garden until the moon rose.';
const revisionA = '00000000-0000-4000-8000-000000000001';
const revisionB = '00000000-0000-4000-8000-000000000002';
const projectId = 'release-facade-project';

const pathA: BranchPath = { decisions: [{ atEventId: 'E001', choiceId: 'a', narrativeOrder: 1 }] };
const pathB: BranchPath = { decisions: [{ atEventId: 'E001', choiceId: 'b', narrativeOrder: 1 }] };

function envelope(
  scopeHashValue: string,
  revisionId: string,
  status: 'accepted' | 'blocked' = 'accepted',
  sceneProse = proseA,
): SceneRevisionEnvelopeV1 {
  const sceneHash = hash(sceneProse);
  const proseHash = hash(sceneProse);
  return {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: '00000000-0000-4000-8000-00000000000e',
    planHash: 'plan-hash',
    actorId: 'renderer',
    origin: 'llm_draft',
    proseHash,
    sceneHash,
    editorialBasisHash: 'editorial-basis',
    scopeHash: scopeHashValue,
    validationIdentity: 'validator-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: {
      status,
      scopeHash: scopeHashValue,
      validationIdentity: 'validator-v1',
      reasons: [],
    },
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

function input(overrides: Partial<AssemblySemanticInput> = {}): AssemblySemanticInput {
  return {
    projectId,
    sourceHash,
    manifest: {
      version: 1,
      status: 'current',
      branch_scope_hash: 'branch-scope',
      novel_hash: null,
      revision_ids: { E001: revisionA },
      last_assembled_at: null,
      reasons: [],
    } satisfies PublicationManifestV1,
    revisions: new Map([['E001', envelope(computeScopeHash('E001', undefined), revisionA)]]),
    scenes: new Map([
      [
        'E001',
        {
          prose: proseA,
          chapterNumber: 1,
          metadata: {
            prose_source: 'llm',
            word_count: 9,
            rendered_at: '2026-07-28T00:00:00.000Z',
          },
        },
      ],
    ]),
    discourseSequence: [{ sceneId: 'E001', sequence: 0, chapter: 1 }],
    chapterTitles: new Map([
      [1, { chapter: 1, title: 'Opening', summary: '', intent: '', plannedScenes: 1 }],
    ]),
    ...overrides,
  };
}

const request = (overrides: Partial<AssembleRequestV1> = {}): AssembleRequestV1 => ({
  version: 1,
  mutation: { operationId: '00000000-0000-4000-8000-00000000000a', actorId: 'assembler' },
  ...overrides,
});

function runtimeFor(repository: MemoryExecutionRepository): EditorialRuntime {
  return { services: { execution: repository } } as unknown as EditorialRuntime;
}

async function repositoryFor(semantic: AssemblySemanticInput): Promise<MemoryExecutionRepository> {
  const repository = new MemoryExecutionRepository();
  for (const [eventId, revision] of semantic.revisions) {
    await repository.compareAndSwapAcceptedScene({
      projectId: semantic.projectId,
      eventId,
      expectedVersion: null,
      value: {
        version: 1,
        projectId: semantic.projectId,
        eventId,
        sourceHash: semantic.sourceHash,
        revisionId: revision.revisionId,
        prose: revision.prose,
        proseHash: revision.proseHash,
        sceneHash: revision.sceneHash,
      },
    });
  }
  return repository;
}

function expectReady(outcome: AssembleReleaseOutcomeV1) {
  if (outcome.status !== 'ready') {
    throw new Error(`expected ready outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe('assembleRelease facade', () => {
  it('assembles canonical releases with exact markdown, counts, and byte hash', async () => {
    const semantic = input();
    const repository = await repositoryFor(semantic);
    const req = request({ title: 'Canonical Title' });
    const outcome = expectReady(await assembleRelease(req, semantic, runtimeFor(repository)));

    // Exact markdown with a single trailing newline.
    const expected =
      '# Canonical Title\n\n## Chapter 1: Opening\n\nAlice entered quietly and closed the door behind her.\n';
    expect(outcome.markdown).toBe(expected);
    expect(outcome.markdown.endsWith('\n')).toBe(true);
    expect(outcome.markdown.endsWith('\n\n')).toBe(false);

    // Counts and revision ids match the canonicalAssemble composition.
    const composed = await canonicalAssemble(req, semantic, repository);
    expect(outcome.sceneCount).toBe(composed.sceneCount);
    expect(outcome.sceneCount).toBe(1);
    expect(outcome.wordCount).toBe(composed.wordCount);
    expect(outcome.wordCount).toBe(outcome.markdown.split(/\s+/).filter(Boolean).length);
    expect(outcome.revisionIds).toEqual(composed.revisionIds);
    expect(outcome.revisionIds).toEqual([revisionA]);

    // novelHash is sha256 of the exact UTF-8 bytes including the trailing newline.
    expect(outcome.novelHash).toBe(hash(outcome.markdown));
    expect(outcome.novelHash).not.toBe(hash(outcome.markdown.slice(0, -1)));

    expect(outcome.scopeHash).toBe(semantic.manifest.branch_scope_hash);
  });

  it('assembles a custom branch path and filters out-of-branch scenes', async () => {
    const semantic = input({
      manifest: {
        version: 1,
        status: 'current',
        branch_scope_hash: 'branch-scope',
        novel_hash: null,
        revision_ids: { E001: revisionA, E002: revisionB },
        last_assembled_at: null,
        reasons: [],
      } satisfies PublicationManifestV1,
      revisions: new Map([
        ['E001', envelope(computeScopeHash('E001', pathA), revisionA)],
        // E002 was compiled under branch B; it must be excluded before any
        // scope verification applies to it.
        ['E002', envelope(computeScopeHash('E002', pathB), revisionB, 'accepted', proseB)],
      ]),
      scenes: new Map([
        [
          'E001',
          {
            prose: proseA,
            chapterNumber: 1,
            metadata: {
              prose_source: 'llm',
              word_count: 9,
              rendered_at: '2026-07-28T00:00:00.000Z',
              branch_existence: { type: 'paths', paths: [pathA] },
            },
          },
        ],
        [
          'E002',
          {
            prose: proseB,
            chapterNumber: 2,
            metadata: {
              prose_source: 'llm',
              word_count: 9,
              rendered_at: '2026-07-28T00:00:00.000Z',
              branch_existence: { type: 'paths', paths: [pathB] },
            },
          },
        ],
      ]),
      discourseSequence: [
        { sceneId: 'E001', sequence: 0, chapter: 1 },
        { sceneId: 'E002', sequence: 1, chapter: 2 },
      ],
    });
    const repository = await repositoryFor(semantic);
    const req = request({ title: 'Branch Title', branchPath: pathA });
    const outcome = expectReady(await assembleRelease(req, semantic, runtimeFor(repository)));

    expect(outcome.sceneCount).toBe(1);
    expect(outcome.markdown).toContain(proseA);
    expect(outcome.markdown).not.toContain(proseB);
    expect(outcome.revisionIds).toEqual([revisionA]);

    const composed = await customAssemble(req, semantic, repository);
    expect(outcome.markdown).toBe(composed.markdown);
    expect(outcome.sceneCount).toBe(composed.sceneCount);
  });

  it('returns a typed failure instead of a partial novel when a scene is blocked', async () => {
    const semantic = input({
      revisions: new Map([
        ['E001', envelope(computeScopeHash('E001', undefined), revisionA, 'blocked')],
      ]),
    });
    const repository = await repositoryFor(semantic);
    const outcome = await assembleRelease(request(), semantic, runtimeFor(repository));
    expect(outcome.status).toBe('manifest_invalid');
    if (outcome.status !== 'manifest_invalid') throw new Error('unreachable');
    expect(outcome.errors.map((issue) => issue.code)).toContain('REVISION_BLOCKED');
    expect('markdown' in outcome).toBe(false);
  });

  it('returns a typed failure when a manifest scene is missing from the source', async () => {
    const semantic = input({
      manifest: {
        version: 1,
        status: 'current',
        branch_scope_hash: 'branch-scope',
        novel_hash: null,
        revision_ids: { E001: revisionA, E999: '00000000-0000-4000-8000-000000000099' },
        last_assembled_at: null,
        reasons: [],
      } satisfies PublicationManifestV1,
    });
    const repository = await repositoryFor(semantic);
    const outcome = await assembleRelease(request(), semantic, runtimeFor(repository));
    expect(outcome.status).toBe('manifest_invalid');
    if (outcome.status !== 'manifest_invalid') throw new Error('unreachable');
    expect(outcome.errors.map((issue) => issue.code)).toContain('SCENE_NOT_FOUND');
    expect('markdown' in outcome).toBe(false);
  });

  it('returns a typed failure when the accepted artifact is stale against the source', async () => {
    const semantic = input();
    const repository = await repositoryFor(semantic);
    const current = await repository.readAcceptedScene({ projectId, eventId: 'E001' });
    await repository.compareAndSwapAcceptedScene({
      projectId,
      eventId: 'E001',
      expectedVersion: current?.revision ?? null,
      value: {
        version: 1,
        projectId,
        eventId: 'E001',
        sourceHash: 'different-source-hash',
        revisionId: revisionA,
        prose: proseA,
        proseHash: hash(proseA),
        sceneHash: hash(proseA),
      },
    });
    const outcome = await assembleRelease(request(), semantic, runtimeFor(repository));
    expect(outcome.status).toBe('manifest_invalid');
    if (outcome.status !== 'manifest_invalid') throw new Error('unreachable');
    expect(outcome.errors.map((issue) => issue.code)).toContain('REVISION_STALE');
  });

  it('returns a typed failure when scenes mix scopes other than the request', async () => {
    const semantic = input({
      revisions: new Map([['E001', envelope('wrong-scope-hash', revisionA)]]),
    });
    const repository = await repositoryFor(semantic);
    const outcome = await assembleRelease(request(), semantic, runtimeFor(repository));
    expect(outcome.status).toBe('manifest_invalid');
    if (outcome.status !== 'manifest_invalid') throw new Error('unreachable');
    expect(outcome.errors.map((issue) => issue.code)).toContain('PUBLICATION_INCOMPLETE');
    expect('markdown' in outcome).toBe(false);
  });

  it('returns a typed failure when the discourse sequence references an unpublished event', async () => {
    const semantic = input({
      discourseSequence: [
        { sceneId: 'E001', sequence: 0, chapter: 1 },
        { sceneId: 'E777', sequence: 1, chapter: 2 },
      ],
    });
    const repository = await repositoryFor(semantic);
    const outcome = await assembleRelease(request(), semantic, runtimeFor(repository));
    expect(outcome.status).toBe('manifest_invalid');
    if (outcome.status !== 'manifest_invalid') throw new Error('unreachable');
    expect(outcome.errors.map((issue) => issue.code)).toContain('PUBLICATION_INCOMPLETE');
    expect('markdown' in outcome).toBe(false);
  });

  it('requires an execution repository on the runtime', async () => {
    const semantic = input();
    await expect(assembleRelease(request(), semantic, {})).rejects.toThrow(/execution repository/);
  });

  it('never carries a host outputPath on AssembleRequestV1', () => {
    const req: AssembleRequestV1 = {
      version: 1,
      mutation: { operationId: '00000000-0000-4000-8000-00000000000a', actorId: 'assembler' },
    };
    expect('outputPath' in req).toBe(false);
    expect(Object.keys(req)).not.toContain('outputPath');
  });
});
