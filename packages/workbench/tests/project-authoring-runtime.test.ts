import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { MockProvider } from '@novalistically/core/testing';
import { createFileCoreRuntimeServices, FileProjectSourceLoader } from '@novalistically/node-host';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { AgentCapabilityService, createCapabilityPersistence } from '../src/host/agent/index.js';
import { createAuthoringDocumentStore } from '../src/host/authoring/document-store.js';
import { createProjectAuthoringRuntime } from '../src/host/authoring/project-runtime.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import { createProjectSession } from '../src/host/project-session.js';
import { createYjsPersistencePort, createYjsWorkingDocumentCore } from '../src/host/yjs/index.js';
import { createRealPersistence } from './helpers/real-persistence.js';

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../fixtures/workbench-authoring', import.meta.url),
);

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-authoring-runtime-'));
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

describe('project authoring runtime', () => {
  it('stages observer candidates in the same store and reconciles them through controlled Git', async () => {
    const root = copyFixture();
    const persistence = createRealPersistence();
    try {
      const stagingRoot = mkdtempSync(join(tmpdir(), 'wb-authoring-stage-'));
      const capabilities = new AgentCapabilityService({
        persistence: createCapabilityPersistence(persistence.client),
      });
      const source = new FileProjectSourceLoader().load(root);
      const session = createProjectSession({
        projectId: 'fixture',
        runtime: createProjectCoreRuntime({
          projectId: 'fixture',
          services: createFileCoreRuntimeServices(root, { provider: new MockProvider() }),
        }),
        capabilities,
        audit: { record: async () => undefined },
        initialSource: source,
      });
      const core = createYjsWorkingDocumentCore({
        persistence: createYjsPersistencePort(persistence.client),
      });
      const runtime = await createProjectAuthoringRuntime({
        projectId: 'fixture',
        projectRoot: root,
        hostStagingRoot: stagingRoot,
        session,
        capabilities,
        persistence: persistence.client,
        yjsCore: core,
        events: { publish: () => undefined },
      });
      try {
        expect(runtime.coordinator.getState()).toMatchObject({
          phase: 'clean',
          acceptedSourceHash: source.sourceHash,
          workingDirty: false,
        });

        const original = readFileSync(join(root, 'nova.yaml'), 'utf8');
        const revised = original.replace(/^title:.*$/m, 'title: "Runtime Reconciled Fixture"');
        writeFileSync(join(root, 'nova.yaml'), revised);
        await runtime.observer.notify({ hintPaths: ['nova.yaml'] });
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState().phase).toBe('external-pending');
        });

        // Reverting an external candidate to the accepted bytes clears it.
        // This guards the coordinator's self-write/reversion suppression path.
        writeFileSync(join(root, 'nova.yaml'), original);
        await runtime.observer.notify({ hintPaths: ['nova.yaml'] });
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState()).toMatchObject({
            phase: 'clean',
            externalCandidate: null,
            acceptedSourceHash: source.sourceHash,
          });
        });

        writeFileSync(join(root, 'nova.yaml'), 'title: [\n');
        await runtime.observer.notify({ hintPaths: ['nova.yaml'] });
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState()).toMatchObject({
            phase: 'candidate-invalid',
            acceptedSourceHash: source.sourceHash,
          });
        });
        expect(session.source?.sourceHash).toBe(source.sourceHash);

        writeFileSync(join(root, 'nova.yaml'), revised);
        await runtime.observer.notify({ hintPaths: ['nova.yaml'] });
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState().phase).toBe('external-pending');
        });

        const state = runtime.coordinator.getState();
        const candidate = state.externalCandidate;
        if (candidate === null) throw new Error('external candidate was not staged');
        const grant = await capabilities.issue({
          userId: 'owner',
          projectId: 'fixture',
          scopes: ['mcp:submit'],
        });
        const receipt = await runtime.coordinator.reconcileExternal({
          choice: 'accept-external',
          candidateHash: candidate.candidateHash,
          expectedAcceptedSourceHash: state.acceptedSourceHash,
          actorId: 'owner',
          capabilityId: grant.grant.capabilityId,
          capabilityScopes: ['mcp:submit'],
        });

        expect(receipt).toMatchObject({
          status: 'completed',
          acceptedSourceHash: session.source?.sourceHash,
        });
        expect(receipt.revisionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(session.source?.sourceHash).not.toBe(source.sourceHash);
        expect(readFileSync(join(root, 'nova.yaml'), 'utf8')).toContain(
          'Runtime Reconciled Fixture',
        );
      } finally {
        await runtime.dispose();
      }
    } finally {
      await persistence.dispose();
    }
  });

  it('pauses Agent work for an external candidate while Yjs is dirty', async () => {
    const root = copyFixture();
    const persistence = createRealPersistence();
    try {
      const stagingRoot = mkdtempSync(join(tmpdir(), 'wb-authoring-dual-conflict-'));
      const capabilities = new AgentCapabilityService({
        persistence: createCapabilityPersistence(persistence.client),
      });
      const source = new FileProjectSourceLoader().load(root);
      const session = createProjectSession({
        projectId: 'fixture',
        runtime: createProjectCoreRuntime({
          projectId: 'fixture',
          services: createFileCoreRuntimeServices(root, { provider: new MockProvider() }),
        }),
        capabilities,
        audit: { record: async () => undefined },
        initialSource: source,
      });
      const core = createYjsWorkingDocumentCore({
        persistence: createYjsPersistencePort(persistence.client),
      });
      const runtime = await createProjectAuthoringRuntime({
        projectId: 'fixture',
        projectRoot: root,
        hostStagingRoot: stagingRoot,
        session,
        capabilities,
        persistence: persistence.client,
        yjsCore: core,
        events: { publish: () => undefined },
      });
      try {
        const base = await runtime.documents.load({
          projectId: 'fixture',
          documentId: 'nova.yaml',
        });
        if (base === null) throw new Error('accepted document was not hydrated into Yjs');
        const working = new Y.Doc();
        Y.applyUpdate(working, base.update);
        const text = working.getText('prose');
        text.insert(text.length, '# local working edit\n');
        const applied = await runtime.documents.applyScopedUpdate({
          projectId: 'fixture',
          documentId: 'nova.yaml',
          expectedBaseVector: base.stateVector,
          expectedHumanPresenceGeneration: session.presenceGeneration,
          update: Y.encodeStateAsUpdate(working),
        });
        expect(applied.ok).toBe(true);
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState().phase).toBe('working-dirty');
        });

        const revised = readFileSync(join(root, 'nova.yaml'), 'utf8').replace(
          /^title:.*$/m,
          'title: "External Concurrent Edit"',
        );
        writeFileSync(join(root, 'nova.yaml'), revised);
        await runtime.observer.notify({ hintPaths: ['nova.yaml'] });
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState()).toMatchObject({
            phase: 'dual-conflict',
            workingDirty: true,
          });
          expect(runtime.coordinator.getState().externalCandidate).not.toBeNull();
        });

        expect(runtime.coordinator.isAgentPaused()).toBe(true);
        expect(session.source?.sourceHash).toBe(source.sourceHash);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await persistence.dispose();
    }
  });

  it('removes a deleted accepted document from the catalog without overwriting working state', async () => {
    const persistence = createRealPersistence();
    try {
      const core = createYjsWorkingDocumentCore({
        persistence: createYjsPersistencePort(persistence.client),
      });
      const documents = createAuthoringDocumentStore({ projectId: 'catalog', core });
      const snapshot = (
        entries: readonly { readonly logicalPath: string; readonly content: string }[],
      ) =>
        buildSourceSnapshot(
          entries.map((entry) => ({
            version: 1 as const,
            logicalPath: entry.logicalPath,
            content: entry.content,
            contentHash: computeSourceDocumentHash(entry.content),
            parseResult: { status: 'parsed' as const, value: null },
            diagnostics: [],
          })),
        );
      await documents.seedFromAccepted(
        snapshot([
          { logicalPath: 'nova.yaml', content: 'project: catalog\n' },
          { logicalPath: 'definitions/discourse-ledger.yaml', content: 'version: 1\n' },
        ]),
      );
      expect(documents.descriptor('definitions/discourse-ledger.yaml')).not.toBeNull();
      const before = await documents.load({ projectId: 'catalog', documentId: 'nova.yaml' });
      if (before === null) throw new Error('accepted document was not hydrated into Yjs');
      const working = new Y.Doc();
      Y.applyUpdate(working, before.update);
      working.getText('prose').insert(working.getText('prose').length, '# local working edit\n');
      const applied = await documents.applyScopedUpdate({
        projectId: 'catalog',
        documentId: 'nova.yaml',
        expectedBaseVector: before.stateVector,
        expectedHumanPresenceGeneration: 0,
        update: Y.encodeStateAsUpdate(working),
      });
      expect(applied.ok).toBe(true);

      await documents.seedFromAccepted(
        snapshot([{ logicalPath: 'nova.yaml', content: 'project: catalog\n' }]),
      );

      expect(documents.descriptor('definitions/discourse-ledger.yaml')).toBeNull();
      expect(documents.acceptedContent('definitions/discourse-ledger.yaml')).toBeNull();
      expect(await documents.materializeDocument('nova.yaml')).toContain('# local working edit');
      documents.dispose();
      await core.close();
    } finally {
      await persistence.dispose();
    }
  });
});
