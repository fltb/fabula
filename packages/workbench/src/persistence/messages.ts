import type {
  PersistenceError,
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
} from '../contracts/persistence.js';

export interface PersistenceRequest<O extends PersistenceOperation = PersistenceOperation> {
  correlationId: string;
  operation: O;
  payload: PersistencePayloads[O];
}
export interface PersistenceSuccess<O extends PersistenceOperation = PersistenceOperation> {
  correlationId: string;
  ok: true;
  operation: O;
  result: PersistenceResults[O];
}
export interface PersistenceFailure {
  correlationId: string;
  ok: false;
  error: PersistenceError;
}
export type PersistenceResponse<O extends PersistenceOperation = PersistenceOperation> =
  | PersistenceSuccess<O>
  | PersistenceFailure;
export type PersistenceMessage = PersistenceRequest | PersistenceResponse;

export interface PersistenceMessagePort {
  postMessage(message: PersistenceRequest): void;
  addEventListener(type: 'message', listener: (event: { data: PersistenceResponse }) => void): void;
  removeEventListener?(
    type: 'message',
    listener: (event: { data: PersistenceResponse }) => void,
  ): void;
}

export function serializePersistenceError(error: unknown): PersistenceError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const value = error as {
      code: unknown;
      message: unknown;
      retryable?: unknown;
      details?: unknown;
    };
    return {
      code: String(value.code),
      message: String(value.message),
      retryable: value.retryable === true,
      ...(value.details && typeof value.details === 'object'
        ? { details: value.details as Record<string, string> }
        : {}),
    };
  }
  return {
    code: 'PERSISTENCE_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
