import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringFailureV1,
  type McpAuthoringApplyInputV1,
  type McpAuthoringApplyOutputV1,
  type McpAuthoringDocumentGetInputV1,
  type McpAuthoringDocumentGetOutputV1,
  type McpAuthoringSubmitInputV1,
  type McpAuthoringSubmitOutputV1,
  type McpConflictResolveInputV1,
  type McpConflictResolveOutputV1,
  type McpOperationGetInputV1,
  type McpOperationGetOutputV1,
  type McpAuthoringDocumentListInputV1,
  type McpAuthoringDocumentListOutputV1,
  type McpAuthoringDocumentReadInputV1,
  type McpAuthoringDocumentReadOutputV1,
  type McpAuthoringDocumentEditInputV1,
  type McpAuthoringDocumentCreateInputV1,
  type McpAuthoringDocumentMoveInputV1,
  type McpAuthoringDocumentDeleteInputV1,
  type McpAuthoringDocumentMutationOutputV1,
  type McpAuthoringConflictReadOutputV1,
} from '../../contracts/authoring.js';
import { AUTHORING_DOCUMENT_LIMITS_V1 } from '@novalistically/workbench-protocol';
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

function applyTextUpdate(
  current: Uint8Array | null,
  replacementText: string | undefined,
  edits: readonly { readonly start: number; readonly end: number; readonly replacementText: string }[] | undefined,
): Uint8Array {
  const doc = new Y.Doc();
  if (current !== null) Y.applyUpdate(doc, current);
  const text = doc.getText(WORKING_TEXT_TYPE);
  if (replacementText !== undefined) {
    if (text.length > 0) text.delete(0, text.length);
    if (replacementText.length > 0) text.insert(0, replacementText);
  } else if (edits !== undefined) {
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      text.delete(edit.start, edit.end - edit.start);
      if (edit.replacementText.length > 0) text.insert(edit.start, edit.replacementText);
    }
  }
  return Y.encodeStateAsUpdate(doc);
}

function emptyDocumentStateVectorHash(): string {
  return sha256(Y.encodeStateVector(new Y.Doc()));
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
  const lifecycle = async (
    kind: string,
    input: {
      readonly expectedAcceptedSourceHash: string | null;
      readonly expectedWorkspaceDigest: string;
    },
    caller: McpAuthorizedCaller,
    run: (operationId: string) => Promise<McpAuthoringDocumentMutationOutputV1>,
  ): Promise<McpAuthoringDocumentMutationOutputV1 | AuthoringFailureV1> => {
    const grant = await issue(caller, ['mcp:author']);
    let output: McpAuthoringDocumentMutationOutputV1 | AuthoringFailureV1 =
      failure('INTERNAL', 'The document mutation did not run.');
    const result = await session.enqueueOperation({
      kind,
      capabilityId: grant.grant.capabilityId,
      scope: ['mcp:author'],
      run: async (context) => {
        const state = coordinator.getState();
        if (state.acceptedSourceHash !== input.expectedAcceptedSourceHash) {
          output = failure('ACCEPTED_HASH_MISMATCH', 'The accepted source changed; re-read before mutating.');
          return;
        }
        const digest = await documents.workspaceDigest();
        if (digest?.digest !== input.expectedWorkspaceDigest) {
          output = failure('WORKSPACE_STALE', 'The working layer changed; re-read before mutating.');
          return;
        }
        try {
          output = await run(context.operationId);
        } catch (error) {
          output = failure(
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? (error.code as AuthoringFailureV1['code'])
              : 'INTERNAL',
            error instanceof Error ? error.message : 'The document mutation failed.',
          );
        }
      },
    });
    if (result.status === 'denied') return failure('SUBMIT_BLOCKED', 'The authoring capability is no longer valid.');
    if (result.status === 'failed') return failure('INTERNAL', 'The Host could not apply the document mutation.');
    return output;
  };

  return {
    projectId: session.projectId,
    getState: () => coordinator.getState(),
    async listDocuments(_input: McpAuthoringDocumentListInputV1) {
      const digest = await documents.workspaceDigest();
      const response: McpAuthoringDocumentListOutputV1 = {
        version: AUTHORING_CONTRACT_VERSION,
        documents: documents.descriptors().map((descriptor) => ({
          documentId: descriptor.documentId,
          logicalPath: descriptor.logicalPath,
          kind: descriptor.kind,
          state: descriptor.state,
          available: descriptor.available,
        })),
        workspaceDigest: digest?.digest ?? null,
      };
      return response;
    },

    async readDocument(input: McpAuthoringDocumentReadInputV1) {
      const descriptor = documents.descriptor(input.documentId);
      if (descriptor === null || descriptor.state === 'tombstone') {
        return failure('DOCUMENT_NOT_FOUND', 'The working document is unavailable.');
      }
      const state = await documents.load({ projectId: session.projectId, documentId: input.documentId });
      let content: string;
      let stateVectorHash: string;
      if (state === null) {
        content = documents.acceptedContent(descriptor.logicalPath) ?? '';
        stateVectorHash = emptyDocumentStateVectorHash();
      } else {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state.update);
        content = doc.getText(WORKING_TEXT_TYPE).toString();
        stateVectorHash = sha256(state.stateVector);
      }
      const offset = input.offset ?? 0;
      const limit = Math.min(
        input.limit ?? AUTHORING_DOCUMENT_LIMITS_V1.defaultReadCharacters,
        AUTHORING_DOCUMENT_LIMITS_V1.maxReadCharacters,
      );
      const digest = await documents.workspaceDigest();
      const response: McpAuthoringDocumentReadOutputV1 = {
        version: AUTHORING_CONTRACT_VERSION,
        documentId: input.documentId,
        logicalPath: descriptor.logicalPath,
        offset,
        limit,
        content: content.slice(offset, offset + limit),
        totalLength: content.length,
        contentHash: sha256(new TextEncoder().encode(content)),
        stateVectorHash,
        workspaceDigest: digest?.digest ?? null,
        acceptedSourceHash: coordinator.getState().acceptedSourceHash,
      };
      return response;
    },

    async editDocument(input: McpAuthoringDocumentEditInputV1, caller: McpAuthorizedCaller) {
      const descriptor = documents.descriptor(input.documentId);
      if (descriptor === null || descriptor.state === 'tombstone') {
        return { status: 'rejected', failure: failure('DOCUMENT_NOT_FOUND', 'The working document is unavailable.') };
      }
      if ((input.replacementText === undefined) === (input.edits === undefined)) {
        return { status: 'rejected', failure: failure('INVALID_INPUT', 'Provide exactly one of replacementText or edits.') };
      }
      if (input.edits !== undefined) {
        let previousEnd = 0;
        for (const edit of input.edits) {
          if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < previousEnd || edit.end < edit.start) {
            return { status: 'rejected', failure: failure('INVALID_INPUT', 'edits must be sorted, non-overlapping spans.') };
          }
          previousEnd = edit.end;
        }
      }
      return this.apply({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: session.projectId,
        documentId: input.documentId,
        expectedWorkspaceDigest: input.expectedWorkspaceDigest,
        expectedAcceptedSourceHash: input.expectedAcceptedSourceHash,
        expectedStateVectorHash: input.expectedStateVectorHash,
        ...(input.replacementText === undefined ? {} : { replacementText: input.replacementText }),
        ...(input.edits === undefined ? {} : { edits: input.edits }),
      }, caller);
    },

    async createDocument(input: McpAuthoringDocumentCreateInputV1, caller: McpAuthorizedCaller) {
      return lifecycle('mcp.authoring.document.create', input, caller, async (operationId) => {
        const descriptor = await documents.createDocument({
          documentId: session.runtime.services.ids.next({ kind: 'working_document' }),
          logicalPath: input.logicalPath,
          kind: input.kind ?? 'raw-yaml',
        });
        await coordinator.refreshWorkingState();
        const digest = await documents.workspaceDigest();
        return {
          status: 'applied',
          operationId,
          documentId: descriptor.documentId,
          logicalPath: descriptor.logicalPath,
          workspaceDigest: digest?.digest ?? '',
        };
      });
    },

    async moveDocument(input: McpAuthoringDocumentMoveInputV1, caller: McpAuthorizedCaller) {
      return lifecycle('mcp.authoring.document.move', input, caller, async (operationId) => {
        const descriptor = await documents.moveDocument({ documentId: input.documentId, logicalPath: input.logicalPath });
        await coordinator.refreshWorkingState();
        const digest = await documents.workspaceDigest();
        return { status: 'applied', operationId, documentId: descriptor.documentId, logicalPath: descriptor.logicalPath, workspaceDigest: digest?.digest ?? '' };
      });
    },

    async deleteDocument(input: McpAuthoringDocumentDeleteInputV1, caller: McpAuthorizedCaller) {
      return lifecycle('mcp.authoring.document.delete', input, caller, async (operationId) => {
        const descriptor = await documents.deleteDocument(input.documentId);
        await coordinator.refreshWorkingState();
        const digest = await documents.workspaceDigest();
        return { status: 'applied', operationId, documentId: descriptor.documentId, logicalPath: descriptor.logicalPath, workspaceDigest: digest?.digest ?? '' };
      });
    },

    async readConflict(_input: McpAuthoringDocumentListInputV1) {
      const state = coordinator.getState();
      return {
        version: AUTHORING_CONTRACT_VERSION,
        conflicts: state.conflicts,
        workspaceDigest: state.workspaceDigest,
      } satisfies McpAuthoringConflictReadOutputV1;
    },

    async getDocument(input: McpAuthoringDocumentGetInputV1) {
      const descriptor = documents.descriptor(input.documentId);
      if (descriptor === null)
        return failure('DOCUMENT_NOT_FOUND', 'The working document is unavailable.');
      const state = await documents.load({
        projectId: session.projectId,
        documentId: input.documentId,
      });
      const response: McpAuthoringDocumentGetOutputV1 = {
        version: AUTHORING_CONTRACT_VERSION,
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
          if (
            input.expectedStateVectorHash !== undefined &&
            sha256(live?.stateVector ?? new Uint8Array()) !== input.expectedStateVectorHash
          ) {
            output = {
              status: 'stale',
              failure: failure('WORKSPACE_STALE', 'The working document changed; re-read before applying.'),
            };
            return;
          }
          const applied = await documents.applyScopedUpdate({
            projectId: session.projectId,
            documentId: input.documentId,
            expectedBaseVector: live?.stateVector ?? new Uint8Array(),
            expectedHumanPresenceGeneration: session.presenceGeneration,
            update: applyTextUpdate(live?.update ?? null, input.replacementText, input.edits),
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
        typeof receipt.operationId === 'string' &&
        typeof receipt.revisionId === 'string' &&
        typeof receipt.acceptedSourceHash === 'string' &&
        typeof receipt.receiptHash === 'string'
      ) {
        return {
          status: 'completed',
          receipt,
          submit: {
            version: AUTHORING_CONTRACT_VERSION,
            projectId: receipt.projectId,
            operationId: receipt.operationId,
            revisionId: receipt.revisionId,
            acceptedSourceHash: receipt.acceptedSourceHash,
            receiptHash: receipt.receiptHash,
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
        version: AUTHORING_CONTRACT_VERSION,
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
