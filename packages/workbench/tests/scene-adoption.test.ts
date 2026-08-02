import { createHash } from 'node:crypto';
import type { CoreExecutionRepository } from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import { sceneBytesMatchClaim } from '../src/host/git/manifest.js';
import { prepareSceneAdoption } from '../src/host/scene-adoption.js';

const PROJECT_ID = 'project-a';
const EVENT_ID = 'E7';
const REVISION_ID = '00000000-0000-4000-8000-000000000007';
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hex = 'a'.repeat(64);

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const prose =
    typeof overrides.prose === 'string' ? overrides.prose : 'Accepted generated prose.\n';
  return {
    version: 1,
    revisionId: REVISION_ID,
    parentRevisionId: null,
    operationId: '00000000-0000-4000-8000-000000000001',
    planHash: hex,
    actorId: 'author-a',
    eventId: EVENT_ID,
    origin: 'llm_draft',
    prose,
    proseHash: hash(prose),
    sceneHash: hex,
    editorialBasisHash: hex,
    scopeHash: hex,
    validationIdentity: 'validation-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: {
      status: 'accepted',
      scopeHash: hex,
      validationIdentity: 'validation-v1',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: hex,
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function execution(
  value: unknown | null,
  recordIdentity: Partial<
    Pick<
      { projectId: string; eventId: string; revisionId: string },
      'projectId' | 'eventId' | 'revisionId'
    >
  > = {},
): Pick<CoreExecutionRepository, 'readSceneRevision'> {
  return {
    readSceneRevision: async () =>
      value === null
        ? null
        : ({
            revision: 1,
            value: {
              version: 1,
              projectId: PROJECT_ID,
              eventId: EVENT_ID,
              revisionId: REVISION_ID,
              parentRevisionId: null,
              sourceHash: hex,
              ...recordIdentity,
              value,
            },
          } as never),
  };
}

describe('prepareSceneAdoption', () => {
  const input = { projectId: PROJECT_ID, eventId: EVENT_ID, revisionId: REVISION_ID };

  it('derives a claim and exact manifest bytes from a released persisted revision', async () => {
    const result = await prepareSceneAdoption({ execution: execution(envelope()) }, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disclosure).toBe('accepted generated prose will enter the authoring manifest');
    expect(result.entry.path).toBe('scenes/E7.md');
    expect(new TextDecoder().decode(result.entry.bytes)).toBe('Accepted generated prose.\n');
    expect(result.claim).toMatchObject({
      eventId: EVENT_ID,
      revisionId: REVISION_ID,
      released: true,
    });
    expect(sceneBytesMatchClaim(result.entry.bytes, result.claim)).toBe(true);
  });

  it('never creates an authoring entry for absent, invalid, mismatched, or unreleased revisions', async () => {
    for (const [value, expected] of [
      [null, 'REVISION_NOT_FOUND'],
      [{ unexpected: true }, 'REVISION_INVALID'],
      [envelope({ eventId: 'E8' }), 'REVISION_MISMATCH'],
      [envelope({ released: false }), 'REVISION_UNRELEASED'],
      [envelope({ proseHash: hex }), 'PROSE_HASH_MISMATCH'],
    ] as const) {
      const result = await prepareSceneAdoption({ execution: execution(value) }, input);
      expect(result).toMatchObject({ ok: false, code: expected });
      expect(result).not.toHaveProperty('entry');
      expect(result).not.toHaveProperty('claim');
    }
  });

  it('never adopts a persisted record from another project identity', async () => {
    const result = await prepareSceneAdoption(
      { execution: execution(envelope(), { projectId: 'project-b' }) },
      input,
    );

    expect(result).toMatchObject({ ok: false, code: 'REVISION_MISMATCH' });
    expect(result).not.toHaveProperty('entry');
    expect(result).not.toHaveProperty('claim');
  });
});
