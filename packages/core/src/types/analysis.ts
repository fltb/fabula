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

// ── Block level types ─────────────────────────────────────────────────────────

export type MatchLevel = 'exact' | 'similar' | 'absent' | 'contradicted';

export interface NarrativeCheck {
  entityId: string;
  attribute: string;
  hint: string;
  evidence: string;
  matchLevel: MatchLevel;
}

export interface AppearanceCheck {
  entityId: string;
  feature: string;
  declared: string;
  evidence: string;
  matchLevel: MatchLevel;
}

export interface CharacterReference {
  entityId: string;
  namesUsed: string[];
}

export type TenseDetected = 'past' | 'present' | 'mixed';

export interface ConflictAnalysis {
  primaryType: string;
  resolutionAchieved: boolean;
}

export interface RuleCheck {
  ruleId: string;
  violated: boolean;
  evidence: string;
  severity: 'minor' | 'major';
}

export interface KnowledgeCheck {
  entityId: string;
  leakedEntity: string;
  leakedInfo: string;
  evidence: string;
  matchLevel: MatchLevel;
}

// ── Existing block types ──────────────────────────────────────────────────────

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
  // ── New 5 blocks (P0g) ────────────────────────────────────────────
  narrativeChecks?: NarrativeCheck[];
  appearanceChecks?: AppearanceCheck[];
  characterReferences?: CharacterReference[];
  tenseDetected?: TenseDetected;
  conflictAnalysis?: ConflictAnalysis;
  ruleChecks?: RuleCheck[];
  knowledgeChecks?: KnowledgeCheck[];
}

export interface AnalysisResult {
  eventId: string;
  analysis: AnalysisContent;
}
