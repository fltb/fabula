// ============================================================================
// Plugin System — Validator Registry
// ============================================================================

import type { ValidatorContext, ValidationResult } from '../types/index.js';

export interface PluginValidator {
  name: string;
  validate(ctx: ValidatorContext): ValidationResult;
}

export class ValidatorRegistry {
  private validators: PluginValidator[] = [];

  register(validator: PluginValidator): void {
    this.validators.push(validator);
  }

  runAll(ctx: ValidatorContext): ValidationResult[] {
    return this.validators.map(v => v.validate(ctx));
  }
}
