import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type {
  AuthoringFailureV1,
  McpAuthoringApplyInputV1,
  McpAuthoringApplyOutputV1,
  McpAuthoringDocumentGetInputV1,
  McpAuthoringDocumentGetOutputV1,
  McpAuthoringSubmitInputV1,
  McpAuthoringSubmitOutputV1,
  McpConflictResolveInputV1,
  McpConflictResolveOutputV1,
  McpOperationGetInputV1,
  McpOperationGetOutputV1,
} from '../../contracts/authoring.js';
import type { AgentCapabilityService } from '../agent/capability-service.js';
import type { McpAuthorizedCaller } from '../mcp/auth.js';
import type { McpAuthoringCoordinatorPort } from '../mcp/registry.js';
import type { ProjectSession } from '../project-session.js';
import { type AuthoringWorkingDocumentStore, WORKING_TEXT_TYPE } from './document-store.js';
import type { AuthoringCoordinator } from './types.js';

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code: AuthoringFailureV1['code'], message: string): AuthoringFailureV1 {
  return { code, message };
}

function replaceTextUpdate(current: Uint8Array | null, replacementText: string): Uint8Array {
  const doc = new Y.Doc();
  if (current !== null) Y.applyUpdate(doc, current);
  const text = doc.getText(WORKING_TEXT_TYPE);
  const length = text.length;
  if (length > 0) text.delete(0, length);
  if (replacementText.length > 0) text.insert(0, replacementText);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * MCP adapter over a single project coordinator and its shared Yjs document
 * store. It turns an already-authorized MCP caller into a short-lived
 * persisted capability before every mutation, so device grants and browser
 * grants pass through the same ProjectSession recheck and queue.
 */
export function createMcpAuthoringCoordinatorPort(options: {
  readonly session: ProjectSession;
  readonly coordinator: AuthoringCoordinator;
  readonly documents: AuthoringWorkingDocumentStore;
  readonly capabilities: AgentCapabilityService;
}): McpAuthoringCoordinatorPort {
  const { session, coordinator, documents, capabilities } = options;
  const issue = async (caller: McpAuthorizedCaller, scopes: readonly string[]) =>
    capabilities.issue({
      userId: caller.userId,
      projectId: session.projectId,
      scopes,
    });

  return {
    projectId: session.projectId,
    getState: () => coordinator.getState(),

    async getDocument(input: McpAuthoringDocumentGetInputV1) {
      const descriptor = documents.descriptor(input.documentId);
      if (descriptor === null)
        return failure('DOCUMENT_NOT_FOUND', 'The working document is unavailable.');
      const state = await documents.load({
        projectId: session.projectId,
        documentId: input.documentId,
      });
      const response: McpAuthoringDocumentGetOutputV1 = {
        version: 1,
        projectId: session.projectId,
        documentId: input.documentId,
        logicalPath: descriptor.logicalPath,
        available: descriptor.available,
        stateVectorHash: state === null ? null : sha256(state.stateVector),
        acceptedSourceHash: coordinator.getState().acceptedSourceHash,
      };
      return response;
    },

    async apply(input: McpAuthoringApplyInputV1, caller: McpAuthorizedCaller) {
      const descriptor = documents.descriptor(input.documentId);
      if (descriptor === null) {
        return {
          status: 'rejected',
          failure: failure('DOCUMENT_NOT_FOUND', 'The working document is unavailable.'),
        } satisfies McpAuthoringApplyOutputV1;
      }
      const grant = await issue(caller, ['mcp:author']);
      let output: McpAuthoringApplyOutputV1 = {
        status: 'rejected',
        failure: failure('INTERNAL', 'The mutation did not run.'),
      };
      const result = await session.enqueueOperation({
        kind: 'mcp.authoring.apply',
        capabilityId: grant.grant.capabilityId,
        scope: ['mcp:author'],
        run: async () => {
          const state = coordinator.getState();
          if (state.acceptedSourceHash !== input.expectedAcceptedSourceHash) {
            output = {
              status: 'stale',
              failure: failure(
                'ACCEPTED_HASH_MISMATCH',
                'The accepted source changed; re-read before applying.',
              ),
            };
            return;
          }
          const digest = await documents.workspaceDigest();
          if (digest === null || digest.digest !== input.expectedWorkspaceDigest) {
            output = {
              status: 'stale',
              failure: failure(
                'WORKSPACE_STALE',
                'The working layer changed; re-read before applying.',
              ),
            };
            return;
          }
          const live = await documents.load({
            projectId: session.projectId,
            documentId: input.documentId,
          });
          const applied = await documents.applyScopedUpdate({
            projectId: session.projectId,
            documentId: input.documentId,
            expectedBaseVector: live?.stateVector ?? new Uint8Array(),
            expectedHumanPresenceGeneration: session.presenceGeneration,
            update: replaceTextUpdate(live?.update ?? null, input.replacementText),
          });
          if (!applied.ok) {
            output = {
              status: 'stale',
              failure: failure(
                'WORKSPACE_STALE',
                'The working document changed; re-read before applying.',
              ),
            };
            return;
          }
          await coordinator.refreshWorkingState();
          const updatedDigest = await documents.workspaceDigest();
          output = {
            status: 'applied',
            workspaceDigest: updatedDigest?.digest ?? '',
            stateVectorHash: sha256(applied.ticket.stateVector),
          };
        },
      });
      if (result.status === 'denied') {
        return {
          status: 'rejected',
          failure: failure('SUBMIT_BLOCKED', 'The authoring capability is no longer valid.'),
        } satisfies McpAuthoringApplyOutputV1;
      }
      if (result.status === 'failed') {
        return {
          status: 'rejected',
          failure: failure('INTERNAL', 'The Host could not apply the working edit.'),
        } satisfies McpAuthoringApplyOutputV1;
      }
      return output;
    },

    async submit(input: McpAuthoringSubmitInputV1, caller: McpAuthorizedCaller) {
      const state = coordinator.getState();
      const grant = await issue(caller, ['mcp:submit']);
      const receipt = await coordinator.submit({
        expectedAcceptedSourceHash: state.acceptedSourceHash,
        expectedWorkspaceDigest: input.expectedWorkspaceDigest,
        ...(input.message === undefined ? {} : { message: input.message }),
        actorId: caller.userId,
        capabilityId: grant.grant.capabilityId,
        capabilityScopes: ['mcp:submit'],
      });
      if (
        receipt.status === 'completed' &&
        typeof receipt.gitSubmitId === 'string' &&
        typeof receipt.gitCommit === 'string' &&
        typeof receipt.acceptedSourceHash === 'string' &&
        typeof receipt.gitReceiptHash === 'string'
      ) {
        return {
          status: 'completed',
          receipt,
          submit: {
            version: 1,
            projectId: receipt.projectId,
            submitId: receipt.gitSubmitId,
            gitCommit: receipt.gitCommit,
            acceptedSourceHash: receipt.acceptedSourceHash,
            gitReceiptHash: receipt.gitReceiptHash,
            acceptedAt: receipt.updatedAt,
          },
        } satisfies McpAuthoringSubmitOutputV1;
      }
      if (receipt.status === 'queued' || receipt.status === 'running') {
        return { status: 'queued', receipt } satisfies McpAuthoringSubmitOutputV1;
      }
      return {
        status: 'rejected',
        failure: failure(
          receipt.errorCode === 'WORKSPACE_STALE' ? 'WORKSPACE_STALE' : 'SUBMIT_BLOCKED',
          'The submit was not accepted by the coordinator.',
        ),
      } satisfies McpAuthoringSubmitOutputV1;
    },

    async getOperation(input: McpOperationGetInputV1) {
      const response: McpOperationGetOutputV1 = {
        version: 1,
        operationId: input.operationId,
        receipt: coordinator.getOperation(input.operationId),
      };
      return response;
    },

    async resolveConflict(input: McpConflictResolveInputV1, caller: McpAuthorizedCaller) {
      const grant = await issue(caller, ['mcp:submit']);
      const receipt = await coordinator.reconcileExternal({
        choice: input.choice,
        candidateHash: input.candidateHash,
        expectedAcceptedSourceHash: coordinator.getState().acceptedSourceHash,
        actorId: caller.userId,
        capabilityId: grant.grant.capabilityId,
        capabilityScopes: ['mcp:submit'],
      });
      return receipt.status === 'completed'
        ? { status: 'completed', receipt }
        : receipt.status === 'queued' || receipt.status === 'running'
          ? { status: 'queued', receipt }
          : {
              status: 'rejected',
              failure: failure(
                'CONFLICT_REQUIRES_RESOLUTION',
                'The conflict resolution was not accepted.',
              ),
            };
    },
  };
}
