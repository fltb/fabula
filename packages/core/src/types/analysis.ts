// ============================================================================
// Analysis Result Type — Structure for LLM Pass 2 JSON output
// ============================================================================
//
// The render pipeline's second LLM pass produces structured analysis JSON.
// This type mirrors the schema requested in the Pass 2 prompt
// (ai/prompts/render-analysis.ts).
//
// Validators receive this as an OPTIONAL parameter in validateRender().
// Over time, validators should migrate from prose-regex checks to
// structured analysis checks.

export interface PostconditionAnalysis {
  covered: string[];
  dropped: string[];
}

export interface ViolatedPrecondition {
  entityId: string;
  attribute: string;
  expectedValue: string;
  issue: string;
}

export interface PreconditionAnalysis {
  violated: ViolatedPrecondition[];
}

export interface POVAnalysis {
  consistent: boolean;
  leaks: string[];
}

export interface InventedDetail {
  detail: string;
  severity: 'minor' | 'major';
}

export interface QualityAnalysis {
  proseScore: number;
  maxScore: number;
  strengths: string[];
  weaknesses: string[];
  estimatedWordCount: number;
}

export interface AnalysisContent {
  postconditions: PostconditionAnalysis;
  preconditions: PreconditionAnalysis;
  pov: POVAnalysis;
  inventedDetails: InventedDetail[];
  quality: QualityAnalysis;
  threadProgressAchieved: string[];
  foreshadowingDeployed: string[];
}

export interface AnalysisResult {
  eventId: string;
  analysis: AnalysisContent;
}
