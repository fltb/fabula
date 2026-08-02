// ============================================================================
// Built-in validator factory — the single canonical builtin set
// ============================================================================

import type { Validator } from '../types/index.js';
import { AliasValidator } from './alias.js';
import { AnachronyConsistencyValidator } from './anachrony-consistency.js';
import { AppearanceValidator } from './appearance.js';
import { BranchMergeValidator } from './branch-merge.js';
import { CausalityValidator } from './causality.js';
import { CharacterStateValidator } from './character-state.js';
import { ChecklistValidator } from './checklist.js';
import { ConflictValidator } from './conflict.js';
import { DiscourseValidator } from './discourse.js';
import { DiscourseBalanceValidator } from './discourse-balance.js';
import { DurationConsistencyValidator } from './duration-consistency.js';
import { FactualDetailValidator } from './factual-detail.js';
import { FocalizationConsistencyValidator } from './focalization-consistency.js';
import { ForeshadowingValidator } from './foreshadowing.js';
import { FrequencyConsistencyValidator } from './frequency-consistency.js';
import { KnowledgeValidator } from './knowledge.js';
import { NarrativeTechniqueValidator } from './narrative-technique.js';
import { PacingValidator } from './pacing.js';
import { POVValidator } from './pov.js';
import { PronounValidator } from './pronoun.js';
import { QualityValidator } from './quality.js';
import { ReachabilityValidator } from './reachability.js';
import { TenseConsistencyValidator } from './tense-consistency.js';
import { ThreadProgressValidator } from './thread-progress.js';
import { TimelineValidator } from './timeline.js';
import { VoiceConsistencyValidator } from './voice-consistency.js';
import { VoiceDriftDetector } from './voice-drift.js';
import { WorldRuleValidator } from './world-rule.js';

/**
 * Create the canonical built-in validator set.
 * Returns a fresh array of new instances — callers may merge, filter, or
 * extend it without affecting other consumers.
 */
export function createBuiltInValidators(): Validator[] {
  return [
    new TimelineValidator(),
    new CharacterStateValidator(),
    new KnowledgeValidator(),
    new WorldRuleValidator(),
    new CausalityValidator(),
    new ForeshadowingValidator(),
    new POVValidator(),
    new FactualDetailValidator(),
    new VoiceDriftDetector(),
    new BranchMergeValidator(),
    new ReachabilityValidator(),
    new PacingValidator(),
    new TenseConsistencyValidator(),
    new DiscourseBalanceValidator(),
    new AliasValidator(),
    new PronounValidator(),
    new AppearanceValidator(),
    new ConflictValidator(),
    new QualityValidator(),
    new ThreadProgressValidator(),
    new DurationConsistencyValidator(),
    new FrequencyConsistencyValidator(),
    new VoiceConsistencyValidator(),
    new AnachronyConsistencyValidator(),
    new FocalizationConsistencyValidator(),
    new DiscourseValidator(),
    new ChecklistValidator(),
    new NarrativeTechniqueValidator(),
  ];
}
