// ============================================================================
// Shared helpers for all validators
// ============================================================================

import type {
  EntityKind,
  EntityTypeCatalog,
  NarrativeCheck,
  ValidationIssue,
  WritePolicy,
} from '../types/index.js';

// ============================================================================
// Issue and observation helpers
// ============================================================================

export function makeIssue(
  validator: string,
  eventId: string,
  entity: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  fixSuggestion: string,
  fixAction: ValidationIssue['fixAction'] = 'manual',
  attribute?: string,
  file?: string,
  value?: unknown,
  kind: ValidationIssue['kind'] = 'compiler_invariant',
  observationRef?: ValidationIssue['observationRef'],
): ValidationIssue {
  return {
    validator,
    severity,
    kind,
    event: eventId,
    entity,
    attribute,
    message,
    fixSuggestion,
    fixAction,
    fixTarget: { file: file ?? '', field: attribute, value },
    observationRef,
  };
}

/**
 * Build an `ObservationRef` for a finding: `field` is the top-level analysis
 * field key in `AnalysisResult.observations`; `analysisPointer` is an optional
 * RFC 6901 pointer into `AnalysisResult.analysis` identifying the atomic
 * payload the finding actually consumed. The aggregator validates both and
 * rejects pointers that do not resolve or whose first segment does not match
 * `field`.
 */
export function makeObservationRef(
  field: string,
  analysisPointer?: string,
): ValidationIssue['observationRef'] {
  return analysisPointer === undefined ? { field } : { field, analysisPointer };
}

// ============================================================================
// Catalog-driven attribute lookup helpers (STATE-3b)
// ============================================================================
// Replace hardcoded attribute-name checks in validators with semanticRole
// and writePolicy lookups from the entity type catalog.
// ============================================================================

/**
 * Look up the semanticRole for a given entity kind + attributeId from the
 * project's compiled entity type catalog. No default catalog: an absent
 * catalog yields no lookup, so catalog-driven checks are skipped.
 */
export function getAttributeSemanticRole(
  catalog: EntityTypeCatalog | undefined,
  kind: EntityKind,
  attributeId: string,
): string | undefined {
  const typeDef = catalog?.types[kind];
  if (!typeDef) return undefined;
  const attrDef = typeDef.attributes[attributeId];
  return attrDef?.semanticRole;
}

/**
 * Look up the writePolicy for a given entity kind + attributeId from the
 * project's compiled entity type catalog. No default catalog fallback.
 */
export function getAttributeWritePolicy(
  catalog: EntityTypeCatalog | undefined,
  kind: EntityKind,
  attributeId: string,
): WritePolicy | undefined {
  const typeDef = catalog?.types[kind];
  if (!typeDef) return undefined;
  const attrDef = typeDef.attributes[attributeId];
  return attrDef?.writePolicy;
}

/**
 * Get all attributeIds for an entity kind with a specific semanticRole from
 * the project's compiled entity type catalog. No default catalog fallback.
 */
export function getAttributesBySemanticRole(
  catalog: EntityTypeCatalog | undefined,
  kind: EntityKind,
  semanticRole: string,
): string[] {
  const typeDef = catalog?.types[kind];
  if (!typeDef) return [];
  return Object.values(typeDef.attributes)
    .filter((a) => a.semanticRole === semanticRole)
    .map((a) => a.attributeId);
}

// ============================================================================
// consumeNarrativeChecks — Iterate parsed narrative checks with predicate
// ============================================================================
// Takes an already-parsed array of NarrativeCheck objects (from Zod-safeParse)
// and applies a predicate + issue-factory for each matching check.
// ============================================================================

export function consumeNarrativeChecks(
  checks: NarrativeCheck[],
  predicate: (check: NarrativeCheck) => boolean,
  makeIssueFn: (check: NarrativeCheck, index: number) => ValidationIssue,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index];
    if (predicate(check)) {
      issues.push(makeIssueFn(check, index));
    }
  }
  return issues;
}
