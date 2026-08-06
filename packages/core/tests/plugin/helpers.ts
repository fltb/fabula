// ============================================================================
// Test Helpers — plugin integration tests (plan 7.4/7.5)
// ============================================================================

import * as crypto from 'node:crypto';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import { Logger, MemoryLogTransport } from '../../src/observability/logger.js';
import type { PluginContext, PluginHooks, ProviderRegistry } from '../../src/plugin/index.js';
import { PluginHooksManager, ValidatorRegistry } from '../../src/plugin/index.js';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

export const PROJECT_ID = 'plugin-test';

export const hash = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/** Minimal host-neutral PluginContext for plugin hooks. */
export function makePluginContext(): PluginContext {
  return { log: new Logger(new MemoryLogTransport()) };
}

/** A provider registry that accepts registrations silently. */
export const dummyProviderRegistry: ProviderRegistry = {
  register: () => undefined,
  getProvider: () => undefined,
};

/** Build a PluginHooksManager with one registered hooks object. */
export function makeManager(hooks: PluginHooks): PluginHooksManager {
  const manager = new PluginHooksManager(
    makePluginContext(),
    new ValidatorRegistry(),
    dummyProviderRegistry,
  );
  manager.register(hooks);
  return manager;
}

/**
 * Build a PluginHooksManager with one registered hooks object and run
 * initialize() so onLoad/registerValidators/registerProvider take effect
 * (mirrors host activateNodePlugins).
 */
export async function makeInitializedManager(hooks: PluginHooks): Promise<PluginHooksManager> {
  const manager = makeManager(hooks);
  await manager.initialize();
  return manager;
}

/** A minimal deterministic hooks object with identity stamped. */
export function identityHooks(
  options: {
    readonly name?: string;
    readonly version?: string;
    readonly manifestHash?: string;
    readonly moduleHash?: string;
  } = {},
): PluginHooks {
  return {
    name: options.name ?? 'identity-plugin',
    version: options.version ?? '1.0.0',
    manifestHash: options.manifestHash ?? hash('manifest-v1'),
    moduleHash: options.moduleHash ?? hash('module-v1'),
  };
}

/** Single-event canonical project snapshot (mirrors editorial render tests). */
export function source(): ProjectSourceSnapshotV1 {
  const entries: Record<string, string> = {
    'nova.yaml': `project: ${PROJECT_ID}\ntitle: Test Novel\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en\n`,
    'definitions/state_initial.yaml':
      'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: The narrator\ninitialState: {}\ntraits: []\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/discourse-ledger.yaml':
      'id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1]\nentries: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Chapter 1\nsummary: First chapter\nintent: Introduction\nplannedScenes: 1\n',
    'chapters/chapter_01/E1.yaml':
      'event: E1\nnarrativeOrder: 1\ntitle: First Event\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: A test scene.\nbeats:\n  - A test scene.\npreconditions: []\nexpectedPostconditions: []\n',
  };
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: hash(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: hash(
      documents.map((document) => `${document.logicalPath}\0${document.content}`).join(''),
    ),
  };
}

/** MockPass2 entry carrying a full, valid analysis payload for E1. */
export function analysisEntry(prose: string): MockPass2Entry {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 4,
      maxScore: 5,
      strengths: ['clear prose'],
      weaknesses: [],
      estimatedWordCount: 80,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    ruleChecks: [],
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    knowledgeChecks: [],
    checklistResults: [],
  };
  return makeCustomEntry('E1', prose, {
    eventId: 'E1',
    protocol: makeProtocol(prose),
    observations: makeObservations(payload, prose),
    analysis: payload,
  });
}
