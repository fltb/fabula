import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityMapper, readYamlFile } from '../../src/entity/index.ts';
import { ConfigError } from '../../src/errors.ts';
import { eventFileSchema } from '../../src/schemas/event.ts';
import { worldInitialStateSchema } from '../../src/schemas/state-initial.ts';

const event = `event: E1\nnarrativeOrder: 1\ntitle: Test\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: test\nbeats:\n  - test\npreconditions: []\nexpectedPostconditions: []\n`;
const structuredEvent = `event: E2
narrativeOrder: 2
title: Structured timestamp
storyTime:
  after:
    ref: arrival
    amount: 90
    unit: minute
narrationTime:
  offset:
    amount: -1
    unit: day
pov:
  character: narrator
  type: first_person
sceneBrief: test
beats:
  - test
preconditions:
  - entity: hero
    attribute: location
    value: gate
expectedPostconditions:
  - entity: hero
    attribute: location
    value: road
`;

const indeterminateAnchor = `info:
  currentEra: test
  politicalSituation: test
timeAnchors:
  - id: unknowable
    at:
      type: indeterminate
threads: []
worldFacts: []
`;

describe('strict YAML compiler', () => {
  it('preserves valid typed YAML and rejects malformed, unknown, and absent required files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-yaml-'));
    const valid = join(dir, 'event.yaml');
    const malformed = join(dir, 'malformed.yaml');
    const unknown = join(dir, 'unknown.yaml');
    try {
      writeFileSync(valid, event);
      writeFileSync(malformed, 'event: [');
      writeFileSync(unknown, `${event}unsupported: true\n`);
      expect(readYamlFile({ filePath: valid, schema: eventFileSchema })?.event).toBe('E1');
      for (const path of [malformed, unknown, join(dir, 'missing.yaml')]) {
        try {
          readYamlFile({ filePath: path, schema: eventFileSchema });
          throw new Error('expected ConfigError');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).code).toBe('CONFIG_INVALID');
          expect((error as ConfigError).context.path).toContain(path);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps structured nested YAML timestamps and preserves the story AST for fact validity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-yaml-'));
    const structured = join(dir, 'structured.yaml');
    const invalidAnchor = join(dir, 'indeterminate-anchor.yaml');
    try {
      writeFileSync(structured, structuredEvent);
      writeFileSync(invalidAnchor, indeterminateAnchor);

      const parsed = readYamlFile({ filePath: structured, schema: eventFileSchema });
      const mapped = new EntityMapper(dir).mapToNarrativeEvent(parsed!);
      expect(mapped.storyTime).toEqual({
        type: 'relative',
        anchor: 'arrival',
        offset: { amount: 90, unit: 'minute' },
      });
      expect(mapped.narrationTime).toEqual({ type: 'offset', amount: -1, unit: 'day' });
      expect(mapped.preconditions[0].validity.temporal.start).toBe(mapped.storyTime);
      expect(mapped.postconditions[0].validity.temporal.start).toBe(mapped.storyTime);

      try {
        readYamlFile({ filePath: invalidAnchor, schema: worldInitialStateSchema });
        throw new Error('expected ConfigError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).context.path).toContain(invalidAnchor);
        expect((error as ConfigError).context.path).toContain('timeAnchors.0.at');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
