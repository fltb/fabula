// ============================================================================
// ConfigLoader — 5-layer configuration with deep merge and Zod validation
// ============================================================================
//
// Layers (latter-wins):
//   1. defaults  — built-in default values
//   2. project   — nova.yaml project-level overrides
//   3. env       — environment variable overrides
//   4. cli       — CLI flag overrides
//   5. runtime   — programmatic in-memory overrides
// ============================================================================

import type { z } from 'zod';
import { DEFAULT_CONFIG, type DefaultConfig } from './defaults.js';

export interface ConfigLayer {
  name: string;
  values: Partial<Record<string, unknown>>;
}

export class ConfigLoader {
  private layers: ConfigLayer[] = [];

  constructor() {
    this.addLayer('defaults', DEFAULT_CONFIG);
  }

  addLayer(name: string, values: Record<string, unknown>): void {
    this.layers.push({ name, values });
  }

  /**
   * Deep-merge all layers, latter-wins.
   * Returns a plain record; use `validate()` for typed access.
   */
  resolve(): Record<string, unknown> {
    return this.layers.reduce(
      (merged, layer) => {
        return this.deepMerge(merged, layer.values as Record<string, unknown>);
      },
      {} as Record<string, unknown>,
    );
  }

  /** Resolve and validate against a Zod schema, returning typed output. */
  validate<T>(schema: z.ZodType<T>): T {
    return schema.parse(this.resolve());
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = target[key];
      if (
        sv !== null &&
        typeof sv === 'object' &&
        !Array.isArray(sv) &&
        tv !== null &&
        typeof tv === 'object' &&
        !Array.isArray(tv)
      ) {
        result[key] = this.deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        result[key] = sv;
      }
    }
    return result;
  }
}

/**
 * Convenience: build a fully resolved config from project-level overrides.
 * Layers: defaults → project overrides.
 */
export function resolveConfig(overrides?: Partial<DefaultConfig>): DefaultConfig {
  const loader = new ConfigLoader();
  if (overrides) {
    loader.addLayer('project', overrides as Record<string, unknown>);
  }
  return loader.resolve() as DefaultConfig;
}
