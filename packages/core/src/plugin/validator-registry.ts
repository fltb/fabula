import type {
  AnalysisBlockRequirement,
  ValidationResult,
  ValidatorContext,
} from '../types/index.js';

export interface PluginValidator {
  name: string;
  validate(ctx: ValidatorContext): ValidationResult;
  /** Optional: contribute analysis blocks to the dynamic Pass 2 schema. */
  getAnalysisRequirements?(): AnalysisBlockRequirement[];
}

export class ValidatorRegistry {
  private _validators: PluginValidator[] = [];

  register(validator: PluginValidator): void {
    this._validators.push(validator);
  }

  runAll(ctx: ValidatorContext): ValidationResult[] {
    return this._validators.map((v) => v.validate(ctx));
  }

  /** Get all registered plugin validators */
  get validators(): PluginValidator[] {
    return [...this._validators];
  }
}
