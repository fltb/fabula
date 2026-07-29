import { NovalisticallyError, type ErrorContext } from '../errors.ts';
import type { EditorialError, EditorialErrorCode } from '../types/editorial.ts';

export class EditorialOperationError extends NovalisticallyError {
  constructor(code: EditorialErrorCode, message: string, context: ErrorContext = {}) {
    super(code, message, context);
  }
}

export class PublicationError extends EditorialOperationError {
  readonly reasons: readonly EditorialError[];

  constructor(message: string, reasons: readonly EditorialError[]) {
    super('PUBLICATION_INCOMPLETE', message);
    this.reasons = Object.freeze([...reasons]);
  }
}

export function toEditorialError(error: unknown): EditorialError {
  if (error instanceof EditorialOperationError) {
    return {
      code: error.code as EditorialErrorCode,
      message: error.message,
      ...(error.context.eventId ? { eventId: error.context.eventId } : {}),
      ...(error.context.path ? { path: error.context.path } : {}),
      ...(error.context.operationId ? { operationId: error.context.operationId } : {}),
    };
  }
  if (error instanceof NovalisticallyError && error.code === 'STORAGE_CONFLICT') {
    return {
      code: 'STORAGE_CONFLICT',
      message: error.message,
      ...(error.context.path ? { path: error.context.path } : {}),
      ...(error.context.operationId ? { operationId: error.context.operationId } : {}),
    };
  }
  return {
    code: 'INVALID_OPERATION',
    message: error instanceof Error ? error.message : String(error),
  };
}
