// ============================================================================
// Discourse Wiring — full load→compile chain integration (DISCOURSE-1)
// ============================================================================
// Proves the discourse layer is reachable from the real fixture-loading path:
//   fixtures/zhu-fu YAML → EntityMapper.loadProject() (narrator profiles,
//   discourse ledger, assertions) → ContextCompiler.compile() (narrator
//   resolution + Pass 1-safe disclosure projection) → PromptAssembler.
// ============================================================================

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ContextCompiler } from '../../src/context/compiler.ts';
import { PromptAssembler } from '../../src/context/prompt-assembler.ts';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { InMemoryEntityRegistry } from '../../src/entity/registry.ts';
import type { ProjectData } from '../../src/entity/types.ts';
import type { CompiledDiscourseRenderContext } from '../../src/state/discourse-context.ts';
import { compileDiscourseBoundaries } from '../../src/state/discourse-context.ts';
import type { NarrativeEvent, WorldState } from '../../src/types/index.ts';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'zhu-fu');

const EMPTY_STATE: WorldState = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};

describe('discourse wiring — zhu-fu fixture load→compile chain', () => {
  let data: ProjectData;
  let events: NarrativeEvent[];
  let discourseContexts: Record<string, CompiledDiscourseRenderContext>;

  beforeAll(() => {
    const mapper = new EntityMapper(FIXTURE);
    data = mapper.loadProject();
    events = mapper.loadAllEvents(data);
    discourseContexts = compileDiscourseBoundaries(
      events,
      data.discourseLedger,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );
  });

  it('loads narrator_wo profile from definitions/narrators/', () => {
    const profile = data.narratorProfiles['narrator_wo'];
    expect(profile).toBeDefined();
    expect(profile.type).toBe('retrospective_entity');
    expect(profile.fidelity).toBe('reliable');
  });

  it('loads the discourse ledger with 2 entries', () => {
    expect(data.discourseLedger).not.toBeNull();
    expect(data.discourseLedger!.entries).toHaveLength(2);
    expect(data.discourseLedger!.entries.map((e) => e.action.type)).toEqual(['reveal', 'claim']);
  });

  it('loads both narrator assertions from definitions/assertions/', () => {
    expect(data.narratorAssertions['assertion_xianglin_death']).toBeDefined();
    expect(data.narratorAssertions['assertion_xianglin_death'].status).toBe('asserted');
    expect(data.narratorAssertions['assertion_afterlife_uncertain']).toBeDefined();
    expect(data.narratorAssertions['assertion_afterlife_uncertain'].status).toBe('unknown');
  });

  it('compile() resolves narratorProfileRef and replays the ledger without error for E0', () => {
    const e0 = events.find((ev) => ev.id === 'E0');
    expect(e0).toBeDefined();
    expect(e0!.narratorProfileRef).toBe('narrator_wo');

    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const pkg = new ContextCompiler().compile(e0!, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0!.id],
    });

    expect(pkg.narratorProfile?.id).toBe('narrator_wo');
    expect(pkg.discourseReplayError).toBeUndefined();
  });

  it('projects E0 claim surface into the Pass 1 context package', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });

    expect(pkg.discourseProjection).toMatchObject({
      plannedReveals: ['assertion_xianglin_death'],
      openClaims: ['assertion_afterlife_uncertain'],
      accessibleClaims: [
        {
          assertionId: 'assertion_afterlife_uncertain',
          surface: "灵魂和地狱是否存在——'也许有罢……说不清'",
        },
      ],
    });
    expect(pkg.discourseProjection?.authorizedTargets).toHaveLength(2);

    const assembled = new PromptAssembler().assemble(pkg);
    // The Pass 1 prompt is a system + user message pair; the scene spec
    // (goal + ordered beats) travels inside the serialized context package
    // in the user message — not the system message.
    const userMessage = assembled.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    const prompt = userMessage!.content;
    expect(prompt).toContain('"discourseProjection"');
    expect(prompt).toContain("灵魂和地狱是否存在——'也许有罢……说不清'");
    // Golden contract: the Pass 1 user message carries the scene goal and the
    // ordered beats derived from the authored E0 brief (fixtures/zhu-fu).
    const contextBlock = prompt.match(/```json\n([\s\S]*?)```/)?.[1];
    expect(contextBlock).toBeDefined();
    const contextPackage = JSON.parse(contextBlock!);
    expect(contextPackage.sceneSpec.goal).toContain('旧历年底，叙述者');
    expect(contextPackage.sceneSpec.beats[0]).toContain('旧历年底，叙述者');
    expect(contextPackage.sceneSpec.beats[1]).toContain('除夕前日');
    expect(contextPackage.sceneSpec.beats[2]).toContain('她突然拦住');
  });

  it('compile() surfaces a replay error for a corrupt ledger (duplicate positions)', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const corruptLedger = {
      ...data.discourseLedger!,
      entries: data.discourseLedger!.entries.map((entry) => ({
        ...entry,
        discoursePosition: 0,
      })),
    };

    expect(() =>
      compileDiscourseBoundaries(
        events,
        corruptLedger,
        data.narratorAssertions,
        data.narratorProfiles,
        'main',
      ),
    ).toThrow(/Duplicate discourse position/);
  });
  it('compile() produces correct projection for E0 with two continuous actions (positions 0,1)', () => {
    // The zhu-fu ledger has two entries for E0: reveal at pos 0, claim at pos 1
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });

    // Both E0 entries should be in the projection
    expect(pkg.discourseProjection).toBeDefined();
    expect(pkg.discourseProjection!.plannedReveals).toContain('assertion_xianglin_death');
    expect(pkg.discourseProjection!.openClaims).toContain('assertion_afterlife_uncertain');
    // Two authorized targets: one reveal, one claim
    expect(pkg.discourseProjection!.authorizedTargets).toHaveLength(2);
    expect(pkg.discourseProjection!.authorizedTargets[0].actionType).toBe('reveal');
    expect(pkg.discourseProjection!.authorizedTargets[1].actionType).toBe('claim');
  });

  it('compile() uses precompiled discourse context for sparse global positions', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);
    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });
    expect(pkg.discourseReplayError).toBeUndefined();
    expect(pkg.discourseProjection!.plannedReveals).toContain('assertion_xianglin_death');
    expect(pkg.discourseProjection!.openClaims).toContain('assertion_afterlife_uncertain');
  });

  it('compile() uses the precompiled context projection', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });
    expect(pkg.discourseProjection).toBeDefined();
  });

  it('compile() surfaces error when reveal assertion missing from catalog', () => {
    // Omit narratorAssertions — reveal will fail because it can't find assertion_xianglin_death
    // Current code: without assertions catalog, reveal doesn't validate status
    // (the findAssertion check returns undefined, skipping the throw)
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    expect(() =>
      compileDiscourseBoundaries(events, data.discourseLedger, {}, data.narratorProfiles, 'main'),
    ).toThrow(/assertion catalog is required/);

    // Strict preflight rejects assertion-bearing ledgers without a catalog.
  });

  it('compile() with mismatched assertion status for reveal fails', () => {
    // Provide a catalog where assertion_xianglin_death has status=unknown
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    // Tamper with the assertion — flip status on the reveal assertion
    const tamperedAssertions = {
      ...data.narratorAssertions,
      assertion_xianglin_death: {
        ...data.narratorAssertions!['assertion_xianglin_death'],
        status: 'unknown' as const,
        type: 'claim' as const,
      },
    };

    expect(() =>
      compileDiscourseBoundaries(
        events,
        data.discourseLedger,
        tamperedAssertions,
        data.narratorProfiles,
        'main',
      ),
    ).toThrow(/Reveals require status=asserted/);

    // Strict preflight rejects a reveal whose catalog entry is not authoritative.
  });

  it('compile() default discourseBranch produces correct branch projection', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    // Default branch is 'main'
    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });

    expect(pkg.discourseProjection).toBeDefined();
    // E0 has main-branch entries only
    expect(pkg.discourseProjection!.plannedReveals).toHaveLength(1);
  });

  it('compile() with non-matching event id produces empty projection', () => {
    // An event with no matching sceneId in ledger entries gets no authorized targets
    const e0 = events.find((ev) => ev.id === 'E0')!;
    // Use an event with a different id
    const otherEvent = {
      ...e0,
      id: 'E_OTHER',
    };
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    // With mandatory contiguous ledger semantics, an event id unknown to the
    // ledger chapters is a hard preflight failure, not a silent empty projection.
    expect(() =>
      compileDiscourseBoundaries(
        [...events, otherEvent],
        data.discourseLedger,
        data.narratorAssertions,
        data.narratorProfiles,
        'main',
      ),
    ).toThrow(/omits reachable scene/);
  });

  it("compile() with explicit 'main' branch projects E0 entries correctly", () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseContexts[e0.id],
    });

    expect(pkg.discourseProjection).toBeDefined();
    expect(pkg.discourseProjection!.plannedReveals).toContain('assertion_xianglin_death');
    expect(pkg.discourseProjection!.openClaims).toContain('assertion_afterlife_uncertain');
  });

  it('compile() produces safe projection with no leaked hint targets', () => {
    // Add a hint entry to the ledger, verify hint target doesn't leak
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    const ledgerWithHint = {
      ...data.discourseLedger!,
      entries: [
        ...data.discourseLedger!.entries,
        {
          id: 'entry_hint_test',
          action: {
            type: 'hint' as const,
            hintId: 'hint_test',
            surfaceProposition: 'visible_hint_surface',
            targetProposition: 'hidden_hint_target',
            discoursePosition: 2,
          },
          sceneId: 'E0',
          branch: 'main',
          discoursePosition: 2,
        },
      ],
    };

    const hintContexts = compileDiscourseBoundaries(
      events,
      ledgerWithHint,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );
    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: hintContexts[e0.id],
    });

    expect(pkg.discourseReplayError).toBeUndefined();
    expect(pkg.discourseProjection).toBeDefined();

    // Projection must not contain the target
    const projStr = JSON.stringify(pkg.discourseProjection);
    expect(projStr).not.toContain('hidden_hint_target');
    // Surface IS visible
    expect(projStr).toContain('visible_hint_surface');
  });

  it('compile() replay error for corrupt ledger (position out of bounds)', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(data);

    // Position 99 breaks the contiguous-from-0 invariant in discourse-sequence
    const badLedger = {
      ...data.discourseLedger!,
      entries: [
        ...data.discourseLedger!.entries,
        {
          ...data.discourseLedger!.entries[0],
          id: 'entry_oob',
          discoursePosition: 99,
          action: {
            ...data.discourseLedger!.entries[0].action,
            discoursePosition: 99,
          },
        },
      ],
    };

    // Strict preflight rejects positions that violate the scene contract.
    expect(() =>
      compileDiscourseBoundaries(
        events,
        badLedger,
        data.narratorAssertions,
        data.narratorProfiles,
        'main',
      ),
    ).toThrow(/non-continuous action positions/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// compileDiscourseBoundaries — projection from stateAfter (§12)
// ═════════════════════════════════════════════════════════════════════════════
// These tests target compileDiscourseBoundaries() directly, bypassing
// ContextCompiler. They verify that the safe Pass 1 projection derives from
// stateAfter (including the current scene's own reveal/claim actions), not
// stateBefore.

describe('compileDiscourseBoundaries projection from stateAfter', () => {
  let events: NarrativeEvent[];

  beforeAll(() => {
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();
    events = mapper.loadAllEvents(data);
  });

  it('stateBefore is empty for E0 with positions 0,1 (pre-range)', () => {
    const e0Event = events.find((ev) => ev.id === 'E0')!;
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();

    const ctx = compileDiscourseBoundaries(
      events,
      data.discourseLedger!,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );

    const e0Ctx = ctx['E0'];

    // stateBefore is empty — no reveals or claims before the first action
    expect(e0Ctx.stateBefore.reveals).toEqual([]);
    expect(e0Ctx.stateBefore.openClaims).toEqual([]);
    // cursor is the first action's position
    expect(e0Ctx.cursor).toBe(0);
  });

  it('stateAfter includes E0 reveal and claim actions', () => {
    const e0Event = events.find((ev) => ev.id === 'E0')!;
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();

    const ctx = compileDiscourseBoundaries(
      events,
      data.discourseLedger!,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );

    const e0Ctx = ctx['E0'];

    // stateAfter includes both actions applied
    expect(e0Ctx.stateAfter.reveals).toContain('assertion_xianglin_death');
    expect(e0Ctx.stateAfter.openClaims).toContain('assertion_afterlife_uncertain');

    // stateBefore and stateAfter differ
    expect(e0Ctx.stateBefore).not.toBe(e0Ctx.stateAfter);
  });

  it('projection from stateAfter includes both reveal and claim', () => {
    const e0Event = events.find((ev) => ev.id === 'E0')!;
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();

    const ctx = compileDiscourseBoundaries(
      events,
      data.discourseLedger!,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );

    const proj = ctx['E0']!.projection;

    // Both E0's reveal and claim appear in the safe projection
    expect(proj.plannedReveals).toContain('assertion_xianglin_death');
    expect(proj.openClaims).toContain('assertion_afterlife_uncertain');

    // Authorized targets include both actions
    expect(proj.authorizedTargets).toHaveLength(2);
    expect(proj.authorizedTargets[0].actionType).toBe('reveal');
    expect(proj.authorizedTargets[1].actionType).toBe('claim');
    expect(proj.authorizedTargets[0].assertionId).toBe('assertion_xianglin_death');
    expect(proj.authorizedTargets[1].assertionId).toBe('assertion_afterlife_uncertain');
  });

  it('projection excludes hint targets', () => {
    const e0Event = events.find((ev) => ev.id === 'E0')!;
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();

    // Inject a hint action into the ledger
    const ledgerWithHint = {
      ...data.discourseLedger!,
      entries: [
        ...data.discourseLedger!.entries,
        {
          id: 'hint_entry',
          action: {
            type: 'hint' as const,
            hintId: 'hint_test',
            surfaceProposition: 'a visible surface',
            targetProposition: 'HIDDEN_TARGET',
            discoursePosition: 2,
          },
          sceneId: 'E0',
          branch: 'main',
          discoursePosition: 2,
        },
      ],
    };

    const ctx = compileDiscourseBoundaries(
      events,
      ledgerWithHint,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );

    const proj = ctx['E0']!.projection;

    // Hint surface is visible
    expect(proj.visibleHints).toHaveLength(1);
    expect(proj.visibleHints[0].surfaceProposition).toBe('a visible surface');

    // Hint target NEVER appears in projection
    const projStr = JSON.stringify(proj);
    expect(projStr).not.toContain('HIDDEN_TARGET');

    // Hints don't leak into authorized targets
    expect(proj.authorizedTargets).toHaveLength(2); // only reveal + claim
    expect(proj.visibleHints[0]).not.toHaveProperty('targetProposition');
  });

  it('compileDiscourseBoundaries rejects reveal without asserted status', () => {
    const e0Event = events.find((ev) => ev.id === 'E0')!;
    const mapper = new EntityMapper(FIXTURE);
    const data = mapper.loadProject();

    // Flip status on the reveal assertion
    const tamperedAssertions = {
      ...data.narratorAssertions,
      assertion_xianglin_death: {
        ...data.narratorAssertions!['assertion_xianglin_death'],
        status: 'unknown' as const,
        type: 'claim' as const,
      },
    };

    expect(() =>
      compileDiscourseBoundaries(
        events,
        data.discourseLedger!,
        tamperedAssertions,
        data.narratorProfiles,
        'main',
      ),
    ).toThrow('Reveals require status=asserted');
  });
});
