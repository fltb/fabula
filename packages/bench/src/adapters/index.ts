// ============================================================================
// Novalistically Bench — External Dataset Adapters (barrel)
// ============================================================================

export type {
  ChiNovelKEConversionResult,
  ChiNovelKERelationOutput,
} from './chinovelke.js';
export {
  convertChiNovelKE,
  convertChiNovelKECharacter,
  convertChiNovelKELocation,
  convertChiNovelKERelation,
} from './chinovelke.js';
export type { IN3KConversionResult } from './interactive-novels-3k.js';
export {
  convertIN3KChapterToEvents,
  convertIN3KNovel,
} from './interactive-novels-3k.js';
export type { AgentSFTConversionResult } from './novel-agent-sft.js';
export {
  convertAgentSFT,
  convertAgentSFTChapter,
  convertAgentSFTEvent,
} from './novel-agent-sft.js';
