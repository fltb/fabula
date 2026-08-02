import type { Validator } from '../types/index.js';

/**
 * Narrow registrar surface handed to plugin `registerValidators` hooks.
 * Plugins can only append validators — no introspection, mutation, or
 * invocation beyond registration.
 */
export interface ValidatorRegistrar {
  register(validator: Validator): void;
}

export class ValidatorRegistry implements ValidatorRegistrar {
  private _validators: Validator[] = [];

  register(validator: Validator): void {
    this._validators.push(validator);
  }

  /** Get all registered validators */
  list(): readonly Validator[] {
    return [...this._validators];
  }
}
