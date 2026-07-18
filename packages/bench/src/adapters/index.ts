// ============================================================================
// Novalistically Bench — External Dataset Adapters (barrel)
// ============================================================================

export {
  annotate,
  markDirect,
  markMixed,
} from './annotations.js';
export type {
  ProvenanceSource,
  FieldOrigin,
  ProvenanceAnnotation,
} from './annotations.js';

export {
  buildExtractionPrompt,
  parseExtractionResponse,
  withExtractedFields,
} from './llm-extractor.js';
export type {
  ExtractionRequest,
  ExtractedFields,
} from './llm-extractor.js';

export {
  convertChiNovelKE,
  convertChiNovelKECharacter,
  convertChiNovelKELocation,
  convertChiNovelKERelation,
} from './chinovelke.js';
export type {
  ChiNovelKERelationOutput,
  ChiNovelKEConversionResult,
} from './chinovelke.js';

export {
  convertAgentSFT,
  convertAgentSFTEvent,
  convertAgentSFTChapter,
} from './novel-agent-sft.js';
export type {
  AgentSFTConversionResult,
} from './novel-agent-sft.js';

export {
  convertIN3KNovel,
  convertIN3KChapterToEvents,
} from './interactive-novels-3k.js';
export type {
  IN3KConversionResult,
} from './interactive-novels-3k.js';
