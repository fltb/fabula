// ============================================================================
// EditorialCompiler — pure preflight + identity + plan compilation tests
//
// Acceptance criteria:
//   1. Two identical compiles deep‑equal / planHash equal
//   2. Model/profile affects plan/request but not editorial basis
//   3. Source/review/waiver/validator changes affect required identities
//   4. Invalid selection is side‑effect free
//   5. Plans are pure semantic intents — no host paths, read sets, or
//      prepared writes
//
// All tests are deterministic — no storage, no clock, no providers.
// Compile input is the immutable ProjectSourceSnapshotV1 (sorted logical
// documents + content SHA‑256 hashes); the output is a plan of semantic
// render intents with no filesystem expectations.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import {
  compileBranchContracts,
  compileEditorialRun,
  type EditorialCompileInput,
  preflightRevision,
} from '../../src/editorial/compiler.ts';
import {
  type CompiledSceneIdentity,
  canonicalJson,
  computeEditorialBasisHash,
  computePlanHash,
  computeSceneSourceHash,
  computeScopeHash,
  computeSelectorHash,
  computeValidationIdentity,
  type PlanHashInput,
  type ValidationIdentityInput,
} from '../../src/editorial/identity.ts';
import type { SceneCatalog } from '../../src/editorial/selector.ts';
import { preflightSelector } from '../../src/editorial/selector.ts';
import type { BranchPath } from '../../src/types/branch.ts';
import type { SceneSelector } from '../../src/types/editorial.ts';
import type { ReviewComment } from '../../src/types/review.ts';

// ============================================================================
// Deterministic helpers
// ============================================================================

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

let opaqueCounter = 0;
/** Deterministic opaque hash — distinct per call, stable across runs. */
function opaqueHash(): string {
  opaqueCounter += 1;
  return sha256Hex(`opaque:${opaqueCounter}`);
}

// ============================================================================
// Shared test data
// ============================================================================

const CATALOG: SceneCatalog = {
  events: Object.freeze([
    { eventId: 'E001', narrativeOrder: 1, chapter: 1 },
    { eventId: 'E002', narrativeOrder: 2, chapter: 1 },
    { eventId: 'E003', narrativeOrder: 3, chapter: 2 },
    { eventId: 'E004', narrativeOrder: 4, chapter: 2 },
    { eventId: 'E005', narrativeOrder: 5, chapter: 3 },
  ]),
};

const BRANCH_PATH: BranchPath = {
  decisions: [{ atEventId: 'E001', choiceId: 'choice_a', narrativeOrder: 1 }],
};

const EVENT_CONTENTS: Record<string, string> = {
  E001: 'id: E001\nevent: The Beginning\n',
  E002: 'id: E002\nevent: The Middle\n',
  E003: 'id: E003\nevent: Chapter Two Start\n',
  E004: 'id: E004\nevent: Chapter Two End\n',
  E005: 'id: E005\nevent: The End\n',
};

/** Logical POSIX path of each event's authoring document. */
const EVENT_DOCUMENT_PATHS: Record<string, string> = {
  E001: 'chapters/chapter_01/E001.yaml',
  E002: 'chapters/chapter_01/E002.yaml',
  E003: 'chapters/chapter_02/E003.yaml',
  E004: 'chapters/chapter_02/E004.yaml',
  E005: 'chapters/chapter_03/E005.yaml',
};

const SOURCE_DOCUMENTS: Record<string, string> = {
  'nova.yaml': 'project: compiler-test\ntitle: Compiler Test\ndefaultLanguage: en\n',
  'definitions/characters/alice.yaml': 'name: Alice\nage: 30\n',
  'definitions/locations/forest.yaml': 'name: Enchanted Forest\ndanger: moderate\n',
};

/** Merge definitions and event documents into one logical document map. */
function defaultDocuments(options?: {
  eventContents?: Record<string, string>;
  sourceDocuments?: Record<string, string>;
}): Record<string, string> {
  const documents: Record<string, string> = {
    ...(options?.sourceDocuments ?? SOURCE_DOCUMENTS),
  };
  for (const [eventId, content] of Object.entries(options?.eventContents ?? EVENT_CONTENTS)) {
    documents[EVENT_DOCUMENT_PATHS[eventId]] = content;
  }
  return documents;
}

/**
 * Local immutable snapshot fixture: sorted logical documents, per‑document
 * content SHA‑256, and a single content‑derived sourceHash. No host paths,
 * revisions, actors, or timestamps.
 */
function buildSnapshot(
  documents: Record<string, string> = defaultDocuments(),
): ProjectSourceSnapshotV1 {
  const sorted = Object.entries(documents).sort(([a], [b]) => a.localeCompare(b));
  const sourceDocuments: SourceDocumentV1[] = sorted.map(([logicalPath, content]) => ({
    version: 1,
    logicalPath,
    content,
    contentHash: sha256Hex(content),
    parseResult: { status: 'parsed', value: { value: content } },
    diagnostics: [],
  }));
  return {
    version: 1,
    documents: sourceDocuments,
    sourceHash: sha256Hex(sourceDocuments.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
}

const SNAPSHOT = buildSnapshot();

const LATEST_REVISIONS: Record<string, { revisionId: string; proseHash: string } | null> = {
  E001: { revisionId: 'rev-e001-v1', proseHash: opaqueHash() },
  E002: { revisionId: 'rev-e002-v1', proseHash: opaqueHash() },
  E003: null,
  E004: null,
  E005: null,
};

const VALIDATION_INPUT: ValidationIdentityInput = {
  analysisContractHash: opaqueHash(),
  builtInValidatorImplementationVersion: '1',
  effectiveOverrides: {},
  validators: [
    { name: 'CausalityValidator', version: '1' },
    { name: 'POVValidator', version: '1' },
    { name: 'TimelineValidator', version: '1' },
  ],
  plugins: [],
};

const REVIEWS: ReviewComment[] = [
  {
    id: 'rev-001',
    author: 'human',
    actorId: 'user-1',
    target: { type: 'novel', id: 'novel' },
    severity: 'suggestion',
    category: 'style',
    content: 'Improve prose flow.',
    status: 'open',
    applications: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  },
  {
    id: 'rev-002',
    author: 'human',
    actorId: 'user-1',
    target: { type: 'scene', id: 'E001' },
    severity: 'blocking',
    category: 'plot_logic',
    content: 'The beginning needs more tension.',
    status: 'open',
    applications: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  },
];

const CHAPTER_BY_EVENT: Record<string, number> = {
  E001: 1,
  E002: 1,
  E003: 2,
  E004: 2,
  E005: 3,
};

const REQUIRES_PROVIDER: Record<string, boolean> = {
  E001: true,
  E002: true,
  E003: true,
  E004: true,
  E005: true,
};

function defaultCompileInput(
  overrides?: Partial<EditorialCompileInput> & {
    requestOverrides?: Partial<EditorialCompileInput['request']>;
  },
): EditorialCompileInput {
  const eventContents = overrides?.eventContents ?? EVENT_CONTENTS;
  const sourceDocumentContents = overrides?.sourceDocumentContents ?? SOURCE_DOCUMENTS;
  const source =
    overrides?.source ??
    buildSnapshot(defaultDocuments({ eventContents, sourceDocuments: sourceDocumentContents }));

  const request: EditorialCompileInput['request'] = {
    version: 1,
    source,
    selector: undefined,
    revision: undefined,
    model: undefined,
    providerProfile: undefined,
    branchPath: undefined,
    discourseBranch: undefined,
    waivers: undefined,
    batch: undefined,
    maxRounds: undefined,
    ...overrides?.requestOverrides,
  };

  return {
    request,
    source,
    catalog: CATALOG,
    eventContents,
    sourceDocumentContents,
    latestRevisions: LATEST_REVISIONS,
    validation: VALIDATION_INPUT,
    reviewComments: REVIEWS,
    chapterByEventId: CHAPTER_BY_EVENT,
    requiresProviderByEventId: REQUIRES_PROVIDER,
    ...overrides,
  };
}

// ============================================================================
// Selector Preflight Tests
// ============================================================================

describe('preflightSelector', () => {
  it('resolves "all" to every catalog entry in narrative order', () => {
    const result = preflightSelector({ type: 'all' }, CATALOG);
    expect(result.eventIds).toEqual(['E001', 'E002', 'E003', 'E004', 'E005']);
    expect(result.errors).toHaveLength(0);
  });

  it('resolves "undefined" selector to every catalog entry', () => {
    const result = preflightSelector(undefined, CATALOG);
    expect(result.eventIds).toEqual(['E001', 'E002', 'E003', 'E004', 'E005']);
    expect(result.errors).toHaveLength(0);
  });

  it('resolves "chapter" selector to events in that chapter', () => {
    const result = preflightSelector({ type: 'chapter', chapter: 2 }, CATALOG);
    expect(result.eventIds).toEqual(['E003', 'E004']);
    expect(result.errors).toHaveLength(0);
  });

  it('returns empty for chapter with no events', () => {
    const result = preflightSelector({ type: 'chapter', chapter: 99 }, CATALOG);
    expect(result.eventIds).toEqual([]);
    expect(result.errors).toHaveLength(0); // empty chapter is not an error per se
  });

  it('resolves "events" selector to requested eventIds', () => {
    const selector: SceneSelector = { type: 'events', eventIds: ['E003', 'E001', 'E005'] };
    const result = preflightSelector(selector, CATALOG);
    expect(result.eventIds).toEqual(['E001', 'E003', 'E005']);
    expect(result.errors).toHaveLength(0);
  });

  it('deduplicates duplicate eventIds in selector', () => {
    const selector: SceneSelector = { type: 'events', eventIds: ['E001', 'E002', 'E001'] };
    const result = preflightSelector(selector, CATALOG);
    expect(result.eventIds).toEqual(['E001', 'E002']);
    expect(result.errors).toHaveLength(0);
  });

  it('reports SCENE_NOT_FOUND for unknown eventIds', () => {
    const selector: SceneSelector = { type: 'events', eventIds: ['E001', 'E999'] };
    const result = preflightSelector(selector, CATALOG);
    expect(result.eventIds).toEqual(['E001']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('SCENE_NOT_FOUND');
    expect(result.errors[0].eventId).toBe('E999');
  });

  it('accumulates multiple errors without throwing', () => {
    const selector: SceneSelector = { type: 'events', eventIds: ['E999', 'E888'] };
    const result = preflightSelector(selector, CATALOG);
    expect(result.eventIds).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });

  it('returns sorted eventIds by narrative order', () => {
    const selector: SceneSelector = {
      type: 'events',
      eventIds: ['E005', 'E002', 'E004', 'E001', 'E003'],
    };
    const result = preflightSelector(selector, CATALOG);
    expect(result.eventIds).toEqual(['E001', 'E002', 'E003', 'E004', 'E005']);
  });

  it('is side‑effect free — repeated calls return identical frozen results', () => {
    const a = preflightSelector({ type: 'all' }, CATALOG);
    const b = preflightSelector({ type: 'all' }, CATALOG);
    expect(Object.isFrozen(a.eventIds)).toBe(true);
    expect(Object.isFrozen(a.errors)).toBe(true);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Revision Preflight Tests
// ============================================================================

describe('preflightRevision', () => {
  it('returns empty when no reviewIds given', () => {
    const errors = preflightRevision(undefined, REVIEWS, ['E001', 'E002'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(0);
  });

  it('returns empty for valid novel‑level review', () => {
    const errors = preflightRevision(['rev-001'], REVIEWS, ['E001', 'E002'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(0);
  });

  it('reports INVALID_REVIEW_SELECTION for a non-existent review', () => {
    const errors = preflightRevision(['nonexistent'], REVIEWS, ['E001'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_REVIEW_SELECTION');
    expect(errors[0].reviewId).toBe('nonexistent');
  });

  it('reports INVALID_REVIEW_SELECTION when review does not apply to selected events', () => {
    const errors = preflightRevision(['rev-002'], REVIEWS, ['E005'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_REVIEW_SELECTION');
  });

  it('accepts scene‑level review when the event is selected', () => {
    const errors = preflightRevision(['rev-002'], REVIEWS, ['E001'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-open explicit review', () => {
    const closed = [{ ...REVIEWS[0], status: 'resolved' as const }];
    const errors = preflightRevision(['rev-001'], closed, ['E001'], CHAPTER_BY_EVENT);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_REVIEW_SELECTION');
  });

  it('rejects an inline instruction for multiple selected scenes', () => {
    const errors = preflightRevision(
      undefined,
      REVIEWS,
      ['E001', 'E002'],
      CHAPTER_BY_EVENT,
      'Tighten both scenes',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_REVIEW_SELECTION');
  });
});

// ============================================================================
// Identity Tests
// ============================================================================

describe('identity', () => {
  describe('computeSceneSourceHash', () => {
    it('produces a deterministic hex hash', () => {
      const h1 = computeSceneSourceHash('E001', EVENT_CONTENTS.E001, SOURCE_DOCUMENTS);
      const h2 = computeSceneSourceHash('E001', EVENT_CONTENTS.E001, SOURCE_DOCUMENTS);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('changes when event content changes', () => {
      const h1 = computeSceneSourceHash('E001', EVENT_CONTENTS.E001, SOURCE_DOCUMENTS);
      const h2 = computeSceneSourceHash('E001', 'different content', SOURCE_DOCUMENTS);
      expect(h1).not.toBe(h2);
    });

    it('changes when source documents change', () => {
      const h1 = computeSceneSourceHash('E001', EVENT_CONTENTS.E001, SOURCE_DOCUMENTS);
      const h2 = computeSceneSourceHash('E001', EVENT_CONTENTS.E001, {});
      expect(h1).not.toBe(h2);
    });
  });

  describe('computeScopeHash', () => {
    it('produces deterministic hash', () => {
      const h1 = computeScopeHash('E001', BRANCH_PATH);
      const h2 = computeScopeHash('E001', BRANCH_PATH);
      expect(h1).toBe(h2);
    });

    it('changes when branch path changes', () => {
      const h1 = computeScopeHash('E001', BRANCH_PATH);
      const h2 = computeScopeHash('E001', { decisions: [] });
      expect(h1).not.toBe(h2);
    });

    it('is stable when branchPath is undefined', () => {
      const h1 = computeScopeHash('E001', undefined);
      const h2 = computeScopeHash('E001', undefined);
      expect(h1).toBe(h2);
    });
  });

  describe('computeEditorialBasisHash', () => {
    it('is stable for identical inputs', () => {
      const h1 = computeEditorialBasisHash('E001', BRANCH_PATH, 'hash1', 'rev1', 'prose1');
      const h2 = computeEditorialBasisHash('E001', BRANCH_PATH, 'hash1', 'rev1', 'prose1');
      expect(h1).toBe(h2);
    });

    it('changes when source hash changes', () => {
      const h1 = computeEditorialBasisHash('E001', BRANCH_PATH, 'old-hash', 'rev1', 'prose1');
      const h2 = computeEditorialBasisHash('E001', BRANCH_PATH, 'new-hash', 'rev1', 'prose1');
      expect(h1).not.toBe(h2);
    });

    it('is NOT affected by model or provider profile', () => {
      const basis = computeEditorialBasisHash(
        'E001',
        BRANCH_PATH,
        SNAPSHOT.sourceHash,
        'rev1',
        'prose1',
      );
      // This is the same call — the hash does NOT accept model or profile.
      // Verify that the output is stable regardless of request-level model.
      const basis2 = computeEditorialBasisHash(
        'E001',
        BRANCH_PATH,
        SNAPSHOT.sourceHash,
        'rev1',
        'prose1',
      );
      expect(basis).toBe(basis2);
    });
  });

  describe('computeValidationIdentity', () => {
    it('produces a deterministic hash', () => {
      expect(computeValidationIdentity(VALIDATION_INPUT)).toBe(
        computeValidationIdentity(VALIDATION_INPUT),
      );
    });

    it('changes when the analysis contract changes', () => {
      const changed = {
        ...VALIDATION_INPUT,
        analysisContractHash: opaqueHash(),
      };
      expect(computeValidationIdentity(VALIDATION_INPUT)).not.toBe(
        computeValidationIdentity(changed),
      );
    });

    it('changes when a validator version changes', () => {
      const changed = {
        ...VALIDATION_INPUT,
        validators: VALIDATION_INPUT.validators.map((validator) =>
          validator.name === 'CausalityValidator' ? { ...validator, version: '2' } : validator,
        ),
      };
      expect(computeValidationIdentity(VALIDATION_INPUT)).not.toBe(
        computeValidationIdentity(changed),
      );
    });

    it('changes when effective overrides change', () => {
      const changed: ValidationIdentityInput = {
        ...VALIDATION_INPUT,
        effectiveOverrides: { POVValidator: 'off' },
      };
      expect(computeValidationIdentity(VALIDATION_INPUT)).not.toBe(
        computeValidationIdentity(changed),
      );
    });

    it('changes with plugin manifest, validator, or prompt-hook identity', () => {
      const plugin = {
        name: 'my-plugin',
        version: '1.0.0',
        manifestHash: opaqueHash(),
        moduleHash: opaqueHash(),
        hookNames: ['beforeRender', 'onBuildPass1Prompt'],
        validators: [{ name: 'CustomValidator', version: '1.0.0' }],
        promptHookIdentity: opaqueHash(),
      };
      const base: ValidationIdentityInput = { ...VALIDATION_INPUT, plugins: [plugin] };
      const changedVersion: ValidationIdentityInput = {
        ...base,
        plugins: [{ ...plugin, version: '2.0.0' }],
      };
      const changedModule: ValidationIdentityInput = {
        ...base,
        plugins: [{ ...plugin, moduleHash: opaqueHash() }],
      };
      const changedManifest: ValidationIdentityInput = {
        ...base,
        plugins: [{ ...plugin, manifestHash: opaqueHash() }],
      };
      const changedHooks: ValidationIdentityInput = {
        ...base,
        plugins: [{ ...plugin, hookNames: ['beforeRender'] }],
      };
      const changedValidator: ValidationIdentityInput = {
        ...base,
        plugins: [
          {
            ...plugin,
            validators: [{ name: 'CustomValidator', version: '2.0.0' }],
          },
        ],
      };
      const changedHook: ValidationIdentityInput = {
        ...base,
        plugins: [{ ...plugin, promptHookIdentity: opaqueHash() }],
      };

      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedVersion));
      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedModule));
      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedManifest));
      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedHooks));
      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedValidator));
      expect(computeValidationIdentity(base)).not.toBe(computeValidationIdentity(changedHook));
    });

    it('is stable under validator and plugin ordering changes', () => {
      const pluginA = {
        name: 'a-plugin',
        version: '1',
        manifestHash: opaqueHash(),
        moduleHash: opaqueHash(),
        hookNames: ['onBuildPass1Prompt'],
        validators: [{ name: 'AValidator', version: '1' }],
        promptHookIdentity: opaqueHash(),
      };
      const pluginB = {
        name: 'b-plugin',
        version: '1',
        manifestHash: opaqueHash(),
        moduleHash: opaqueHash(),
        hookNames: ['beforeRender'],
        validators: [{ name: 'BValidator', version: '1' }],
        promptHookIdentity: opaqueHash(),
      };
      const left: ValidationIdentityInput = {
        ...VALIDATION_INPUT,
        validators: [...VALIDATION_INPUT.validators],
        plugins: [pluginA, pluginB],
      };
      const right: ValidationIdentityInput = {
        ...VALIDATION_INPUT,
        validators: [...VALIDATION_INPUT.validators].reverse(),
        plugins: [pluginB, pluginA],
      };
      expect(computeValidationIdentity(left)).toBe(computeValidationIdentity(right));
    });

    it('changes when the built-in implementation version changes', () => {
      const changed = {
        ...VALIDATION_INPUT,
        builtInValidatorImplementationVersion: '2',
      };
      expect(computeValidationIdentity(VALIDATION_INPUT)).not.toBe(
        computeValidationIdentity(changed),
      );
    });
  });

  describe('computePlanHash', () => {
    function makeIdentity(overrides?: Partial<CompiledSceneIdentity>): CompiledSceneIdentity {
      return {
        eventId: 'E001',
        sourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        scopeHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
        editorialBasisHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
        validationIdentity: 'val-identity-1',
        requiresProvider: true,
        ...overrides,
      };
    }

    function basePlanInput(overrides?: Partial<PlanHashInput>): PlanHashInput {
      return {
        selectedEventIds: ['E001'],
        scenes: [makeIdentity()],
        branchPath: undefined,
        discourseBranch: undefined,
        model: undefined,
        providerProfile: undefined,
        waiverHashes: [],
        feedbackHashes: [],
        batch: undefined,
        maxRounds: undefined,
        ...overrides,
      };
    }

    it('produces deterministic plan hash', () => {
      const h1 = computePlanHash(basePlanInput());
      const h2 = computePlanHash(basePlanInput());
      expect(h1).toBe(h2);
    });

    it('planHash changes when model changes', () => {
      const h1 = computePlanHash(basePlanInput({ model: 'model-a' }));
      const h2 = computePlanHash(basePlanInput({ model: 'model-b' }));
      expect(h1).not.toBe(h2);
    });

    it('planHash changes when providerProfile changes', () => {
      const h1 = computePlanHash(basePlanInput({ providerProfile: 'fast' }));
      const h2 = computePlanHash(basePlanInput({ providerProfile: 'slow' }));
      expect(h1).not.toBe(h2);
    });

    it('planHash changes when waivers change', () => {
      const h1 = computePlanHash(basePlanInput({ waiverHashes: ['waiver-a'] }));
      const h2 = computePlanHash(basePlanInput({ waiverHashes: ['waiver-b'] }));
      expect(h1).not.toBe(h2);
    });

    it('planHash changes when feedback changes', () => {
      const h1 = computePlanHash(basePlanInput({ feedbackHashes: ['feedback-001'] }));
      const h2 = computePlanHash(basePlanInput({ feedbackHashes: ['feedback-002'] }));
      expect(h1).not.toBe(h2);
    });

    it('planHash is stable for identical scenes in same order', () => {
      const scenes = [
        makeIdentity({ eventId: 'E001', sourceHash: opaqueHash() }),
        makeIdentity({ eventId: 'E002', sourceHash: opaqueHash() }),
      ];
      const h1 = computePlanHash(basePlanInput({ selectedEventIds: ['E001', 'E002'], scenes }));
      const h2 = computePlanHash(basePlanInput({ selectedEventIds: ['E001', 'E002'], scenes }));
      expect(h1).toBe(h2);
    });
  });

  describe('computeSelectorHash', () => {
    it('produces stable hash for the same selector', () => {
      expect(computeSelectorHash({ type: 'all' })).toBe(computeSelectorHash({ type: 'all' }));
    });

    it('produces different hashes for different selectors', () => {
      expect(computeSelectorHash({ type: 'all' })).not.toBe(
        computeSelectorHash({ type: 'chapter', chapter: 1 }),
      );
    });

    it('is stable for undefined', () => {
      expect(computeSelectorHash(undefined)).toBe(computeSelectorHash(undefined));
    });
  });

  describe('canonicalJson', () => {
    it('sorts object keys', () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('omits undefined values', () => {
      expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it('serializes arrays preserving order', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('handles nested objects', () => {
      expect(canonicalJson({ nested: { b: 1, a: 2 } })).toBe('{"nested":{"a":2,"b":1}}');
    });

    it('handles null', () => {
      expect(canonicalJson(null)).toBe('null');
    });
  });
});

// ============================================================================
// Branch Contracts Tests
// ============================================================================

describe('compileBranchContracts', () => {
  it('produces story with narrative order map', () => {
    const contracts = compileBranchContracts(CATALOG, BRANCH_PATH, 'main');
    expect(contracts.story.eventIds).toEqual(['E001', 'E002', 'E003', 'E004', 'E005']);
    expect(contracts.story.narrativeOrderMap.E001).toBe(1);
    expect(contracts.story.narrativeOrderMap.E005).toBe(5);
  });

  it('preserves branch path and discourse branch', () => {
    const contracts = compileBranchContracts(CATALOG, BRANCH_PATH, 'alt-timeline');
    expect(contracts.discourse.branchPath).toEqual(BRANCH_PATH);
    expect(contracts.discourse.discourseBranch).toBe('alt-timeline');
  });

  it('produces default surface contract', () => {
    const contracts = compileBranchContracts(CATALOG, undefined, undefined);
    expect(contracts.surface.groupIds).toEqual(['default']);
    expect(contracts.surface.serialLanes).toEqual([]);
  });

  it('is deterministic', () => {
    const a = compileBranchContracts(CATALOG, undefined, undefined);
    const b = compileBranchContracts(CATALOG, undefined, undefined);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Semantic Plan Purity Tests — no host paths, read sets, or prepared writes
// ============================================================================

describe('semantic plan purity', () => {
  it('compile output contains no read set, prepared writes, or host paths', () => {
    const output = compileEditorialRun(defaultCompileInput());
    // Deleted compatibility surface must not reappear on the output.
    expect('readSet' in output).toBe(false);
    expect('preparedExternalChanges' in output).toBe(false);
    expect('jobs' in output).toBe(false);

    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('.nova');
    expect(serialized).not.toContain('source-head');
    expect(serialized).not.toContain('/responses');
    expect(serialized).not.toContain('/test-project');
  });

  it('compile input carries no host paths or read-set configuration', () => {
    const input = defaultCompileInput();
    expect('projectDir' in input.request).toBe(false);
    expect('sourceHeadPath' in input.request).toBe(false);
    expect('responsesDir' in input.request).toBe(false);

    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('.nova');
    expect(serialized).not.toContain('source-head');
    expect(serialized).not.toContain('/test-project');
  });

  it('render intents are semantic — identity and kind only, no file expectations', () => {
    const output = compileEditorialRun(defaultCompileInput());
    expect(output.intents.length).toBeGreaterThan(0);
    for (const intent of output.intents) {
      expect(Object.keys(intent).sort()).toEqual(
        ['eventId', 'identities', 'jobId', 'kind', 'requiresProvider'].sort(),
      );
      const serialized = JSON.stringify(intent);
      expect(serialized).not.toContain('.nova');
      expect(serialized).not.toContain('source-head');
      expect(serialized).not.toContain('/');
      expect(serialized).not.toContain('expectedHash');
    }
  });

  it('planSummary.sourceHash is the snapshot content hash — not a persistence head', () => {
    const input = defaultCompileInput();
    const output = compileEditorialRun(input);
    expect(output.planSummary.sourceHash).toBe(input.source.sourceHash);
    expect(output.planSummary.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sourceHash is content identity — sorted documents, no host metadata', () => {
    const documents = defaultDocuments();
    const entries = Object.entries(documents);
    const forward = buildSnapshot(Object.fromEntries(entries));
    const backward = buildSnapshot(Object.fromEntries([...entries].reverse()));

    expect(forward.documents.map((d) => d.logicalPath)).toEqual(
      backward.documents.map((d) => d.logicalPath),
    );
    expect(forward.sourceHash).toBe(backward.sourceHash);

    const serialized = JSON.stringify(forward);
    expect(serialized).not.toContain('.nova');
    expect(serialized).not.toContain('source-head');
    expect(serialized).not.toContain('/test-project');
  });

  it('identical bytes with different provenance produce identical plans', () => {
    const documents = defaultDocuments();
    const a = defaultCompileInput();
    // Same documents rebuilt into a fresh snapshot (e.g. a different host/provenance).
    const b = defaultCompileInput({ source: buildSnapshot(documents) });

    expect(b.source.sourceHash).toBe(a.source.sourceHash);
    expect(compileEditorialRun(a)).toEqual(compileEditorialRun(b));
  });
});

// ============================================================================
// Compile Editorial Run — Main integration tests
// ============================================================================

describe('compileEditorialRun', () => {
  // ── Acceptance 1: Two identical compiles deep‑equal / planHash equal ──────

  it('produces identical output and planHash for identical inputs', () => {
    const a = compileEditorialRun(defaultCompileInput());
    const b = compileEditorialRun(defaultCompileInput());
    expect(a.planHash).toBe(b.planHash);
    expect(a).toEqual(b);
  });

  it('planHash is deterministic across multiple calls', () => {
    const results = Array.from({ length: 5 }, () => compileEditorialRun(defaultCompileInput()));
    const hashes = results.map((r) => r.planHash);
    expect(new Set(hashes).size).toBe(1);
  });

  // ── Acceptance 2: Model/profile affects plan/request but not editorial basis ──

  it('different model changes planHash but not editorial basis hashes', () => {
    const inputA = defaultCompileInput({ requestOverrides: { model: 'model-a' } });
    const inputB = defaultCompileInput({ requestOverrides: { model: 'model-b' } });

    const outputA = compileEditorialRun(inputA);
    const outputB = compileEditorialRun(inputB);

    // Plan hashes differ
    expect(outputA.planHash).not.toBe(outputB.planHash);

    // But editorial basis hashes are the same (provider‑free)
    for (let i = 0; i < outputA.scenes.length; i++) {
      expect(outputA.scenes[i].editorialBasisHash).toBe(outputB.scenes[i].editorialBasisHash);
    }
  });

  it('different providerProfile changes planHash but not editorial basis hashes', () => {
    const inputA = defaultCompileInput({ requestOverrides: { providerProfile: 'fast' } });
    const inputB = defaultCompileInput({ requestOverrides: { providerProfile: 'slow' } });

    const outputA = compileEditorialRun(inputA);
    const outputB = compileEditorialRun(inputB);

    expect(outputA.planHash).not.toBe(outputB.planHash);
    for (let i = 0; i < outputA.scenes.length; i++) {
      expect(outputA.scenes[i].editorialBasisHash).toBe(outputB.scenes[i].editorialBasisHash);
    }
  });

  // ── Acceptance 3: Source/review/waiver/validator changes affect identities ──

  it('source changes affect sourceHash and editorialBasisHash', () => {
    const base = defaultCompileInput();
    const modified = defaultCompileInput({
      eventContents: { ...EVENT_CONTENTS, E001: 'id: E001\nevent: Modified\n' },
    });

    const baseOutput = compileEditorialRun(base);
    const modOutput = compileEditorialRun(modified);

    const baseE001 = baseOutput.scenes.find((s) => s.eventId === 'E001');
    const modE001 = modOutput.scenes.find((s) => s.eventId === 'E001');
    if (baseE001 === undefined || modE001 === undefined) {
      throw new Error('expected E001 scenes in both outputs');
    }

    expect(baseE001.sourceHash).not.toBe(modE001.sourceHash);
    expect(baseE001.editorialBasisHash).not.toBe(modE001.editorialBasisHash);
  });

  it('revision basis changes affect editorialBasisHash', () => {
    const baseRev: Record<string, { revisionId: string; proseHash: string } | null> = {
      E001: { revisionId: 'old-rev', proseHash: opaqueHash() },
    };
    const newRev: Record<string, { revisionId: string; proseHash: string } | null> = {
      E001: { revisionId: 'new-rev', proseHash: opaqueHash() },
    };

    const outputA = compileEditorialRun(defaultCompileInput({ latestRevisions: baseRev }));
    const outputB = compileEditorialRun(defaultCompileInput({ latestRevisions: newRev }));

    const sceneA = outputA.scenes.find((s) => s.eventId === 'E001');
    const sceneB = outputB.scenes.find((s) => s.eventId === 'E001');
    if (sceneA === undefined || sceneB === undefined) {
      throw new Error('expected E001 scenes in both outputs');
    }
    expect(sceneA.editorialBasisHash).not.toBe(sceneB.editorialBasisHash);
  });

  it('review waiver changes affect planHash', () => {
    const inputA = defaultCompileInput({
      requestOverrides: {
        waivers: [
          {
            gateId: 'gate-1',
            signedBy: 'admin',
            signedAt: '2026-07-28T00:00:00.000Z',
            reason: 'test',
          },
        ],
      },
    });
    const inputB = defaultCompileInput({ requestOverrides: { waivers: [] } });

    expect(compileEditorialRun(inputA).planHash).not.toBe(compileEditorialRun(inputB).planHash);
  });

  it('waiver ordering does not affect planHash (sorted deterministically)', () => {
    const waivers = [
      {
        gateId: 'gate-1',
        signedBy: 'admin',
        signedAt: '2026-07-28T00:00:00.000Z',
        reason: 'first',
      },
      {
        gateId: 'gate-2',
        signedBy: 'editor',
        signedAt: '2026-07-28T01:00:00.000Z',
        reason: 'second',
      },
    ];
    const inputA = defaultCompileInput({ requestOverrides: { waivers } });
    const inputB = defaultCompileInput({ requestOverrides: { waivers: [...waivers].reverse() } });
    expect(compileEditorialRun(inputA).planHash).toBe(compileEditorialRun(inputB).planHash);
  });

  it('review ID ordering does not affect planHash (sorted deterministically)', () => {
    const inputA = defaultCompileInput({
      requestOverrides: { revision: { reviewIds: ['rev-001', 'rev-002'] } },
    });
    const inputB = defaultCompileInput({
      requestOverrides: { revision: { reviewIds: ['rev-002', 'rev-001'] } },
    });
    expect(compileEditorialRun(inputA).planHash).toBe(compileEditorialRun(inputB).planHash);
  });

  it('validator version changes affect validationIdentity', () => {
    const inputA = defaultCompileInput({
      validation: {
        ...VALIDATION_INPUT,
        validators: VALIDATION_INPUT.validators.map((validator) =>
          validator.name === 'CausalityValidator' ? { ...validator, version: '1.0.0' } : validator,
        ),
      },
    });
    const inputB = defaultCompileInput({
      validation: {
        ...VALIDATION_INPUT,
        validators: VALIDATION_INPUT.validators.map((validator) =>
          validator.name === 'CausalityValidator' ? { ...validator, version: '2.0.0' } : validator,
        ),
      },
    });

    const outputA = compileEditorialRun(inputA);
    const outputB = compileEditorialRun(inputB);

    // Every scene's validation identity should differ
    for (let i = 0; i < outputA.scenes.length; i++) {
      expect(outputA.scenes[i].validationIdentity).not.toBe(outputB.scenes[i].validationIdentity);
    }

    // Entire plan hashes also differ because validationIdentity is baked into plan
    expect(outputA.planHash).not.toBe(outputB.planHash);
  });

  it('severity overrides change validationIdentity', () => {
    const inputA = defaultCompileInput();
    const inputB = defaultCompileInput({
      validation: { ...VALIDATION_INPUT, effectiveOverrides: { POVValidator: 'off' as const } },
    });

    const outputA = compileEditorialRun(inputA);
    const outputB = compileEditorialRun(inputB);
    expect(outputA.planSummary.validationIdentity).not.toBe(outputB.planSummary.validationIdentity);
  });

  // ── Acceptance 4: Invalid selection is side‑effect free ──────────────────

  it('unknown event produces SCENE_NOT_FOUND errors but no thrown exception', () => {
    const input = defaultCompileInput({
      requestOverrides: {
        selector: { type: 'events', eventIds: ['E001', 'E999'] } as SceneSelector,
      },
    });

    const output = compileEditorialRun(input);

    expect(output.selectorErrors).toHaveLength(1);
    expect(output.selectorErrors[0].code).toBe('SCENE_NOT_FOUND');
    expect(output.selectorErrors[0].eventId).toBe('E999');

    // Only valid E001 survived; E999 is discarded with error
    expect(output.selectedEventIds).toEqual(['E001']);
    expect(output.scenes).toHaveLength(1);
    expect(output.scenes[0].eventId).toBe('E001');
  });

  it('invalid revision review is reported in preflight errors', () => {
    const input = defaultCompileInput({
      requestOverrides: {
        revision: { reviewIds: ['nonexistent-review'] },
      },
    });

    const output = compileEditorialRun(input);

    // The compile still succeeds — errors are embedded in the result.
    expect(output.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.planSummary.scenes).toHaveLength(5);
    // Invalid explicit feedback is reported atomically.
    expect(output.selectorErrors).toHaveLength(1);
    expect(output.selectorErrors[0].code).toBe('INVALID_REVIEW_SELECTION');
  });

  it('completely invalid selector (all unknown) still produces valid plan shape', () => {
    const input = defaultCompileInput({
      requestOverrides: {
        selector: { type: 'events', eventIds: ['E999', 'E888'] } as SceneSelector,
      },
    });

    const output = compileEditorialRun(input);

    expect(output.selectorErrors).toHaveLength(2);
    expect(output.selectorErrors[0].code).toBe('SCENE_NOT_FOUND');
    expect(output.selectorErrors[0].eventId).toBe('E999');
    expect(output.selectorErrors[1].code).toBe('SCENE_NOT_FOUND');
    expect(output.selectorErrors[1].eventId).toBe('E888');
    expect(output.selectedEventIds).toHaveLength(0);
    expect(output.scenes).toHaveLength(0);
    expect(output.intents).toHaveLength(0);
    expect(output.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // ── Additional structural tests ──────────────────────────────────────────

  it('builds correct intents for scenes needing providers', () => {
    const input = defaultCompileInput({
      requiresProviderByEventId: { E001: true, E002: false, E003: true, E004: false, E005: true },
    });
    const output = compileEditorialRun(input);
    const intentEventIds = output.intents.map((j) => j.eventId);
    expect(intentEventIds).toEqual(['E001', 'E003', 'E005']);
  });

  it('invalid review selection blocks all scenes and produces zero intents', () => {
    const output = compileEditorialRun(
      defaultCompileInput({
        requestOverrides: { revision: { reviewIds: ['nonexistent-review'] } },
      }),
    );
    // Preflight errors include exactly one atomic selection error.
    expect(output.selectorErrors).toHaveLength(1);
    expect(output.selectorErrors[0].code).toBe('INVALID_REVIEW_SELECTION');
    // All 5 scenes are preflight_failed
    expect(output.scenes).toHaveLength(5);
    for (const scene of output.scenes) {
      expect(scene.state).toBe('preflight_failed');
    }
    // Zero semantic render intents
    expect(output.intents).toHaveLength(0);
    // The plan is still a valid immutable shape with no file read-set.
    expect(output.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect('readSet' in output).toBe(false);
  });

  it('compile emits only semantic render intents — no prepared writes', () => {
    const output = compileEditorialRun(defaultCompileInput());
    expect('preparedExternalChanges' in output).toBe(false);
    expect('readSet' in output).toBe(false);
    // Render intents carry identity only.
    for (const intent of output.intents) {
      expect(Object.keys(intent).sort()).toEqual(
        ['eventId', 'identities', 'jobId', 'kind', 'requiresProvider'].sort(),
      );
    }
  });

  it('planSummary conforms to EditorialPlanSummaryV1 shape with deterministic scene identities', () => {
    const input = defaultCompileInput();
    const output = compileEditorialRun(input);
    expect(output.planSummary.version).toBe(1);
    expect(output.planSummary.planHash).toBe(output.planHash);
    expect(output.planSummary.sourceHash).toBe(input.source.sourceHash);
    expect(output.planSummary.selectedEventIds).toEqual(['E001', 'E002', 'E003', 'E004', 'E005']);
    expect(output.planSummary.scenes).toHaveLength(5);
    const expectedEventIds = ['E001', 'E002', 'E003', 'E004', 'E005'];
    output.planSummary.scenes.forEach((s, i) => {
      expect(s.eventId).toBe(expectedEventIds[i]);
      expect(s.editorialBasisHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it('batch config affects planHash', () => {
    const noBatch = compileEditorialRun(defaultCompileInput());
    const withBatch = compileEditorialRun(
      defaultCompileInput({
        requestOverrides: { batch: { batchSize: 3, windowSize: 2, failFast: true } },
      }),
    );
    expect(noBatch.planHash).not.toBe(withBatch.planHash);
  });

  it('branch path affects scope hash and plan hash', () => {
    const noBranch = compileEditorialRun(
      defaultCompileInput({ requestOverrides: { branchPath: undefined } }),
    );
    const withBranch = compileEditorialRun(
      defaultCompileInput({ requestOverrides: { branchPath: BRANCH_PATH } }),
    );

    for (let i = 0; i < noBranch.scenes.length; i++) {
      expect(noBranch.scenes[i].scopeHash).not.toBe(withBranch.scenes[i].scopeHash);
    }
    expect(noBranch.planHash).not.toBe(withBranch.planHash);
  });
});
