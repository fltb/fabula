import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import { EntityMapper, readYamlFile, readYamlFilesInDir } from '../../src/entity/index.ts';
import { ConfigError } from '../../src/errors.ts';
import { eventFileSchema } from '../../src/schemas/event.ts';
import { characterDefinitionSchema } from '../../src/schemas/index.ts';
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const snapshot = (entries: Record<string, string>): ProjectSourceSnapshotV1 => {
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
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
    sourceHash: hash(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
};

describe('strict YAML compiler', () => {
  it('preserves valid typed YAML and rejects malformed, unknown, and absent required files', () => {
    const source = snapshot({
      'event.yaml': event,
      'malformed.yaml': 'event: [',
      'unknown.yaml': `${event}unsupported: true\n`,
    });
    expect(
      readYamlFile({ logicalPath: 'event.yaml', snapshot: source, schema: eventFileSchema })?.event,
    ).toBe('E1');
    for (const logicalPath of ['malformed.yaml', 'unknown.yaml', 'missing.yaml']) {
      try {
        readYamlFile({ logicalPath, snapshot: source, schema: eventFileSchema });
        throw new Error('expected ConfigError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).code).toBe('CONFIG_INVALID');
        expect((error as ConfigError).context.path).toContain(logicalPath);
      }
    }
  });

  it('maps structured nested YAML timestamps and preserves the story AST for fact validity', () => {
    const source = snapshot({
      'structured.yaml': structuredEvent,
      'indeterminate-anchor.yaml': indeterminateAnchor,
    });
    const parsed = readYamlFile({
      logicalPath: 'structured.yaml',
      schema: eventFileSchema,
      snapshot: source,
    });
    const mapped = new EntityMapper(source).mapToNarrativeEvent(parsed!);
    expect(mapped.storyTime).toEqual({
      type: 'relative',
      anchor: 'arrival',
      offset: { amount: 90, unit: 'minute' },
    });
    expect(mapped.narrationTime).toEqual({ type: 'offset', amount: -1, unit: 'day' });
    expect(mapped.preconditions[0].validity.temporal.start).toBe(mapped.storyTime);
    expect(mapped.postconditions[0].validity.temporal.start).toBe(mapped.storyTime);
    try {
      readYamlFile({
        logicalPath: 'indeterminate-anchor.yaml',
        schema: worldInitialStateSchema,
        snapshot: source,
      });
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).context.path).toContain('indeterminate-anchor.yaml');
      expect((error as ConfigError).context.path).toContain('timeAnchors.0.at');
    }
  });

  it('consumes snapshot bytes and logical paths only — never precomputed parse results', () => {
    const source = snapshot({ 'event.yaml': event });
    // A document marked invalid in parseResult still loads from its bytes.
    const mislabeled: ProjectSourceSnapshotV1 = {
      ...source,
      documents: source.documents.map((document) =>
        document.logicalPath === 'event.yaml'
          ? { ...document, parseResult: { status: 'invalid' as const, value: null } }
          : document,
      ),
    };
    expect(
      readYamlFile({ logicalPath: 'event.yaml', snapshot: mislabeled, schema: eventFileSchema })
        ?.event,
    ).toBe('E1');
    // A document marked parsed but with broken bytes fails — the bytes win.
    const brokenBytes: ProjectSourceSnapshotV1 = {
      ...source,
      documents: source.documents.map((document) =>
        document.logicalPath === 'event.yaml'
          ? {
              ...document,
              content: 'event: [',
              contentHash: hash('event: ['),
              parseResult: { status: 'parsed' as const, value: { value: 'event: [' } },
            }
          : document,
      ),
    };
    expect(() =>
      readYamlFile({ logicalPath: 'event.yaml', snapshot: brokenBytes, schema: eventFileSchema }),
    ).toThrow(ConfigError);
    // The loader is a pure function of snapshot bytes: byte-identical
    // snapshots (distinct objects) yield identical content identity and loads.
    const again = snapshot({ 'event.yaml': event });
    expect(again.sourceHash).toBe(source.sourceHash);
    expect(
      readYamlFile({ logicalPath: 'event.yaml', snapshot: again, schema: eventFileSchema }),
    ).toEqual(
      readYamlFile({ logicalPath: 'event.yaml', snapshot: source, schema: eventFileSchema }),
    );
  });

  it('readYamlFilesInDir reads logical paths and bytes from the snapshot', () => {
    const source = snapshot({
      'definitions/characters/a.yaml':
        'id: a\nname: A\ntype: person\ndescription: a\ninitialState: {}\ntraits: []\n',
      'definitions/characters/b.yaml':
        'id: b\nname: B\ntype: person\ndescription: b\ninitialState: {}\ntraits: []\n',
      'definitions/characters/c.txt': 'id: c\nname: C\n',
    });
    const loaded = readYamlFilesInDir('definitions/characters', characterDefinitionSchema, source);
    expect(loaded.map((character) => character.id)).toEqual(['a', 'b']);
  });
});
