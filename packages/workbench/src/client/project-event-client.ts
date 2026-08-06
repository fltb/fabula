import type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringPresenceMemberV1,
  AuthoringStateV1,
  AuthoringSubmitReceiptV1,
} from '../contracts/authoring.js';
import type {
  AuthoringEventSubscription,
  BrowserAuthoringApiError,
  BrowserAuthoringClient,
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
export interface ProjectEventClientOptions {
  readonly projectId: string;
  readonly client: BrowserAuthoringClient;
  readonly onChange?: (snapshot: ProjectEventClientSnapshot) => void;
  /**
   * Consecutive failed connect attempts before the client gives up and stays
   * disconnected, relying on store-first reads and explicit refresh actions.
   * Defaults to 5 (one initial attempt plus five bounded retries).
   */
  readonly maxReconnectAttempts?: number;
  /** First reconnect delay in ms; each attempt doubles until the cap. Default 500. */
  readonly reconnectBaseDelayMs?: number;
  /** Backoff cap in ms. Default 8000. */
  readonly reconnectMaxDelayMs?: number;
}

export function createProjectEventClient(options: ProjectEventClientOptions): ProjectEventClient {
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 8000;

  let state: AuthoringStateV1 | null = null;
  let operations: readonly AuthoringOperationReceiptV1[] = [];
  let lastSubmitReceipt: AuthoringSubmitReceiptV1 | null = null;
  let presence: readonly AuthoringPresenceMemberV1[] = [];
  let presenceGeneration = 0;
  let connected = false;
  let error: BrowserAuthoringApiError | null = null;
  let stream: AuthoringEventSubscription | null = null;
  let started = false;
  // Reconnect state: `active` gates retries while the workspace is live,
  // `connecting` guards re-entrancy from the stream error callback, and the
  // timer owns one pending retry at a time.
  let active = false;
  let connecting = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * Schedule one bounded retry. The stream error callback and the connect
   * failure path both land here; the single-timer guard collapses the initial
   * failure's duplicate notifications into one backoff cycle.
   */
  const scheduleReconnect = (nextError: BrowserAuthoringApiError): void => {
    if (!active || connecting || reconnectTimer !== null) return;
    if (reconnectAttempt >= maxReconnectAttempts) {
      // Permanent failure: stay disconnected and rely on store-first reads
      // plus the explicit refresh actions; retrying would only spin.
      error = nextError;
      connected = false;
      emit();
      return;
    }
    reconnectAttempt += 1;
    const delay = Math.min(reconnectBaseDelayMs * 2 ** (reconnectAttempt - 1), reconnectMaxDelayMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attemptConnect();
    }, delay);
  };

  const attemptConnect = async (): Promise<void> => {
    connecting = true;
    try {
      // Store-first read: rehydrate from the durable store before resuming
      // the live stream, so a dropped SSE connection never resumes from a
      // stale in-memory view.
      const [nextState, nextOperations] = await Promise.all([
        options.client.getState(options.projectId),
        options.client.listOperations(options.projectId),
      ]);
      if (!active) return;
      state = nextState;
      operations = sortOperations(nextOperations.operations);
      presence = [];
      presenceGeneration = 0;
      const nextStream = options.client.subscribeEvents(options.projectId, {
        onEvent: apply,
        onError: (nextError) => {
          error = nextError;
          connected = false;
          emit();
          scheduleReconnect(nextError);
        },
      });
      stream = nextStream;
      await nextStream.ready;
      if (!active) {
        nextStream.close();
        return;
      }
      connected = true;
      error = null;
      reconnectAttempt = 0;
      emit();
    } catch (nextError) {
      if (!active) return;
      error = nextError as BrowserAuthoringApiError;
      connected = false;
      // The stream error callback fires while this attempt is still marked
      // connecting (it cannot schedule); the failure path owns the retry.
      connecting = false;
      emit();
      scheduleReconnect(nextError as BrowserAuthoringApiError);
    } finally {
      connecting = false;
    }
  };

  const stop = (): void => {
    active = false;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
    active = true;
    // Resolves once the first attempt settles (connected or not); bounded
    // background retries continue while the client stays active.
    await attemptConnect();
    return snapshot();
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
