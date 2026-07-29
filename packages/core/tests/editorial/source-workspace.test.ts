// ============================================================================
// SourceWorkspace — registry, preview, apply, reconcile tests
//
// All tests use MemoryStorage with configured paths and deterministic data.
// No live LLM, filesystem, or network access.
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { Storage } from '../../src/storage/types.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import {
  OverlayStorage,
  SourceWorkspace,
  resolveProjectPaths,
  stableJson,
} from '../../src/editorial/index.ts';
import type {
  SourceChangePreviewV1,
  SourceChangeResultV1,
  SourceChangeSetV1,
  SourceDocumentV1,
} from '../../src/types/editorial.ts';
import type { ProjectPaths } from '../../src/editorial/paths.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

const TEST_PROJECT = '/test-project';

function makePaths(): ProjectPaths {
  return resolveProjectPaths(TEST_PROJECT);
}

function makeWorkspace(storage?: Storage): SourceWorkspace {
  const s = storage ?? new MemoryStorage();
  return new SourceWorkspace(s, makePaths());
}

/** Seed a realistic project layout in MemoryStorage with YAML-like content. */
function seedRealisticProject(storage: MemoryStorage): SourceWorkspace {
  const p = TEST_PROJECT;

  // nova.yaml — project: required
  storage.write(`${p}/nova.yaml`, 'project: test\nschemaVersion: 1\ntitle: "Test"\nauthor: "Tester"\n');

  // state_initial.yaml
  storage.write(`${p}/definitions/state_initial.yaml`,
    'info:\n  currentEra: "modern"\n  politicalSituation: "peace"\nthreads: []\nworldFacts: []\n');

  // Characters
  storage.mkdirp(`${p}/definitions/characters`);
  storage.write(`${p}/definitions/characters/alice.yaml`,
    'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n');
  storage.write(`${p}/definitions/characters/bob.yaml`,
    'id: bob\nname: "Bob"\ntype: human\ndescription: "Friend"\ninitialState: {}\ntraits: []\n');

  // Locations
  storage.mkdirp(`${p}/definitions/locations`);
  storage.write(`${p}/definitions/locations/woods.yaml`,
    'id: woods\nname: "Dark Forest"\nkind: forest\ndescription: "A dark forest"\ninitialState: {}\n');

  // Items
  storage.mkdirp(`${p}/definitions/items`);
  storage.write(`${p}/definitions/items/key.yaml`,
    'id: key\nname: "Golden Key"\nkind: key\ndescription: "A key"\ninitialState: {}\n');

  // Factions
  storage.mkdirp(`${p}/definitions/factions`);
  storage.write(`${p}/definitions/factions/guild.yaml`,
    'id: guild\nname: "Writers Guild"\nkind: guild\ndescription: "A guild"\ninitialState: {}\n');

  // Relationships
  storage.mkdirp(`${p}/definitions/relationships`);
  storage.write(`${p}/definitions/relationships/friendship.yaml`,
    'id: friendship\ntype: ally\nparticipants:\n  - alice\n  - bob\nbidirectional: true\ninitialState:\n  trust: 50\n  emotionalDistance: 20\n  intensity: 40\n  status: active\n');

  // Rules
  storage.mkdirp(`${p}/definitions/rules`);
  storage.write(`${p}/definitions/rules/magic.yaml`,
    'ruleId: magic\nname: "Magic Rule"\ncategory: magic\ntype: constraint\nstatement: "Magic is unavailable."\nlogicalConsequences: []\nevidenceChain: []\n');

  // Narrators — needs proper discriminated union
  storage.mkdirp(`${p}/definitions/narrators`);
  storage.write(`${p}/definitions/narrators/omni.yaml`,
    'id: omni\ntype: omniscient\naccess: full\nassertion: full\ntruth: full_knowledge\nfidelity: reliable\nsincerity: sincere\nautoReveal: false\n');

  // Assertions
  storage.mkdirp(`${p}/definitions/assertions`);
  storage.write(`${p}/definitions/assertions/fact1.yaml`,
    'id: fact1\nnarrator: omni\nproposition: "alice is the protagonist"\npolarity: affirmative\ntype: authoritative_reveal\ntruthBoundary: true\nnarrationBoundary:\n  narratorId: omni\n');

  // Discourse ledger — id is required
  storage.write(`${p}/definitions/discourse-ledger.yaml`,
    'id: default\nentries: []\nhash: fixture\n');

  // Chapter 01
  storage.mkdirp(`${p}/chapters/chapter_01`);
  storage.write(`${p}/chapters/chapter_01/_chapter.yaml`,
    'chapter: 1\ntitle: "The Beginning"\nsummary: "Alice enters the forest."\nintent: "Setup"\nplannedScenes: 2\n');
  storage.write(`${p}/chapters/chapter_01/E001.yaml`,
    'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Alice enters the woods"\nstoryTime: "day 1"\nsceneBrief: "Alice walks into the dark forest"\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n');
  storage.write(`${p}/chapters/chapter_01/E002.yaml`,
    'event: E002\nformatVersion: 1\nnarrativeOrder: 2\ntitle: "Alice finds the key"\nstoryTime: "day 1"\nsceneBrief: "Alice discovers a golden key"\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n');

  // Chapter 02 (metadata only)
  storage.mkdirp(`${p}/chapters/chapter_02`);
  storage.write(`${p}/chapters/chapter_02/_chapter.yaml`,
    'chapter: 2\ntitle: "The Forest"\nsummary: "The journey continues."\nintent: "Development"\nplannedScenes: 0\n');

  return makeWorkspace(storage);
}

/** Set up workspace with a source head by making a no-op apply. */
function seedWithHead(storage: MemoryStorage): SourceWorkspace {
  const ws = seedRealisticProject(storage);
  const projHash = computeProjectHash(ws);

  const changeSet: SourceChangeSetV1 = {
    version: 1,
    expectedProjectSourceHash: projHash,
    changes: [
      {
        type: 'put',
        path: 'definitions/characters/alice.yaml',
        expectedHash: (ws.get('definitions/characters/alice.yaml') as SourceDocumentV1).contentHash,
        content: 'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
      },
    ],
  };

  const preview = ws.preview(changeSet);
  ws.apply(changeSet, preview.previewToken, { operationId: uuid(), actorId: 'test' });
  return ws;
}

/** Compute the project hash from a workspace's current state. */
function computeProjectHash(ws: SourceWorkspace): string {
  const docs = ws.list();
  const hashes: Record<string, string> = {};
  for (const d of docs) hashes[d.path] = d.contentHash;
  const sorted = Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b));
  const h = crypto.createHash('sha256');
  for (const [p, hsh] of sorted) {
    h.update(`${p}\0${hsh}\0`);
  }
  return h.digest('hex');
}

// ─── Source Path Registry & Validation ──────────────────────────────────────

describe('SourceWorkspace — path registry', () => {
  it('resolves kind for every known path kind', () => {
    const ws = makeWorkspace();
    const cases: Array<[string, string]> = [
      ['nova.yaml', 'project'],
      ['definitions/state_initial.yaml', 'initial_state'],
      ['definitions/characters/foo.yaml', 'character'],
      ['definitions/locations/bar.yaml', 'location'],
      ['definitions/items/baz.yaml', 'item'],
      ['definitions/factions/xyz.yaml', 'faction'],
      ['definitions/relationships/r.yaml', 'relationship'],
      ['definitions/rules/r.yaml', 'rule'],
      ['definitions/narrators/n.yaml', 'narrator'],
      ['definitions/assertions/a.yaml', 'assertion'],
      ['definitions/discourse-ledger.yaml', 'discourse_ledger'],
      ['chapters/chapter_01/_chapter.yaml', 'chapter'],
      ['chapters/chapter_01/E001.yaml', 'event'],
    ];
    for (const [p, expected] of cases) {
      expect(ws.resolveKind(p)).toBe(expected);
    }
  });

  it('rejects unrecognised paths', () => {
    const ws = makeWorkspace();
    expect(ws.resolveKind('random/file.txt')).toBeNull();
    expect(ws.resolveKind('other/data.yaml')).toBeNull();
    expect(ws.resolveKind('')).toBeNull();
  });

  it('accepts known relative paths', () => {
    const ws = makeWorkspace();
    expect(ws.isValidSourcePath('nova.yaml')).toBe(true);
    expect(ws.isValidSourcePath('definitions/characters/foo.yaml')).toBe(true);
    expect(ws.isValidSourcePath('chapters/chapter_01/E001.yaml')).toBe(true);
  });

  it('rejects absolute paths', () => {
    const ws = makeWorkspace(new MemoryStorage());
    expect(ws.isValidSourcePath('/etc/passwd')).toBe(false);
    expect(ws.isValidSourcePath('/nova.yaml')).toBe(false);
  });

  it('rejects traversal', () => {
    const ws = makeWorkspace();
    expect(ws.isValidSourcePath('../other/config.yaml')).toBe(false);
    expect(ws.isValidSourcePath('definitions/../../../etc/passwd')).toBe(false);
  });

  it('rejects unrecognised paths', () => {
    const ws = makeWorkspace();
    expect(ws.isValidSourcePath('some/random.yaml')).toBe(false);
    expect(ws.isValidSourcePath('backups/nova.bak')).toBe(false);
  });

  it('matches only .yaml/.yml files in directory globs', () => {
    const ws = makeWorkspace();
    expect(ws.isValidSourcePath('definitions/characters/foo.yaml')).toBe(true);
    expect(ws.isValidSourcePath('definitions/characters/foo.yml')).toBe(true);
    expect(ws.isValidSourcePath('definitions/characters/foo.json')).toBe(false);
    expect(ws.isValidSourcePath('definitions/characters/foo')).toBe(false);
  });

  it('requires exact chapter_NN source topology', () => {
    const ws = makeWorkspace();
    expect(ws.isValidSourcePath('chapters/chapter_1/E001.yaml')).toBe(false);
    expect(ws.isValidSourcePath('chapters/other/E001.yaml')).toBe(false);
    expect(ws.isValidSourcePath('chapters/chapter_01/E001.yaml')).toBe(true);
  });

  it('rejects resolved paths outside the project root without prefix confusion', () => {
    class EscapingStorage extends MemoryStorage {
      override resolvePath(filePath: string): string {
        if (filePath.endsWith('/nova.yaml')) return '/test-project-escape/nova.yaml';
        return super.resolvePath(filePath);
      }
    }
    const ws = makeWorkspace(new EscapingStorage());
    expect(ws.isValidSourcePath('nova.yaml')).toBe(false);
  });
});

// ─── List & Get Documents ───────────────────────────────────────────────────

describe('SourceWorkspace — list & get', () => {
  it('lists documents from a seeded project', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const paths = ws.list().map((d) => d.path);
    const expected = [
      'chapters/chapter_01/E001.yaml',
      'chapters/chapter_01/E002.yaml',
      'chapters/chapter_01/_chapter.yaml',
      'chapters/chapter_02/_chapter.yaml',
      'definitions/assertions/fact1.yaml',
      'definitions/characters/alice.yaml',
      'definitions/characters/bob.yaml',
      'definitions/discourse-ledger.yaml',
      'definitions/factions/guild.yaml',
      'definitions/items/key.yaml',
      'definitions/locations/woods.yaml',
      'definitions/narrators/omni.yaml',
      'definitions/relationships/friendship.yaml',
      'definitions/rules/magic.yaml',
      'definitions/state_initial.yaml',
      'nova.yaml',
    ];
    for (const e of expected) {
      expect(paths).toContain(e);
    }
  });

  it('returns sorted documents', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const paths = ws.list().map((d) => d.path);
    for (let i = 1; i < paths.length; i++) {
      expect(paths[i - 1].localeCompare(paths[i])).toBeLessThanOrEqual(0);
    }
  });

  it('each document has valid fields', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    for (const doc of ws.list()) {
      expect(doc.version).toBe(1);
      expect(typeof doc.path).toBe('string');
      expect(typeof doc.content).toBe('string');
      expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof doc.kind).toBe('string');
      expect(Array.isArray(doc.diagnostics)).toBe(true);
      expect(typeof doc.tracked).toBe('boolean');
    }
  });

  it('get returns a document by relative path', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const doc = ws.get('nova.yaml');
    expect(doc).not.toBeNull();
    expect(doc!.path).toBe('nova.yaml');
    expect(doc!.kind).toBe('project');
  });

  it('get returns null for missing path', () => {
    const ws = makeWorkspace();
    expect(ws.get('nonexistent.yaml')).toBeNull();
  });

  it('get returns null for unrecognised path kind', () => {
    const ws = makeWorkspace();
    expect(ws.get('random/thing.txt')).toBeNull();
  });

  it('list is empty for empty project', () => {
    const ws = makeWorkspace();
    expect(ws.list()).toEqual([]);
  });

  it('lists recursive definition documents', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    storage.write(
      `${TEST_PROJECT}/definitions/characters/cast/support/cara.yaml`,
      'id: cara\nname: "Cara"\ntype: human\ndescription: "Support"\ninitialState: {}\ntraits: []\n',
    );
    expect(ws.list().map((document) => document.path)).toContain(
      'definitions/characters/cast/support/cara.yaml',
    );
  });

  it('returns raw invalid YAML with null parsedValue and diagnostics', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    storage.write(`${TEST_PROJECT}/definitions/characters/alice.yaml`, '{ broken: [[\n');
    const document = ws.get('definitions/characters/alice.yaml')!;
    expect(document.content).toBe('{ broken: [[\n');
    expect(document.parsedValue).toBeNull();
    expect(document.diagnostics.length).toBeGreaterThan(0);
  });
});

// ─── Preview ────────────────────────────────────────────────────────────────

describe('SourceWorkspace — preview', () => {
  it('produces a valid preview for a put change', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/bob.yaml',
          expectedHash: aliceDoc.contentHash.replace(/^./, '0'), // intentionally wrong to test CAS
        },
      ],
    };
    // Needs existing hash for CAS check
    const cs2: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/bob.yaml',
          expectedHash: (ws.get('definitions/characters/bob.yaml') as SourceDocumentV1).contentHash,
          content: 'id: bob\nname: "Bobby"\ntype: human\ndescription: "Friend"\ninitialState: {}\ntraits: []\n',
        },
      ],
    };

    const preview = ws.preview(cs2);
    expect(preview.version).toBe(1);
    expect(preview.changeSet).toEqual(cs2);
    expect(preview.previewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.documents).toHaveLength(1);
    expect(preview.documents[0].path).toBe('definitions/characters/bob.yaml');
    expect(preview.documents[0].beforeContent).toContain('Bob');
    expect(preview.documents[0].afterContent).toContain('Bobby');
    expect(preview.validation.valid).toBe(true);
    expect(preview.validation.errors).toEqual([]);
  });

  it('produces a valid preview for a new file (null expectedHash)', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/newchar.yaml',
          expectedHash: null,
          content: 'id: newchar\nname: "New"\ntraits: []\n',
        },
      ],
    };

    const preview = ws.preview(changeSet);
    expect(preview.documents[0].beforeContent).toBeNull();
    expect(preview.documents[0].afterContent).toContain('New');
  });

  it('produces a valid preview for a delete change', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        { type: 'delete', path: 'definitions/characters/alice.yaml', expectedHash: aliceDoc.contentHash },
      ],
    };

    const preview = ws.preview(changeSet);
    expect(preview.documents).toHaveLength(1);
    expect(preview.documents[0].afterContent).toBeNull();
  });

  it('zero-write — preview does not modify storage', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;
    const beforeContent = storage.read(`${TEST_PROJECT}/definitions/characters/alice.yaml`);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/alice.yaml',
          expectedHash: aliceDoc.contentHash,
          content: 'id: alice\nname: "Alice Modified"\ntraits: []\n',
        },
      ],
    };

    ws.preview(changeSet);
    expect(storage.read(`${TEST_PROJECT}/definitions/characters/alice.yaml`)).toBe(beforeContent);
  });

  it('rejects preview with CAS mismatch on put', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/alice.yaml',
          expectedHash: sha256Hex(),
          content: 'id: alice\nname: "Hacked"\ntraits: []\n',
        },
      ],
    };

    expect(() => ws.preview(changeSet)).toThrow(/CAS mismatch/);
  });

  it('rejects preview with CAS mismatch on delete', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        { type: 'delete', path: 'definitions/characters/alice.yaml', expectedHash: sha256Hex() },
      ],
    };

    expect(() => ws.preview(changeSet)).toThrow(/CAS mismatch/);
  });

  it('rejects preview with mismatched project hash', () => {
    const ws = seedRealisticProject(new MemoryStorage());

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: sha256Hex(),
      changes: [
        { type: 'put', path: 'definitions/characters/bob.yaml', expectedHash: null, content: 'id: bob\n' },
      ],
    };

    expect(() => ws.preview(changeSet)).toThrow(/expected project hash/i);
  });

  it('rejects preview for non-existent delete target', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [{ type: 'delete', path: 'definitions/characters/nope.yaml', expectedHash: sha256Hex() }],
    };

    expect(() => ws.preview(changeSet)).toThrow(/non-existent/i);
  });

  it('preview token is deterministic', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        { type: 'put', path: 'definitions/characters/bob.yaml', expectedHash: (ws.get('definitions/characters/bob.yaml') as SourceDocumentV1).contentHash, content: 'id: bob\nname: "Bobby"\n' },
      ],
    };

    const p1 = ws.preview(changeSet);
    const p2 = ws.preview(changeSet);
    expect(p1.previewToken).toBe(p2.previewToken);
  });
});

// ─── OverlayStorage ──────────────────────────────────────────────────────────

describe('OverlayStorage', () => {
  it('reads from base when no overlay is set', () => {
    const base = new MemoryStorage();
    base.write('/p/nova.yaml', 'title: Test\n');
    const overlay = new OverlayStorage(base);
    expect(overlay.exists('/p/nova.yaml')).toBe(true);
    expect(overlay.read('/p/nova.yaml')).toBe('title: Test\n');
  });

  it('overlay takes precedence over base', () => {
    const base = new MemoryStorage();
    base.write('/p/nova.yaml', 'title: Original\n');
    const overlay = new OverlayStorage(base);
    overlay.setOverlay('/p/nova.yaml', 'title: Modified\n');
    expect(overlay.read('/p/nova.yaml')).toBe('title: Modified\n');
  });

  it('overlay deletion masks base content', () => {
    const base = new MemoryStorage();
    base.write('/p/nova.yaml', 'title: Test\n');
    const overlay = new OverlayStorage(base);
    overlay.setOverlay('/p/nova.yaml', null);
    expect(overlay.exists('/p/nova.yaml')).toBe(false);
    expect(overlay.readOptional('/p/nova.yaml')).toBeNull();
  });

  it('listOverlay returns overlay-only entries', () => {
    const base = new MemoryStorage();
    const overlay = new OverlayStorage(base);
    overlay.setOverlay('/p/characters/bob.yaml', 'id: bob\n');
    const docs = overlay.listOverlay();
    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe('/p/characters/bob.yaml');
    expect(docs[0].tracked).toBe(true);
    expect(docs[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('get returns document from overlay', () => {
    const base = new MemoryStorage();
    base.write('/p/nova.yaml', 'title: Test\n');
    const overlay = new OverlayStorage(base);
    overlay.setOverlay('/p/nova.yaml', 'title: Modified\n');
    const doc = overlay.get('/p/nova.yaml');
    expect(doc.path).toBe('/p/nova.yaml');
    expect(doc.content).toBe('title: Modified\n');
    expect(doc.tracked).toBe(true);
  });

  it('get returns document from base when not overlaid', () => {
    const base = new MemoryStorage();
    base.write('/p/nova.yaml', 'title: Test\n');
    const overlay = new OverlayStorage(base);
    const doc = overlay.get('/p/nova.yaml');
    expect(doc.content).toBe('title: Test\n');
    expect(doc.tracked).toBe(false);
  });

  it('listFiles includes overlaid files', () => {
    const base = new MemoryStorage();
    base.mkdirp('/p/characters');
    base.write('/p/characters/alice.yaml', 'id: alice\n');
    const overlay = new OverlayStorage(base);
    overlay.setOverlay('/p/characters/bob.yaml', 'id: bob\n');
    const files = overlay.listFiles('/p/characters');
    expect(files).toContain('alice.yaml');
    expect(files).toContain('bob.yaml');
  });

  it('clearOverlay removes a single entry', () => {
    const overlay = new OverlayStorage(new MemoryStorage());
    overlay.setOverlay('/p/nova.yaml', 'modified');
    expect(overlay.isOverlaid('/p/nova.yaml')).toBe(true);
    overlay.clearOverlay('/p/nova.yaml');
    expect(overlay.isOverlaid('/p/nova.yaml')).toBe(false);
  });

  it('clearAll removes all overlay entries', () => {
    const overlay = new OverlayStorage(new MemoryStorage());
    overlay.setOverlay('/p/a.yaml', 'a');
    overlay.setOverlay('/p/b.yaml', 'b');
    expect(overlay.overlayPaths()).toHaveLength(2);
    overlay.clearAll();
    expect(overlay.overlayPaths()).toHaveLength(0);
  });

  it('resolvePath delegates to base', () => {
    const base = new MemoryStorage();
    const overlay = new OverlayStorage(base);
    expect(overlay.resolvePath('/p/nova.yaml')).toBe('/p/nova.yaml');
  });
});

// ─── Apply ───────────────────────────────────────────────────────────────────

describe('SourceWorkspace — apply', () => {
  it('applies a change set atomically', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/alice.yaml',
          expectedHash: aliceDoc.contentHash,
          content: 'id: alice\nname: "Alice Updated"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
        },
      ],
    };

    const preview = ws.preview(changeSet);
    expect(preview.validation.valid).toBe(true);

    const opId = uuid();
    const result = ws.apply(changeSet, preview.previewToken, { operationId: opId, actorId: 'test-actor' });

    expect(result.operationId).toBe(opId);
    expect(result.sourceRevisionId).toBeTypeOf('string');
    expect(result.projectSourceHash).toBeTypeOf('string');
    expect(result.changedDocuments).toHaveLength(1);
    expect(result.changedDocuments[0].path).toBe('definitions/characters/alice.yaml');

    // Publication stale
    expect(result.publication.status).toBe('stale');

    // Storage effects
    expect(storage.exists(`${TEST_PROJECT}/.nova/revisions/sources/${result.sourceRevisionId}.json`)).toBe(true);
    expect(storage.exists(`${TEST_PROJECT}/.nova/source-head.json`)).toBe(true);

    const head = JSON.parse(storage.read(`${TEST_PROJECT}/.nova/source-head.json`));
    expect(head.version).toBe(1);
    expect(head.revisionId).toBe(result.sourceRevisionId);

    // File content changed
    const content = storage.read(`${TEST_PROJECT}/definitions/characters/alice.yaml`);
    expect(content).toContain('Alice Updated');
  });

  it('rejects apply with wrong preview token', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        { type: 'put', path: 'definitions/characters/bob.yaml', expectedHash: (ws.get('definitions/characters/bob.yaml') as SourceDocumentV1).contentHash, content: 'id: bob\n' },
      ],
    };

    expect(() => ws.apply(changeSet, sha256Hex(), { operationId: uuid(), actorId: 't' })).toThrow(/preview token/i);
  });

  it('rejects apply when compilation errors exist', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/alice.yaml',
          expectedHash: aliceDoc.contentHash,
          content: '{bad: yaml: [[[invalid}\n',
        },
      ],
    };

    // EntityMapper will fail to parse this
    expect(() => ws.apply(changeSet, computeContentHash(stableJson(changeSet)), { operationId: uuid(), actorId: 't' }))
      .toThrow();
  });

  it('does not modify storage on failed apply', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const projHash = computeProjectHash(ws);

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        { type: 'put', path: 'definitions/characters/bob.yaml', expectedHash: (ws.get('definitions/characters/bob.yaml') as SourceDocumentV1).contentHash, content: 'id: bob\n' },
      ],
    };

    // Wrong preview token
    expect(() => ws.apply(changeSet, sha256Hex(), { operationId: uuid(), actorId: 't' })).toThrow();
    // Storage should be unchanged
    expect(storage.read(`${TEST_PROJECT}/definitions/characters/alice.yaml`)).toContain('Alice');
  });

  it('rejects create-only put when the source file already exists', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: computeProjectHash(ws),
      changes: [{
        type: 'put',
        path: 'definitions/characters/alice.yaml',
        expectedHash: null,
        content: (ws.get('definitions/characters/alice.yaml')!).content,
      }],
    };
    expect(() => ws.preview(changeSet)).toThrow(/create-only/i);
  });

  it('creates a baseline parent and returns the stored result idempotently', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const current = ws.get('definitions/characters/alice.yaml')!;
    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: computeProjectHash(ws),
      changes: [{
        type: 'put',
        path: current.path,
        expectedHash: current.contentHash,
        content: current.content.replace('Alice', 'Alicia'),
      }],
    };
    const preview = ws.preview(changeSet);
    const mutation = { operationId: uuid(), actorId: 'editor' };
    const first = ws.apply(changeSet, preview.previewToken, mutation);
    const second = ws.apply(changeSet, preview.previewToken, mutation);
    expect(second).toEqual(first);

    const revisions = storage
      .listFiles(`${TEST_PROJECT}/.nova/revisions/sources`)
      .map((file) =>
        JSON.parse(storage.read(`${TEST_PROJECT}/.nova/revisions/sources/${file}`)),
      );
    expect(revisions).toHaveLength(2);
    const applied = revisions.find((revision) => revision.revisionId === first.sourceRevisionId);
    const baseline = revisions.find((revision) => revision.origin === 'external_edit');
    expect(applied.parentRevisionId).toBe(baseline.revisionId);
    const tracked = ws.get(current.path)!;
    expect(tracked.tracked).toBe(true);
    expect(tracked.sourceRevisionId).toBe(first.sourceRevisionId);
  });
});

// ─── Reconcile ───────────────────────────────────────────────────────────────

describe('SourceWorkspace — reconcile', () => {
  it('records a terminal no-op when the tracked project is unchanged', () => {
    const storage = new MemoryStorage();
    const ws = seedWithHead(storage);
    const operationId = uuid();
    const result = ws.reconcile({ operationId, actorId: 'reconciler' });
    expect(result).toBeNull();
    expect(storage.exists(`${TEST_PROJECT}/.nova/operations/${operationId}.json`)).toBe(true);
  });

  it('detects valid external edit and accepts it', () => {
    const storage = new MemoryStorage();
    const ws = seedWithHead(storage);

    // Simulate external edit
    storage.write(`${TEST_PROJECT}/definitions/characters/alice.yaml`,
      'id: alice\nname: "Alice Ext"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n');

    const result = ws.reconcile({ operationId: uuid(), actorId: 'reconciler' });
    expect(result).not.toBeNull();
    expect(result!.changedDocuments).toHaveLength(1);
    expect(result!.changedDocuments[0].path).toBe('definitions/characters/alice.yaml');

    // Head updated
    const head = JSON.parse(storage.read(`${TEST_PROJECT}/.nova/source-head.json`));
    expect(head.documents['definitions/characters/alice.yaml']).toBe(
      computeContentHash('id: alice\nname: "Alice Ext"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n'),
    );
  });

  it('reports invalid external edit without writing', () => {
    const storage = new MemoryStorage();
    const ws = seedWithHead(storage);

    // Invalid YAML
    storage.write(`${TEST_PROJECT}/definitions/characters/alice.yaml`,
      '{ invalid: yaml: [[bad }\n');

    const headBefore = storage.read(`${TEST_PROJECT}/.nova/source-head.json`);
    expect(() =>
      ws.reconcile({ operationId: uuid(), actorId: 'reconciler' }),
    ).toThrow(/invalid/i);
    expect(storage.read(`${TEST_PROJECT}/.nova/source-head.json`)).toBe(headBefore);
  });

  it('creates an external-edit baseline when no source head exists', () => {
    const storage = new MemoryStorage();
    const ws = seedRealisticProject(storage);
    const result = ws.reconcile({ operationId: uuid(), actorId: 'reconciler' });
    expect(result).not.toBeNull();
    expect(result!.changedDocuments.length).toBeGreaterThan(0);
    expect(storage.exists(`${TEST_PROJECT}/.nova/source-head.json`)).toBe(true);
  });
});

// ─── Impact Sets ────────────────────────────────────────────────────────────

describe('SourceWorkspace — impact sets', () => {
  it('identifies affected event IDs when events change', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);
    const e001Doc = ws.get('chapters/chapter_01/E001.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'chapters/chapter_01/E001.yaml',
          expectedHash: e001Doc.contentHash,
          content: 'id: E001\nsummary: "Modified"\nscenes: []\neventType: scene\n',
        },
      ],
    };

    const preview = ws.preview(changeSet);
    expect(preview.affectedEventIds).toContain('E001');
  });

  it('marks every authored event affected by a definition change', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const projHash = computeProjectHash(ws);
    const aliceDoc = ws.get('definitions/characters/alice.yaml') as SourceDocumentV1;

    const changeSet: SourceChangeSetV1 = {
      version: 1,
      expectedProjectSourceHash: projHash,
      changes: [
        {
          type: 'put',
          path: 'definitions/characters/alice.yaml',
          expectedHash: aliceDoc.contentHash,
          content: 'id: alice\nname: "Alice Mod"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
        },
      ],
    };

    const preview = ws.preview(changeSet);
    expect(preview.affectedEventIds).toEqual(['E001', 'E002']);
  });
});

// ─── Exact Formatting ───────────────────────────────────────────────────────

describe('SourceWorkspace — exact formatting', () => {
  it('stableJson produces consistent output', () => {
    const obj = { b: 2, a: 1, c: [3, 1, 2] };
    expect(stableJson(obj)).toBe(stableJson(obj));
  });

  it('content hash is always sha256 hex', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    for (const doc of ws.list()) {
      expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('SourceDocumentV1 has exact shape', () => {
    const ws = seedRealisticProject(new MemoryStorage());
    const doc = ws.get('nova.yaml') as SourceDocumentV1;
    expect(Object.keys(doc).sort()).toEqual([
      'content', 'contentHash', 'diagnostics', 'kind', 'parsedValue', 'path', 'sourceRevisionId', 'tracked', 'version',
    ]);
  });
});
