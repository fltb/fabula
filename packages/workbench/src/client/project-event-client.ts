import type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringPresenceMemberV1,
  AuthoringStateV1,
  AuthoringSubmitReceiptV1,
} from '../contracts/authoring.js';
import {
  type AuthoringEventSubscription,
  type BrowserAuthoringApiError,
  type BrowserAuthoringClient,
} from './authoring-client.js';

export interface ProjectEventClientSnapshot {
  readonly projectId: string;
  readonly state: AuthoringStateV1 | null;
  readonly operations: readonly AuthoringOperationReceiptV1[];
  readonly lastSubmitReceipt: AuthoringSubmitReceiptV1 | null;
  readonly presence: readonly AuthoringPresenceMemberV1[];
  readonly presenceGeneration: number;
  readonly connected: boolean;
  readonly error: BrowserAuthoringApiError | null;
}

export interface ProjectEventClient {
  /** Fetch the initial safe state/operations and attach the SSE stream. */
  start(): Promise<ProjectEventClientSnapshot>;
  /** Detach the stream; no request is made by ordinary editor typing. */
  stop(): void;
  /** Current immutable safe projection for Source Studio/Operation Center. */
  snapshot(): ProjectEventClientSnapshot;
  /** Subscribe to local state changes caused by Host events. */
  subscribe(listener: (snapshot: ProjectEventClientSnapshot) => void): () => void;
  /** Apply one already-validated event; useful for deterministic client tests. */
  apply(event: AuthoringActivityEventV1): void;
}

function sortOperations(
  operations: readonly AuthoringOperationReceiptV1[],
): readonly AuthoringOperationReceiptV1[] {
  return [...operations].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1;
    return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0;
  });
}

/**
 * Project-scoped reducer for state/operation/presence/conflict events. It owns
 * no source bytes and performs no mutation itself; all effects originate from
 * the Host's versioned event stream or an explicit authoring-client command.
 */
export function createProjectEventClient(options: {
  readonly projectId: string;
  readonly client: BrowserAuthoringClient;
  readonly onChange?: (snapshot: ProjectEventClientSnapshot) => void;
}): ProjectEventClient {
  let state: AuthoringStateV1 | null = null;
  let operations: readonly AuthoringOperationReceiptV1[] = [];
  let lastSubmitReceipt: AuthoringSubmitReceiptV1 | null = null;
  let presence: readonly AuthoringPresenceMemberV1[] = [];
  let presenceGeneration = 0;
  let connected = false;
  let error: BrowserAuthoringApiError | null = null;
  let stream: AuthoringEventSubscription | null = null;
  let started = false;
  const listeners = new Set<(snapshot: ProjectEventClientSnapshot) => void>();

  const snapshot = (): ProjectEventClientSnapshot => ({
    projectId: options.projectId,
    state,
    operations,
    lastSubmitReceipt,
    presence,
    presenceGeneration,
    connected,
    error,
  });

  const emit = (): void => {
    const next = snapshot();
    options.onChange?.(next);
    for (const listener of listeners) listener(next);
  };

  const apply = (event: AuthoringActivityEventV1): void => {
    if (event.projectId !== options.projectId) return;
    switch (event.type) {
      case 'state-changed':
        state = event.state;
        break;
      case 'operation-updated': {
        const current = operations.filter((item) => item.operationId !== event.receipt.operationId);
        operations = sortOperations([...current, event.receipt]);
        break;
      }
      case 'submit-receipt':
        lastSubmitReceipt = event.receipt;
        break;
      case 'external-candidate':
        if (state !== null) {
          state = {
            ...state,
            externalCandidate: event.candidate,
            diagnostics: event.candidate.diagnostics,
            canSubmit: false,
            submitBlockReason: event.candidate.valid
              ? 'external-candidate-pending'
              : 'candidate-invalid',
            generatedAt: event.at,
          };
        }
        break;
      case 'presence-changed':
        presence = [...event.presence];
        presenceGeneration = event.generation;
        break;
    }
    error = null;
    emit();
  };

  const stop = (): void => {
    stream?.close();
    stream = null;
    if (connected) {
      connected = false;
      emit();
    }
  };

  const start = async (): Promise<ProjectEventClientSnapshot> => {
    if (started) return snapshot();
    started = true;
    try {
      const [nextState, nextOperations] = await Promise.all([
        options.client.getState(options.projectId),
        options.client.listOperations(options.projectId),
      ]);
      state = nextState;
      operations = sortOperations(nextOperations.operations);
      presence = [];
      presenceGeneration = 0;
      stream = options.client.subscribeEvents(options.projectId, {
        onEvent: apply,
        onError: (nextError) => {
          error = nextError;
          connected = false;
          emit();
        },
      });
      await stream.ready;
      connected = true;
      error = null;
      emit();
      return snapshot();
    } catch (nextError) {
      error = nextError as BrowserAuthoringApiError;
      connected = false;
      emit();
      throw nextError;
    }
  };

  return {
    start,
    stop,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply,
  };
}
