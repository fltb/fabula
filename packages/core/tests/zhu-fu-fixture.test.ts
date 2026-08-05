// ============================================================================
// P1 verification: zhu-fu fixture loads correctly through EntityMapper
// ============================================================================

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../src/entity/index.js';
import { materializeFixtureSnapshot } from './fixtures/fixture-snapshots.ts';

const SNAPSHOT = materializeFixtureSnapshot(
  path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'zhu-fu'),
);

describe('zhu-fu fixture — loadProject', () => {
  const mapper = new EntityMapper(SNAPSHOT);

  it('loads project config with genre, synopsis, tense', () => {
    const data = mapper.loadProject();
    expect(data.config).toBeTruthy();
    expect(data.config?.project).toBe('zhu-fu');
    expect(data.config?.title).toBe('祝福');
    expect(data.config?.genre).toBe('literary');
    expect(data.config?.tense).toBe('past');
    expect(data.config?.synopsis).toBeTruthy();
  });

  it('loads 8 characters as array', () => {
    const data = mapper.loadProject();
    expect(data.characters).toHaveLength(8);
    const xw = data.characters.find((c) => c.id === 'xianglins_wife');
    expect(xw).toBeTruthy();
    expect(xw?.appearance).toBeTruthy();
    expect(xw?.aliases).toBeInstanceOf(Array);
    expect(xw?.aliases.length).toBeGreaterThanOrEqual(2);
    expect(xw?.gender).toBe('女');
    expect(xw?.age).toBeTruthy();
    expect(xw?.profession).toBeTruthy();
  });

  it('loads 4 locations', () => {
    const data = mapper.loadProject();
    expect(data.locations).toHaveLength(4);
  });

  it('loads 4 canonical rule declarations with catalog types', () => {
    const data = mapper.loadProject();
    expect(data.ruleDeclarations).toHaveLength(4);
    const ruleIds = data.ruleDeclarations.map((rule) => rule.ruleId).sort();
    expect(ruleIds).toEqual([
      'husbands_authority',
      'patriarchal_clan_authority',
      'religious_authority',
      'widow_purity',
    ]);
    for (const rule of data.ruleDeclarations) {
      expect(data.ruleTypeCatalog.types[rule.typeId]).toBeDefined();
      expect(rule.specifications[rule.initialSpecificationId]).toBeDefined();
    }
  });

  it('loads 6 canonical relationship declarations', () => {
    const data = mapper.loadProject();
    expect(data.relationshipDeclarations).toHaveLength(6);
    expect(
      data.relationshipDeclarations.map((declaration) => declaration.relationshipId).sort(),
    ).toEqual([
      'event_fourth_aunt_xianglins_wife',
      'fourth_master_lu_xianglins_wife',
      'he_laoliu_xianglins_wife',
      'liu_ma_xianglins_wife',
      'mother_in_law_xianglins_wife',
      'narrator_xianglins_wife',
    ]);
  });

  it('loads world initial state with canonical thread declarations and timeAnchors', () => {
    const data = mapper.loadProject();
    expect(data.worldInitialState).toBeTruthy();
    expect(data.worldInitialState?.threads.length).toBeGreaterThanOrEqual(3);
    const threadIds = data.worldInitialState?.threads.map((thread) => thread.threadId);
    expect(threadIds).toContain('T1');
    expect(threadIds).toContain('T2');
    expect(threadIds).toContain('T3');
    expect(data.timeAnchors.length).toBeGreaterThanOrEqual(5);
  });
});

describe('zhu-fu fixture — loadAllEvents', () => {
  const mapper = new EntityMapper(SNAPSHOT);
  const data = mapper.loadProject();

  it('loads 7 authored events with no genesis', () => {
    const events = mapper.loadAllEvents(data);
    expect(events).toHaveLength(7);
    expect(events.some((e) => e.id === 'system:genesis')).toBe(false);
    expect(events.some((e) => e.source === 'genesis')).toBe(false);
  });

  it('E0-E1 are linear, E2-E6 are flashback', () => {
    const events = mapper.loadAllEvents(data);
    const e0 = events.find((e) => e.id === 'E0');
    const e1 = events.find((e) => e.id === 'E1');
    const e2 = events.find((e) => e.id === 'E2');
    const e6 = events.find((e) => e.id === 'E6');

    expect(e0?.sceneType).toBe('linear');
    expect(e1?.sceneType).toBe('linear');
    expect(e2?.sceneType).toBe('flashback');
    expect(e6?.sceneType).toBe('flashback');
  });

  it('E0 has discourseMode, arcPosition, emotionalValence, conflictType', () => {
    const events = mapper.loadAllEvents(data);
    const e0 = events.find((e) => e.id === 'E0');
    expect(e0?.discourseMode).toBe('reflection');
    expect(e0?.arcPosition).toBe('opening');
    expect(e0?.emotionalValence).toBeTruthy();
    expect(e0?.conflictType).toBeTruthy();
  });

  it('maps to NarrativeEvent with all new fields intact', () => {
    const events = data.chapters.get(1)?.events ?? [];
    expect(events.length).toBe(7);

    for (const eventFile of events) {
      const ne = mapper.mapToNarrativeEvent(eventFile);
      expect(ne.id).toBeTruthy();
      expect(ne.sceneBrief).toBeTruthy();
      // New P0 fields should be present
      expect(ne.discourseMode).toBeTruthy();
      expect(ne.arcPosition).toBeTruthy();
    }
  });
});
