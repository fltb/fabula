import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { materializeFixtureSnapshot } from '../fixtures/fixture-snapshots.ts';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const fixtureRoots = [
  'zhu-fu',
  'zhu-fu-variants/branch-A',
  'zhu-fu-variants/branch-B',
  'zhu-fu-variants/discourse-reorder',
  'zhu-fu-variants/layer-minimal',
  'zhu-fu-variants/plugin-check',
  'zhu-fu-variants/pov-switch',
  'arcane-aftermath',
  'most-dangerous-game',
  'four-generations',
  'dream-of-red-chamber',
  'david-copperfield',
  'game-dialogue-tree',
  'workbench-authoring',
] as const;

describe('canonical fixture source mapping', () => {
  it.each(fixtureRoots)('%s maps every required catalog and authored event', (fixtureRoot) => {
    const mapper = new EntityMapper(
      materializeFixtureSnapshot(join(repositoryRoot, 'fixtures', fixtureRoot)),
    );

    const data = mapper.loadProject();
    const authoredEvents = [...data.chapters.values()].flatMap((chapter) => chapter.events);
    const mappedById = new Map(mapper.loadAllEvents(data).map((event) => [event.id, event]));

    expect(mappedById).toHaveLength(authoredEvents.length);
    for (const authored of authoredEvents) {
      const mapped = mappedById.get(authored.event);
      if (mapped === undefined) throw new Error(`Missing mapped event ${authored.event}`);
      expect(mapped.threadProgress).toHaveLength(authored.threadProgress?.length ?? 0);
      expect(mapped.relationshipEffects).toHaveLength(authored.relationshipEffects?.length ?? 0);
      expect(mapped.ruleEffects).toHaveLength(authored.ruleEffects?.length ?? 0);
      expect(mapped.knowledgeTransactions ?? []).toHaveLength(
        authored.knowledgeTransactions?.length ?? 0,
      );
    }
  });
});
