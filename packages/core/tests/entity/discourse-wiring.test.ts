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

  beforeAll(() => {
    const mapper = new EntityMapper(FIXTURE);
    data = mapper.loadProject();
    events = mapper.loadAllEvents(data.chapters);
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
    expect(data.narratorAssertions['assertion_xianglin_death'].truthBoundary).toBe(true);
    expect(data.narratorAssertions['assertion_afterlife_uncertain']).toBeDefined();
    expect(data.narratorAssertions['assertion_afterlife_uncertain'].truthBoundary).toBe(false);
  });

  it('compile() resolves narratorProfileRef and replays the ledger without error for E0', () => {
    const e0 = events.find((ev) => ev.id === 'E0');
    expect(e0).toBeDefined();
    expect(e0!.narratorProfileRef).toBe('narrator_wo');

    const registry = new InMemoryEntityRegistry();
    registry.load(FIXTURE);

    const pkg = new ContextCompiler().compile(e0!, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      narratorAssertions: data.narratorAssertions,
      discourseLedger: data.discourseLedger,
    });

    expect(pkg.narratorProfile?.id).toBe('narrator_wo');
    expect(pkg.discourseReplayError).toBeUndefined();
  });

  it('projects E0 claim surface into the Pass 1 context package', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(FIXTURE);

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      narratorAssertions: data.narratorAssertions,
      discourseLedger: data.discourseLedger,
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

    const prompt = new PromptAssembler().assemble(pkg).userPrompt;
    expect(prompt).toContain('"discourseProjection"');
    expect(prompt).toContain("灵魂和地狱是否存在——'也许有罢……说不清'");
  });

  it('compile() surfaces a replay error for a corrupt ledger (duplicate positions)', () => {
    const e0 = events.find((ev) => ev.id === 'E0')!;
    const registry = new InMemoryEntityRegistry();
    registry.load(FIXTURE);

    const corruptLedger = {
      ...data.discourseLedger!,
      entries: data.discourseLedger!.entries.map((entry) => ({
        ...entry,
        discoursePosition: 0,
      })),
    };

    const pkg = new ContextCompiler().compile(e0, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseLedger: corruptLedger,
    });

    expect(pkg.discourseReplayError).toContain('DuplicateDiscoursePositionError');
  });
});
