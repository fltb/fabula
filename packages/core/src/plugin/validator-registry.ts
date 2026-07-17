// ============================================================================
// Plugin System — Validator Registry
// ============================================================================

import type { ValidatorContext, ValidationResult } from '../types/index.js';

export interface PluginValidator {
  name: string;
  validate(ctx: ValidatorContext): ValidationResult;
}

export class ValidatorRegistry {
  private _validators: PluginValidator[] = [];

  register(validator: PluginValidator): void {
    this._validators.push(validator);
  }

  runAll(ctx: ValidatorContext): ValidationResult[] {
    return this._validators.map(v => v.validate(ctx));
  }

  /** Get all registered plugin validators */
  get validators(): PluginValidator[] {
    return [...this._validators];
  }
}
