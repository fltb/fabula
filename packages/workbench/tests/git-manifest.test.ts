import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AdoptSceneClaim,
  type AuthoringEntry,
  AuthoringManifest,
  adoptClaimFromEnvelope,
  classifyAuthoringPath,
  ManifestValidationError,
  sceneBytesMatchClaim,
  validateAdoptClaim,
} from '../src/host/git/manifest.js';

const utf8 = (content: string): Uint8Array => new TextEncoder().encode(content);
const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');
const yaml = (name: string): string => `${name}: value\n`;
const entry = (
  path: string,
  content = yaml(path),
  mode?: AuthoringEntry['mode'],
): AuthoringEntry => ({
  path,
  bytes: utf8(content),
  mode,
});

const PROSE = '# Scene one\n\nIt began.\n';
const PROSE_HASH = sha256(PROSE);
const claim = (overrides: Partial<AdoptSceneClaim> = {}): AdoptSceneClaim => ({
  eventId: 'scene-one',
  revisionId: '11111111-1111-4111-8111-111111111111',
  proseHash: PROSE_HASH,
  released: true,
  acceptedAt: '2026-08-02T00:00:00.000Z',
  ...overrides,
});

describe('classifyAuthoringPath', () => {
  it('accepts the full canonical authoring topology', () => {
    for (const path of [
      'nova.yaml',
      'definitions/state_initial.yaml',
      'definitions/entity-types.yaml',
      'definitions/discourse-ledger.yaml',
      'definitions/characters/ada.yaml',
      'definitions/locations/harbor/docks.yaml',
      'definitions/items/sword.yaml',
      'definitions/factions/guild.yaml',
      'definitions/relationships/rival.yaml',
      'definitions/rules/magic/nested/deep.yaml',
      'definitions/narrators/omniscient.yaml',
      'definitions/assertions/foreshadow.yaml',
      'chapters/chapter_01/_chapter.yaml',
      'chapters/chapter_01/E1.yaml',
      'chapters/chapter_12/E023.yaml',
    ]) {
      expect(classifyAuthoringPath(path).ok).toBe(true);
    }
  });

  it('rejects runtime, git-internal, traversal, absolute and hidden paths', () => {
    const cases: Array<[string, string]> = [
      ['/etc/passwd', 'absolute-path'],
      ['../escape.yaml', 'traversal-path'],
      ['definitions/characters/../x.yaml', 'traversal-path'],
      ['definitions//x.yaml', 'empty-segment'],
      ['definitions/./x.yaml', 'dot-segment'],
      ['definitions\\characters\\x.yaml', 'backslash-path'],
      ['definitions/characters/\u0001x.yaml', 'control-character'],
      ['.git/config', 'git-internal-path'],
      ['.git/HEAD', 'git-internal-path'],
      ['.nova/cache/data.json', 'nova-runtime-path'],
      ['.gitignore', 'hidden-component'],
      ['.env', 'hidden-component'],
      ['definitions/.hidden.yaml', 'hidden-component'],
      ['', 'empty-path'],
    ];
    for (const [path, code] of cases) {
      const result = classifyAuthoringPath(path);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.code).toBe(code);
    }
  });

  it('rejects non-authoring and unknown file types', () => {
    expect(classifyAuthoringPath('output/novel.md').ok).toBe(false);
    expect(classifyAuthoringPath('notes/reference.md').ok).toBe(false);
    expect(classifyAuthoringPath('cache/foo.bin').ok).toBe(false);
    expect(classifyAuthoringPath('definitions/unknown/foo.yaml').ok).toBe(false);
    expect(classifyAuthoringPath('definitions/characters/foo.yml').ok).toBe(false);
    expect(classifyAuthoringPath('chapters/chapter_1/E1.yaml').ok).toBe(false);
    expect(classifyAuthoringPath('chapters/chapter_01/sub/E1.yaml').ok).toBe(false);
    expect(classifyAuthoringPath('chapters/chapter_01/notes.md').ok).toBe(false);
    expect(classifyAuthoringPath('scenes/../escape.md').ok).toBe(false);
  });
  it('classifies git and nova internals at any depth, not only the first segment', () => {
    expect(classifyAuthoringPath('definitions/characters/.git/config').code).toBe(
      'git-internal-path',
    );
    expect(classifyAuthoringPath('chapters/chapter_01/.nova/cache/x.json').code).toBe(
      'nova-runtime-path',
    );
    expect(classifyAuthoringPath('definitions/.git').code).toBe('git-internal-path');
    expect(classifyAuthoringPath('definitions/.nova.yaml').code).toBe('hidden-component');
  });

  it('rejects sqlite database files as paths and as bytes', () => {
    expect(classifyAuthoringPath('workbench.sqlite').code).toBe('unknown-extension');
    expect(classifyAuthoringPath('data/project.sqlite').code).toBe('unknown-extension');
    expect(classifyAuthoringPath('.nova/workbench.sqlite').code).toBe('nova-runtime-path');
    const sqliteHeader = utf8('SQLite format 3\u0000');
    expect(new AuthoringManifest().checkEntry({ path: 'nova.yaml', bytes: sqliteHeader }).code).toBe(
      'nul-byte',
    );
  });
});

describe('AuthoringManifest byte policy', () => {
  it('rejects CR bytes, NUL bytes and invalid UTF-8', () => {
    const manifest = new AuthoringManifest();
    expect(manifest.checkEntry(entry('nova.yaml', 'project: x\r\n')).code).toBe('carriage-return');
    expect(
      manifest.checkEntry({ path: 'nova.yaml', bytes: new Uint8Array([0x61, 0x00, 0x62]) }).code,
    ).toBe('nul-byte');
    expect(
      manifest.checkEntry({ path: 'nova.yaml', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) }).code,
    ).toBe('invalid-utf8');
  });

  it('rejects symlink and gitlink entries', () => {
    const manifest = new AuthoringManifest();
    expect(manifest.checkEntry(entry('nova.yaml', yaml('nova'), 'symlink')).code).toBe(
      'symlink-entry',
    );
    expect(manifest.checkEntry(entry('nova.yaml', yaml('nova'), 'gitlink')).code).toBe(
      'gitlink-entry',
    );
    expect(manifest.checkEntry(entry('nova.yaml', yaml('nova'), 'executable')).ok).toBe(true);
  });

  it('validates a full authoring set atomically', () => {
    const manifest = new AuthoringManifest();
    expect(() =>
      manifest.validate([
        entry('nova.yaml'),
        entry('definitions/state_initial.yaml'),
        entry('definitions/characters/ada.yaml'),
        entry('chapters/chapter_01/_chapter.yaml'),
        entry('chapters/chapter_01/E1.yaml'),
      ]),
    ).not.toThrow();
    expect(() =>
      manifest.validate([
        entry('nova.yaml'),
        entry('definitions/characters/ada.yaml'),
        entry('.nova/cache/x.json'),
      ]),
    ).toThrow(ManifestValidationError);
  });

  it('rejects unrecognized entry modes with a typed code', () => {
    const manifest = new AuthoringManifest();
    const check = manifest.checkEntry({
      path: 'nova.yaml',
      bytes: utf8(yaml('nova')),
      mode: 'submodule' as unknown as AuthoringEntry['mode'],
    });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.code).toBe('unknown-mode');
  });

  it('rejects duplicate paths within a single manifest set', () => {
    const manifest = new AuthoringManifest();
    const sets: Array<[AuthoringEntry, AuthoringEntry]> = [
      [entry('nova.yaml'), entry('nova.yaml', 'different: value\n')],
      [
        entry('definitions/characters/ada.yaml'),
        entry('definitions/characters/ada.yaml', yaml('ada'), 'executable'),
      ],
    ];
    for (const [first, second] of sets) {
      let thrown: unknown = null;
      try {
        manifest.validate([first, second]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ManifestValidationError);
      if (thrown instanceof ManifestValidationError) {
        expect(thrown.code).toBe('duplicate-path');
        expect(thrown.path).toBe(first.path);
      }
    }
  });
});

describe('AuthoringManifest adopt-scene proof', () => {
  it('rejects new scenes without a proof', () => {
    const manifest = new AuthoringManifest();
    const check = manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.code).toBe('adopt-scene-unproven');
  });

  it('accepts scenes already tracked at the expected head without a proof', () => {
    const manifest = new AuthoringManifest({ pathsInHead: new Set(['scenes/scene-one.md']) });
    expect(manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) }).ok).toBe(true);
  });

  it('does not gate tracked scenes on the validity of a carried adopt claim', () => {
    const manifest = new AuthoringManifest({
      pathsInHead: new Set(['scenes/scene-one.md']),
      adoptClaims: new Map([
        ['scene-one', claim({ eventId: 'stale-event', revisionId: '', proseHash: '0'.repeat(64) })],
      ]),
    });
    expect(manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) }).ok).toBe(true);
  });

  it('accepts a new scene whose bytes match the verified claim', () => {
    const manifest = new AuthoringManifest({ adoptClaims: new Map([['scene-one', claim()]]) });
    expect(manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) }).ok).toBe(true);
  });

  it('rejects a new scene whose bytes differ from the accepted prose', () => {
    const manifest = new AuthoringManifest({ adoptClaims: new Map([['scene-one', claim()]]) });
    const check = manifest.checkEntry({
      path: 'scenes/scene-one.md',
      bytes: utf8('# Different prose\n'),
    });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.code).toBe('adopt-scene-content-mismatch');
  });

  it('rejects a claim whose eventId does not match the scene path', () => {
    const wrong = claim({ eventId: 'other-scene' });
    const manifest = new AuthoringManifest({ adoptClaims: new Map([['scene-one', wrong]]) });
    const check = manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.code).toBe('adopt-claim-event-mismatch');
  });

  it('rejects claims that are not released accepted revisions', () => {
    const unreleased = claim({ released: false });
    expect(validateAdoptClaim(unreleased).ok).toBe(false);
    const manifest = new AuthoringManifest({ adoptClaims: new Map([['scene-one', unreleased]]) });
    const check = manifest.checkEntry({ path: 'scenes/scene-one.md', bytes: utf8(PROSE) });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.code).toBe('adopt-claim-invalid');
  });

  it('rejects malformed claims', () => {
    expect(validateAdoptClaim(claim({ proseHash: 'not-a-hash' })).ok).toBe(false);
    expect(validateAdoptClaim(claim({ eventId: 'has/slash' })).ok).toBe(false);
    expect(validateAdoptClaim(claim({ eventId: '' })).ok).toBe(false);
    expect(validateAdoptClaim(claim({ acceptedAt: '' })).ok).toBe(false);
  });

  it('derives claims from accepted envelopes and verifies byte equality', () => {
    const envelope = {
      eventId: 'scene-one',
      revisionId: '22222222-2222-4222-8222-222222222222',
      proseHash: PROSE_HASH,
      released: true,
      createdAt: '2026-08-02T01:00:00.000Z',
    };
    const derived = adoptClaimFromEnvelope(envelope);
    expect(validateAdoptClaim(derived).ok).toBe(true);
    expect(sceneBytesMatchClaim(utf8(PROSE), derived)).toBe(true);
    expect(sceneBytesMatchClaim(utf8('# tampered\n'), derived)).toBe(false);
  });
});

describe('AuthoringManifest staging surface', () => {
  it('exposes no generic staging API — validation is the only entry point', () => {
    const proto = AuthoringManifest.prototype as unknown as Record<string, unknown>;
    for (const name of ['stage', 'stageAll', 'add', 'addAll', 'updateIndex', 'writeTree', 'commit']) {
      expect(proto[name]).toBeUndefined();
    }
  });
});
