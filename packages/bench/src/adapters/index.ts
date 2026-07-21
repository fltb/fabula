// ============================================================================
// Novalistically Bench — External Dataset Adapters (barrel)
// ============================================================================

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
