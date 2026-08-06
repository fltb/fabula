import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginExtensionSchemaRegistrar } from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { MockProvider } from '@novalistically/core/testing';
import {
  createFileCoreRuntimeServices,
  FileProjectSourceLoader,
  FileProjectStatusReporter,
} from '@novalistically/node-host';
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
  it('stages observer candidates and reconciles them through native revisions', async () => {
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

        // The durable record's sourceHash is the immutable accepted-source
        // identity the operation was CAS-bound to at creation; the newly
        // accepted hash flows via the submit-receipt event and the authoring
        // state, not through the derived receipt.
        expect(receipt).toMatchObject({
          status: 'completed',
          acceptedSourceHash: state.acceptedSourceHash,
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

  it('reports an unknown extension namespace as a source error through validateWorking', async () => {
    const root = copyFixture();
    const persistence = createRealPersistence();
    try {
      const stagingRoot = mkdtempSync(join(tmpdir(), 'wb-authoring-extensions-'));
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
      // No enabled plugins (plan 7.5): every extension namespace is unknown.
      const runtime = await createProjectAuthoringRuntime({
        projectId: 'fixture',
        projectRoot: root,
        hostStagingRoot: stagingRoot,
        session,
        capabilities,
        persistence: persistence.client,
        yjsCore: core,
        events: { publish: () => undefined },
        extensionRegistrar: new PluginExtensionSchemaRegistrar([]),
      });
      try {
        const eventPath = 'chapters/chapter_01/E0_arrival.yaml';
        const before = await runtime.documents.load({
          projectId: 'fixture',
          documentId: eventPath,
        });
        if (before === null) throw new Error('accepted event document was not hydrated into Yjs');
        const working = new Y.Doc();
        Y.applyUpdate(working, before.update);
        const text = working.getText('prose');
        text.insert(text.length, '\nextensions:\n  unknown-plugin:\n    enabled: true\n');
        const applied = await runtime.documents.applyScopedUpdate({
          projectId: 'fixture',
          documentId: eventPath,
          expectedBaseVector: before.stateVector,
          expectedHumanPresenceGeneration: session.presenceGeneration,
          update: Y.encodeStateAsUpdate(working),
        });
        expect(applied.ok).toBe(true);
        await vi.waitFor(() => {
          expect(runtime.coordinator.getState().phase).toBe('working-dirty');
        });
        const digest = await runtime.documents.workspaceDigest();
        if (digest === null) throw new Error('no workspace digest');
        const result = await runtime.coordinator.validateWorking({
          expectedWorkspaceDigest: digest.digest,
          expectedAcceptedSourceHash: runtime.coordinator.getState().acceptedSourceHash,
        });
        expect(result.passed).toBe(false);
        expect(
          result.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'SOURCE_EXTENSION_NAMESPACE_UNKNOWN' &&
              diagnostic.severity === 'error',
          ),
        ).toBe(true);
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

  it('refreshes the derived PROJECT_STATUS.md after an accepted submit without rolling back', async () => {
    const root = copyFixture();
    const persistence = createRealPersistence();
    try {
      const stagingRoot = mkdtempSync(join(tmpdir(), 'wb-authoring-status-'));
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
      const reporter = new FileProjectStatusReporter(root);
      const runtime = await createProjectAuthoringRuntime({
        projectId: 'fixture',
        projectRoot: root,
        hostStagingRoot: stagingRoot,
        session,
        capabilities,
        persistence: persistence.client,
        yjsCore: core,
        events: { publish: () => undefined },
        statusReporter: reporter,
      });
      try {
        const original = readFileSync(join(root, 'nova.yaml'), 'utf8');
        const revised = original.replace(/^title:.*$/m, 'title: "Status Refreshed Fixture"');
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
        expect(receipt).toMatchObject({ status: 'completed' });
        const acceptedSourceHash = session.source?.sourceHash;
        if (acceptedSourceHash === undefined)
          throw new Error('session has no accepted source after submit');

        // The derived status file refresh is best-effort and asynchronous.
        await vi.waitFor(async () => {
          const markdown = await readFile(join(root, 'PROJECT_STATUS.md'), 'utf8');
          expect(markdown).toContain(acceptedSourceHash);
        });
        expect(reporter.degraded).toBe(false);
        const markdown = await readFile(join(root, 'PROJECT_STATUS.md'), 'utf8');
        expect(markdown).toContain('# Project Status');
        expect(markdown).toContain('fixture');
        expect(markdown).toContain(receipt.revisionId ?? '');
        expect(markdown).toContain('## Next actions');

        // The status write never rolls back the accepted native revision.
        await expect(runtime.revision.loadAccepted('fixture')).resolves.toMatchObject({
          sourceHash: acceptedSourceHash,
        });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await persistence.dispose();
    }
  });
});
