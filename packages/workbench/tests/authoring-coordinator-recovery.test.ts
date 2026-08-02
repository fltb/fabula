import { describe, expect, it } from 'vitest';
import type { AuthoringStateRecord } from '../src/contracts/persistence.js';
import {
  createAuthoringCoordinator,
  type AuthoringCoordinatorAssembly,
} from '../src/host/authoring/coordinator.js';
import type { AuthoringWorkingDocumentStore } from '../src/host/authoring/document-store.js';
import type { AuthoringCandidateStore } from '../src/host/authoring/filesystem-observer.js';

function assembly(
  persisted: AuthoringStateRecord | null,
  staging: Pick<AuthoringCandidateStore, 'get'>,
  saves: AuthoringStateRecord[],
): AuthoringCoordinatorAssembly {
  const documents = {
    projectId: 'project-a',
    async isWorkingDirty() {
      return false;
    },
    async workspaceDigest() {
      return null;
    },
  } as unknown as AuthoringWorkingDocumentStore;
  return {
    projectId: 'project-a',
    materializer: documents,
    documents,
    staging: {
      ...staging,
      async put() {},
      async delete() {},
    },
    persistence: {
      async load() {
        return persisted;
      },
      async save(record) {
        saves.push(record);
      },
    },
    treeLoader: {
      async loadTree() {
        throw new Error('not used by restoration');
      },
    },
    sessions: {
      async enqueue() {
        return { status: 'completed', operationId: 'op-1' };
      },
    },
    git: {
      async submit() {
        throw new Error('not used by restoration');
      },
    },
    events: { publish() {} },
    buildSnapshot() {
      throw new Error('not used by restoration');
    },
    validate() {
      return [];
    },
    async adopt() {
      throw new Error('not used by restoration');
    },
    now: () => '2026-08-02T00:00:00.000Z',
  };
}

function record(overrides: Partial<AuthoringStateRecord> = {}): AuthoringStateRecord {
  return {
    projectId: 'project-a',
    phase: 'submitting',
    candidateValid: true,
    conflicts: [],
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('AuthoringCoordinator durable recovery', () => {
  it('awaits durable restoration before exposing an unresolved submit as recovery-required', async () => {
    const saves: AuthoringStateRecord[] = [];
    const coordinator = await createAuthoringCoordinator(
      assembly(record({ pendingSubmitId: 'submit-1' }), { async get() { return null; } }, saves),
    );

    expect(coordinator.getState()).toMatchObject({
      phase: 'recovery-required',
      submitBlockReason: 'recovery-required',
      acceptedSourceHash: null,
    });
    expect(saves).toEqual([]);
  });

  it('fails closed when durable candidate metadata lacks its private staging bundle', async () => {
    const saves: AuthoringStateRecord[] = [];
    const coordinator = await createAuthoringCoordinator(
      assembly(record({ candidateHash: 'candidate-1' }), { async get() { return null; } }, saves),
    );

    expect(coordinator.getState()).toMatchObject({
      phase: 'recovery-required',
      submitBlockReason: 'recovery-required',
      externalCandidate: null,
    });
  });
});
