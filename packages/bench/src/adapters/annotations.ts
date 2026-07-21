// ============================================================================
// Novalistically Bench — Provenance Annotations for External Dataset Conversions
// ============================================================================
//
// Every converted entity from an external dataset carries a provenance marker
// that records:
//   - Which source dataset the entity originated from
//   - The original ID and type in the source system
//   - Per-field origin tracking (direct_map, llm_inferred, unavailable, synthesized)
//   - Conversion timestamp
//
// This enables traceability, reproducibility, and field-level confidence reporting.

type ProvenanceSource = 'chinovelke' | 'novel_agent_sft' | 'interactive_novels_3k';

type FieldOrigin = 'direct_map' | 'llm_inferred' | 'unavailable' | 'synthesized';

export interface ProvenanceAnnotation {
  source: ProvenanceSource;
  originalId: string;
  originalType: string;
  fieldOrigins: Record<string, FieldOrigin>;
  conversionTimestamp: string;
}

export function annotate(
  source: ProvenanceSource,
  originalId: string,
  originalType: string,
  fieldOrigins: Record<string, FieldOrigin>,
): ProvenanceAnnotation {
  return {
    source,
    originalId,
    originalType,
    fieldOrigins,
    conversionTimestamp: new Date().toISOString(),
  };
}

export function markDirect(fields: string[]): Record<string, FieldOrigin> {
  return Object.fromEntries(fields.map(f => [f, 'direct_map' as FieldOrigin]));
}

export function markMixed(
  direct: string[],
  inferred: string[],
  unavailable: string[] = [],
): Record<string, FieldOrigin> {
  const result: Record<string, FieldOrigin> = {};
  for (const f of direct) result[f] = 'direct_map';
  for (const f of inferred) result[f] = 'llm_inferred';
  for (const f of unavailable) result[f] = 'unavailable';
  return result;
}
