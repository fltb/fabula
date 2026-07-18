// ============================================================================
// Novalistically Bench — Shared LLM Extraction Layer
// ============================================================================
//
// For fields that cannot be mechanically mapped from external datasets, this
// module provides a structured extraction layer. It builds prompts from raw
// text, parses LLM responses, and merges extracted fields back into conversion
// results while updating provenance annotations.
//
// Not every adapter uses this — only datasets with free-text fields that
// require semantic extraction (e.g. character description → structured traits).

import type { ProvenanceAnnotation } from './annotations.js';

export interface ExtractionRequest {
  rawText: string;
  targetFields: string[];
  context?: string;
}

export interface ExtractedFields {
  fields: Record<string, unknown>;
  confidence: number;
  rationale: string;
}

export function buildExtractionPrompt(request: ExtractionRequest): string {
  const fieldsList = request.targetFields.join(', ');
  const context = request.context ?? '';
  return `Extract the following structured fields from the text: ${fieldsList}.
${context ? `Context: ${context}\n` : ''}
Text: """${request.rawText}"""
Output ONLY valid JSON with the requested fields. Include a "confidence" score (0-1) and "rationale" for each extraction.`;
}

export function parseExtractionResponse(raw: string): ExtractedFields | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      fields: parsed.fields ?? parsed,
      confidence: parsed.confidence ?? 0.5,
      rationale: parsed.rationale ?? '',
    };
  } catch {
    return null;
  }
}

export function withExtractedFields<T>(
  base: T,
  extracted: ExtractedFields | null,
  annotation: ProvenanceAnnotation,
): { data: T; annotation: ProvenanceAnnotation } {
  if (extracted) {
    for (const [key, value] of Object.entries(extracted.fields)) {
      if (value !== undefined && value !== null) {
        (base as Record<string, unknown>)[key] = value;
        annotation.fieldOrigins[key] = 'llm_inferred';
      }
    }
  }
  return { data: base, annotation };
}
