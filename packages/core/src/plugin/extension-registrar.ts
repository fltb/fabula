// ============================================================================
// PluginExtensionSchemaRegistrar — EventFile `extensions` namespace gate
//
// The strict EventFile schema accepts an `extensions` block of structural
// JsonValue keyed by plugin name. This registrar is the second, identity-aware
// gate: it enforces that every namespace is an ENABLED plugin and, when the
// plugin declares an extension schema, that the payload satisfies it.
//
// Rules:
//   - An extension key for a plugin that is not enabled (or unknown) is a
//     SOURCE ERROR — it never reaches render or state.
//   - An enabled plugin validates its own namespace; absent a declared
//     schema, structural JsonValue (already enforced by the base schema) is
//     accepted.
//   - Extensions are read-only source data: they never enter WorldState and
//     never mutate state; all source modification stays working
//     validate → submit.
// ============================================================================

import type { ZodType } from 'zod';
import type { JsonValue, SourceDiagnosticV1 } from '../contracts/index.js';

/** One enabled plugin's extension namespace contract. */
export interface PluginExtensionSchema {
  /** Enabled plugin name — the exact namespace key in EventFile `extensions`. */
  readonly name: string;
  /**
   * Optional shape validator for this plugin's namespace. When absent, any
   * structural JsonValue is accepted (base eventFileSchema already enforces
   * JSON-safe shape).
   */
  readonly schema?: ZodType<unknown>;
}

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates EventFile `extensions` blocks against the enabled plugin set.
 * Pure and deterministic: no I/O, no clock, no hooks.
 */
export class PluginExtensionSchemaRegistrar {
  private readonly activeByName: ReadonlyMap<string, ZodType<unknown> | null>;

  constructor(activePlugins: readonly PluginExtensionSchema[]) {
    const byName = new Map<string, ZodType<unknown> | null>();
    for (const plugin of activePlugins) {
      byName.set(plugin.name, plugin.schema ?? null);
    }
    this.activeByName = byName;
  }

  /** Sorted names of enabled plugins (deterministic). */
  names(): readonly string[] {
    return [...this.activeByName.keys()].sort();
  }

  /** True when `pluginName` is an enabled extension namespace. */
  isEnabled(pluginName: string): boolean {
    return this.activeByName.has(pluginName);
  }

  /**
   * Validate one EventFile `extensions` record.
   * Unknown/disabled namespaces and declared-schema violations produce
   * error-severity SourceDiagnosticV1 entries; structurally invalid shapes
   * (non-record) are flagged when the base schema did not already reject
   * the document.
   */
  validateExtensions(
    extensions: unknown,
    logicalPath: string,
    schemaAlreadyRejected: boolean,
  ): SourceDiagnosticV1[] {
    if (extensions === undefined) return [];
    if (!isRecord(extensions)) {
      return [
        {
          code: 'SOURCE_EXTENSION_INVALID',
          severity: 'error',
          message: 'extensions must be an object keyed by enabled plugin name',
          logicalPath,
        },
      ];
    }
    const diagnostics: SourceDiagnosticV1[] = [];
    for (const [pluginName, value] of Object.entries(extensions)) {
      const declaredSchema = this.activeByName.get(pluginName);
      if (declaredSchema === undefined) {
        diagnostics.push({
          code: 'SOURCE_EXTENSION_NAMESPACE_UNKNOWN',
          severity: 'error',
          message: `Event extension namespace "${pluginName}" is not an enabled plugin`,
          logicalPath,
        });
        continue;
      }
      if (declaredSchema !== null && !schemaAlreadyRejected) {
        const checked = declaredSchema.safeParse(value);
        if (!checked.success) {
          diagnostics.push({
            code: 'SOURCE_EXTENSION_SCHEMA_INVALID',
            severity: 'error',
            message: `Plugin "${pluginName}" extension schema rejected: ${checked.error.issues
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; ')}`,
            logicalPath,
          });
        }
      }
    }
    return diagnostics;
  }
}
