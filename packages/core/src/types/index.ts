// ============================================================================
// Novalistically — Core Type Definitions
// Based on PROJECT.md §7.4 — complete type system for the narrative engine
// ============================================================================

// ——— Entity System ———

export type EntityId = string;

export type EntityKind =
  | 'character'
  | 'location'
  | 'item'
  | 'concept'
  | 'faction'
  | 'rule';

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  definitionFile: string;
  state: Record<string, unknown>;
}

// ——— Timestamp System (§7.4.16) ———

export type StoryTimestamp =
  | AbsoluteTimestamp
  | RelativeTimestamp
  | ChapterTimestamp;

export interface AbsoluteTimestamp {
  type: 'absolute';
  value: string;
}

export interface RelativeTimestamp {
  type: 'relative';
  anchor: string;
  offset: {
    amount: number;
    unit: 'minute' | 'hour' | 'day' | 'week' | 'month';
  };
}

export interface ChapterTimestamp {
  type: 'chapter';
  chapter: number;
}

export interface TimeAnchor {
  id: string;
  day: number;
  description?: string;
}

// ——— Fact System (§7.4.7) ———

export type FactId = string;

export interface Fact {
  id: FactId;
  entityId: EntityId;
  attribute: string;
  value: unknown;
  confidence?: number;
  validity: FactValidity;
}

export interface FactValidity {
  temporal: { start: StoryTimestamp; end: StoryTimestamp | null };
  branches: BranchSet;
}

// ——— Branch System (§7.4.7) ———

export interface BranchPath {
  decisions: Array<{
    atEventId: string;
    choiceId: string;
    narrativeOrder: number;
  }>;
}

export type BranchSet =
  | { type: 'all' }
  | { type: 'paths'; paths: BranchPath[] }
  | { type: 'condition'; condition: Condition }
  | { type: 'except'; branches: BranchSet };

export interface BranchPoint {
  branchPointId: string;
  atEventId: string;
  description: string;
  choices: BranchChoice[];
  defaultBranch?: string;
  existenceCondition: BranchSet;
}

export interface BranchChoice {
  choiceId: string;
  label: string;
  condition?: Condition;
  narrativeOrder: number;
}

export interface Condition {
  type: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'and' | 'or';
  field?: string;
  value?: unknown;
  conditions?: Condition[];
}

// ——— Narrative Event (§7.4.1) ———

export interface NarrativeEvent {
  id: string;
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: StoryTimestamp;
  narrationTime?: StoryTimestamp;
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  pov: {
    character: EntityId;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  sceneBrief: string;
  preconditions: Fact[];
  postconditions: Fact[];
  threadProgress: ThreadProgressEntry[];
  foreshadowing: ForeshadowEntry[];
  relationshipEffects: RelationshipChange[];
  ruleEffects: RuleEffectEntry[];
  styleGuidance?: StyleGuidance;
  source: 'genesis' | 'event_file' | 'branch_point' | 'system';
  branchExistence: BranchSet;
  participants: {
    entities: EntityId[];
  };
}

export interface ThreadProgressEntry {
  thread: string;
  advancement: string;
  progressAfter: number;
  progressTotal: number;
}

export interface ForeshadowEntry {
  id: string;
  hint: string;
  targetRevealChapter: number;
  thread?: string;
}

export interface RelationshipChange {
  participants: [EntityId, EntityId];
  effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate';
  direction: string;
  newState?: {
    type: string;
    intensity: number;
  };
}

export interface RuleEffectEntry {
  rule: string;
  effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify';
  evidence: string;
}

export interface StyleGuidance {
  tone?: string;
  characterVoice?: Record<string, string>;
  avoid?: string;
  scenePacing?: string;
  atmosphere?: string;
}

// ——— Knowledge System (§7.4.2) ———

export interface KnowledgeState {
  worldTruth: Fact[];
  characterKnowledge: Record<EntityId, {
    knownFacts: KnowledgeEntry[];
    unknownFacts: FactId[];
    misbeliefs: KnowledgeEntry[];
  }>;
  readerKnowledge: FactId[];
  narratorKnowledge: FactId[];
}

export interface KnowledgeEntry {
  fact: Fact;
  acquiredAt: StoryTimestamp;
  source: KnowledgeSource;
  confidence: number;
}

export type KnowledgeSource =
  | { type: 'direct_experience'; eventId: string }
  | { type: 'told_by'; characterId: EntityId; eventId: string }
  | { type: 'inferred'; basis: FactId[] }
  | { type: 'deceived_by'; characterId: EntityId; actualFact: FactId };

// ——— Relationship System (§7.4.3) ———

export interface Relationship {
  id: string;
  participants: [EntityId, EntityId];
  definition: RelationshipDef;
  state: RelationshipState;
  history: NarrativeEvent[];
}

export interface RelationshipDef {
  type: string;
  description?: string;
}

export interface RelationshipState {
  direction: Record<EntityId, {
    dimensions: Record<string, number | string>;
    perceivedBy: Record<EntityId, number>;
  }>;
}

export interface RelationshipEffect {
  relationshipId: string;
  dimension: string;
  change:
    | { type: 'numeric'; delta: number }
    | { type: 'qualitative'; trigger: string; from: string; to: string };
}

// ——— Rule System (§7.4.4) ———

export interface StateTransitionRule {
  id: string;
  eventType: string;
  condition?: (event: NarrativeEvent, state: WorldState) => boolean;
  effects: TransitionEffect[];
}

export interface TransitionEffect {
  target: 'character' | 'relationship' | 'knowledge' | 'world';
  dimension: string;
  delta?: number;
  qualitative?: {
    semantics: 'irreversible' | 'conditional' | 'gradual' | 'threshold';
    threshold?: number;
    description: string;
  };
}

// ——— Plugin System (§7.4.5) ———

export interface PluginManifest {
  name: string;
  version: string;
  priority: number;
  provides: string[];
  requires: string[];
  conflicts: string[];
  authority: {
    dimensions: string[];
    exclusive: boolean;
  };
  observes: {
    eventTypes: string[];
    stateDomains: string[];
  };
}

export type ArbitrationStrategy =
  | 'priority'
  | 'human_arbitration'
  | 'first_writer_wins'
  | 'merge';

// ——— World State ———

export interface WorldState {
  entities: Record<EntityId, Record<string, unknown>>;
  relationships: Record<string, { direction: Record<string, Record<string, unknown>> }>;
  knowledge: Record<EntityId, { knownFacts: FactId[] }>;
  threads: Record<string, { progress: number; total: number }>;
  rules: Record<string, { activeEvidence: number }>;
  facts: Fact[];
}

// ——— Event Store & Snapshot (§7.4.19) ———

export interface Snapshot {
  narrativeOrder: number;
  eventId: string;
  timestamp: string;
  state: WorldState;
}

// ——— Validator System (§7.4.15) ———

export interface ValidatorContext {
  worldState: WorldState;
  events: NarrativeEvent[];
  entityRegistry: EntityRegistry;
  currentEvent: NarrativeEvent;
  currentChapter: number;
  narrativeOrder: number;
  queryState: (entityId: EntityId, attribute: string) => unknown;
  getKnowledge: (characterId: EntityId) => KnowledgeState;
  getThreadProgress: (threadId: string) => { progress: number; total: number };
  getRuleEvidence: (ruleId: string) => RuleEffectEntry[];
}

export interface ValidationIssue {
  validator: string;
  severity: 'error' | 'warning' | 'info';
  event: string;
  entity: string;
  attribute?: string;
  message: string;
  fixSuggestion: string;
  fixAction: 'add_knowledge' | 'remove_line' | 'change_value' | 'add_precondition' | 'declare_flashback' | 'manual';
  fixTarget: {
    file: string;
    field?: string;
    value?: unknown;
  };
}

export interface Validator {
  name: string;
  category: 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style';
  requiresLLM: boolean;
  validate: (event: NarrativeEvent, context: ValidatorContext) => ValidationIssue[];
}

// ——— Validation Result ———

export interface ValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
}

// ——— Context Compiler (§7.4.6) ———

export interface RelevanceScore {
  entity: EntityId;
  score: number;
  basis: {
    participation: number;
    threadAssociation: number;
    spatioTemporal: number;
    knowledgeIntersection: number;
    relationshipRelevance: number;
    specificityBonus: number;
    recencyPenalty: number;
  };
}

export interface ContextPackage {
  eventId: string;
  systemContext: SystemContext;
  sceneSpec: SceneSpecification;
  characterSnapshots: CharacterSnapshot[];
  relationshipContext: RelationshipContext[];
  worldFacts: WorldFact[];
  knowledgeBoundary: KnowledgeBoundary;
  activeThreads: ThreadStatus[];
  previousSceneSummary: string;
  markdown: string;
}

export interface SystemContext {
  genre: string;
  style: string;
  narrativeRules: string[];
}

export interface SceneSpecification {
  goal: string;
  povType: string;
  povCharacter: string;
  conflict: string;
  expectedOutcome: string;
}

export interface CharacterSnapshot {
  id: EntityId;
  name: string;
  currentState: Record<string, unknown>;
  traits: string[];
  voiceNotes: string;
}

export interface RelationshipContext {
  id: string;
  participants: [EntityId, EntityId];
  currentState: RelationshipState;
  unresolvedTensions: string[];
}

export interface WorldFact {
  id: string;
  description: string;
  value: unknown;
}

export interface KnowledgeBoundary {
  characterId: EntityId;
  knownFacts: string[];
  unknownFacts: string[];
}

export interface ThreadStatus {
  id: string;
  name: string;
  progress: number;
  total: number;
  description: string;
}

// ——— Render System (§7.4.17) ———

export interface RenderRequest {
  event: string;
  mode: 'draft' | 'revise' | 'retry';
  revisionNotes?: string;
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface FinalPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface ScribeOutput {
  prose: string;
  newFacts: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence: number;
  }>;
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
  }>;
  foreshadowingPlanted?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
  }>;
}

// ——— Review System (§7.E) ———

export interface ReviewComment {
  id: string;
  author: 'human' | 'llm';
  target: {
    type: 'scene' | 'chapter' | 'character' | 'worldrule' | 'line';
    id: string;
    lineRange?: [number, number];
  };
  severity: 'nit' | 'suggestion' | 'blocking';
  category: 'style' | 'pacing' | 'character_voice' | 'plot_logic' | 'world_consistency' | 'reader_experience';
  content: string;
  status: 'open' | 'addressed' | 'resolved' | 'wontfix';
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ReviewPatch {
  sourceReviewIds: string[];
  changes: PatchChange[];
}

export interface PatchChange {
  type: 'rewrite' | 'insert' | 'delete' | 'attribute_change';
  target: string;
  oldValue?: unknown;
  newValue: unknown;
  rationale: string;
}

// ——— ISS System ———

export interface ISSSnapshot {
  overall: number;
  target: number;
  dimensions: ISSDimension[];
}

export interface ISSDimension {
  name: string;
  score: number;
  max: number;
  threshold: number;
  status: 'green' | 'yellow' | 'red';
  gaps: ISSGap[];
}

export interface ISSGap {
  entity?: string;
  id?: string;
  file?: string;
  suggestion: string;
  fixAction: 'create_file' | 'edit_file' | 'add_field' | 'change_value';
  fixTarget: string;
  template?: string;
}

// ——— Status Report (MCP) ———

export interface StatusReport {
  project: string;
  timestamp: string;
  iss: ISSSnapshot;
  validation: {
    lastRun: string;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  threads: ThreadSnapshot[];
  render: {
    ready: string[];
    blocked: string[];
    waiting: string[];
    completed: string[];
  };
  blockers: Blocker[];
  nextActions: NextAction[];
  guidance: string;
}

export interface ThreadSnapshot {
  id: string;
  name: string;
  progress: string;
  lastAdvancedIn: string;
  targetChapter: number;
  currentChapter: number;
  onTrack: boolean;
  risk: 'on_track' | 'behind' | 'critical' | 'stalled';
}

export interface Blocker {
  event: string;
  reason: string;
  missingPreconditions: Array<{
    entity: string;
    attribute: string;
    expectedValue: unknown;
    currentValue: unknown | null;
    providedBy?: string;
  }>;
}

export interface NextAction {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'iss' | 'validation' | 'thread' | 'rendering';
  action: string;
  targetFile?: string;
  template?: string;
  fixAction?: string;
}

// ——— Entity Registry (§7.4.14) ———

export interface EntityRegistry {
  load: (projectPath: string) => void;
  resolve: (id: EntityId) => Entity | null;
  findByKind: (kind: EntityKind) => Entity[];
  findByAttribute: (attribute: string, value: unknown) => Entity[];
  resolveRefs: (refs: EntityId[]) => Map<EntityId, Entity | null>;
  register: (entity: Entity) => void;
  updateState: (id: EntityId, state: Record<string, unknown>) => void;
  getAll: () => Entity[];
}

// ——— Event File (YAML on disk) ———

export interface EventFile {
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: string;
  sceneType?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  pov: {
    character: string;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  sceneBrief: string;
  preconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
  }>;
  expectedPostconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence?: number;
  }>;
  styleGuidance?: StyleGuidance;
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
    progressTotal: number;
  }>;
  foreshadowing?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
    thread?: string;
  }>;
  relationshipEffects?: Array<{
    participants: [string, string];
    effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate';
    direction: string;
    newState?: {
      type: string;
      intensity: number;
    };
  }>;
  ruleEffects?: Array<{
    rule: string;
    effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify';
    evidence: string;
  }>;
  introduces?: Array<{
    type: 'character' | 'location' | 'item' | 'concept';
    id: string;
    initialState: Record<string, unknown>;
  }>;
}

// ——— Character Definition (YAML) ———

export interface CharacterDefinition {
  id: string;
  name: string;
  type: string;
  archetype?: string;
  faction?: string;
  role?: 'minor' | 'supporting' | 'antagonist' | 'background';
  description: string;
  initialState: Record<string, unknown>;
  traits: string[];
  voiceNotes?: string;
  backstory?: string;
  knownSecrets?: string[];
}

// ——— Rule Definition (YAML) ———

export interface RuleDefinition {
  ruleId: string;
  name: string;
  category: string;
  type: string;
  statement: string;
  logicalConsequences: LogicalConsequence[];
  exceptions?: Array<{ condition: string; note: string }>;
  evidenceChain: RuleEffectEntry[];
}

export interface LogicalConsequence {
  description: string;
  check: {
    type: 'state_invariant' | 'transition_constraint' | 'progression';
    filter: string;
    assert: string;
    unlessEvent?: string;
    direction?: string;
    tolerance?: number;
    severity: 'error' | 'warning';
  };
}

// ——— Location Definition ———

export interface LocationDefinition {
  id: string;
  name: string;
  kind: string;
  parent?: string;
  description: string;
  initialState: Record<string, unknown>;
  notableFeatures?: string[];
}

// ——— Item Definition ———

export interface ItemDefinition {
  id: string;
  name: string;
  kind: string;
  description: string;
  initialState: Record<string, unknown>;
}

// ——— Faction Definition ———

export interface FactionDefinition {
  id: string;
  name: string;
  kind: string;
  description: string;
  initialState: Record<string, unknown>;
}

// ——— Relationship Definition ———

export interface RelationshipDefinition {
  participants: [string, string];
  type: string;
  description: string;
  initialState: {
    [key: string]: Record<string, unknown>;
  };
  establishedEvent: string;
}

// ——— World Initial State ———

export interface WorldInitialState {
  info: {
    currentEra: string;
    politicalSituation: string;
  };
  timeAnchors?: Array<{ id: string; day: number; description?: string }>;
  threads: Array<{
    id: string;
    name: string;
    description: string;
    type: string;
    targetRevealChapter: number;
    initialProgress: string;
  }>;
  worldFacts: Array<{
    id: string;
    value: unknown;
    description: string;
  }>;
}

// ——— Chapter Metadata ———

export interface ChapterMetadata {
  chapter: number;
  title: string;
  summary: string;
  intent: string;
  plannedScenes: number;
  styleGuidance?: StyleGuidance;
}

// ——— Project Config ———

export interface ProjectConfig {
  project: string;
  title: string;
  author: string;
  defaultModel?: string;
  defaultLanguage?: string;
  validatorOverrides?: Record<string, 'off' | 'warning' | 'error'>;
  circuitBreaker?: {
    maxRetries: number;
  };
  reviewExpiry?: {
    blockingChaptersBeforeDowngrade: number;
  };
  snapshotInterval?: number;
}

// ——— Scene Metadata ———

export interface SceneMetadata {
  event: string;
  proseSource: 'llm' | 'human_edited' | 'human_locked';
  modelUsed?: string;
  renderedAt?: string;
  wordCount?: number;
  editHistory: Array<{
    timestamp: string;
    notes: string;
  }>;
  quality?: {
    proseQuality?: number;
    voiceAdherence?: number;
    pacingScore?: number;
    continuityScore?: number;
  };
}

// ——— Branch Points File ———

export interface BranchPointsFile {
  branchPoints: Array<{
    id: string;
    atEvent: string;
    description: string;
    choices: Array<{
      path: string;
      label: string;
      branchId: string;
      description: string;
    }>;
  }>;
}
