// ============================================================================
// P1 verification: zhu-fu fixture loads correctly through EntityMapper
// ============================================================================

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../src/entity/index.js';

const FIXTURE_PATH = path.resolve(
  __dirname, // packages/core/tests
  '..', // packages/core
  '..', // packages
  '..', // root
  'fixtures',
  'zhu-fu',
);

describe('zhu-fu fixture — loadProject', () => {
  const mapper = new EntityMapper(FIXTURE_PATH);

  it('loads project config with genre, synopsis, tense', () => {
    const data = mapper.loadProject();
    expect(data.config).toBeTruthy();
    expect(data.config!.project).toBe('zhu-fu');
    expect(data.config!.title).toBe('祝福');
    expect(data.config!.genre).toBe('literary');
    expect(data.config!.tense).toBe('past');
    expect(data.config!.synopsis).toBeTruthy();
  });

  it('loads 8 characters as array', () => {
    const data = mapper.loadProject();
    expect(data.characters).toHaveLength(8);
    const xw = data.characters.find((c: any) => c.id === 'xianglins_wife');
    expect(xw).toBeTruthy();
    expect(xw!.appearance).toBeTruthy();
    expect(xw!.aliases).toBeInstanceOf(Array);
    expect(xw!.aliases.length).toBeGreaterThanOrEqual(2);
    expect(xw!.gender).toBe('女');
    expect(xw!.age).toBeTruthy();
    expect(xw!.profession).toBeTruthy();
  });

  it('loads 4 locations', () => {
    const data = mapper.loadProject();
    expect(data.locations).toHaveLength(4);
  });

  it('loads 4 rules with ruleClass', () => {
    const data = mapper.loadProject();
    expect(data.rules).toHaveLength(4);
    for (const rule of data.rules) {
      expect(rule.ruleClass).toBeTruthy();
    }
  });

  it('loads 5 relationships', () => {
    const data = mapper.loadProject();
    expect(data.relationships).toHaveLength(5);
  });

  it('loads world initial state with threads and timeAnchors', () => {
    const data = mapper.loadProject();
    expect(data.worldInitialState).toBeTruthy();
    expect(data.worldInitialState!.threads.length).toBeGreaterThanOrEqual(3);
    expect(data.timeAnchors.length).toBeGreaterThanOrEqual(5);
  });
});

describe('zhu-fu fixture — loadAllEvents', () => {
  const mapper = new EntityMapper(FIXTURE_PATH);
  const data = mapper.loadProject();

  it('loads events correctly (7 authored + 1 system:genesis)', () => {
    const events = mapper.loadAllEvents(data.chapters);
    // loadAllEvents includes a system:genesis event, plus our 7 authored events
    expect(events.length).toBe(8);
    const authoredEvents = events.filter((e: any) => e.id !== 'system:genesis');
    expect(authoredEvents).toHaveLength(7);
  });

  it('E0-E1 are linear, E2-E6 are flashback', () => {
    const events = mapper.loadAllEvents(data.chapters);
    const e0 = events.find((e: any) => e.id === 'E0');
    const e1 = events.find((e: any) => e.id === 'E1');
    const e2 = events.find((e: any) => e.id === 'E2');
    const e6 = events.find((e: any) => e.id === 'E6');

    expect(e0?.sceneType).toBe('linear');
    expect(e1?.sceneType).toBe('linear');
    expect(e2?.sceneType).toBe('flashback');
    expect(e6?.sceneType).toBe('flashback');
  });

  it('E0 has discourseMode, arcPosition, emotionalValence, conflictType', () => {
    const events = mapper.loadAllEvents(data.chapters);
    const e0 = events.find((e: any) => e.id === 'E0');
    expect(e0?.discourseMode).toBe('reflection');
    expect(e0?.arcPosition).toBe('opening');
    expect(e0?.emotionalValence).toBeTruthy();
    expect(e0?.conflictType).toBeTruthy();
  });

  it('maps to NarrativeEvent with all new fields intact', () => {
    const events = data.chapters.get(1)?.events ?? [];
    expect(events.length).toBe(7);

    for (const eventFile of events) {
      const ne = mapper.mapToNarrativeEvent(eventFile, [], data.timeAnchors);
      expect(ne.id).toBeTruthy();
      expect(ne.sceneBrief).toBeTruthy();
      // New P0 fields should be present
      expect(ne.discourseMode).toBeTruthy();
      expect(ne.arcPosition).toBeTruthy();
    }
  });
});
