import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../../src/index.ts';
import {
  assembleCanonicalNovel,
  assembleCustomNovel,
  MemoryStorage,
  MockPass2Provider,
  PublicationError,
  renderNovel,
  resolveProjectPaths,
} from '../../src/index.ts';

const PROJECT = '/release-assembly-project';

function seedProject(storage: MemoryStorage): void {
  storage.write(
    `${PROJECT}/nova.yaml`,
    'project: release-assembly\nschemaVersion: 1\ntitle: "Release Assembly"\nauthor: "Tester"\ndefaultModel: mock-pass2\n',
  );
  storage.write(
    `${PROJECT}/definitions/state_initial.yaml`,
    'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n',
  );
  storage.write(
    `${PROJECT}/definitions/characters/alice.yaml`,
    'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
  );
  storage.write(
    `${PROJECT}/chapters/chapter_01/_chapter.yaml`,
    'chapter: 1\ntitle: "Opening"\nsummary: "Alice begins."\nintent: "Setup"\nplannedScenes: 1\n',
  );
  storage.write(
    `${PROJECT}/chapters/chapter_01/E001.yaml`,
    'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Opening"\nstoryTime: "day 1"\nsceneBrief: "Alice begins."\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n',
  );
}

function analysis(): AnalysisResult {
  return {
    eventId: 'E001',
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 8,
        maxScore: 10,
        strengths: ['clear'],
        weaknesses: [],
        estimatedWordCount: 80,
      },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      narrativeChecks: [],
      appearanceChecks: [],
      characterReferences: [],
      tenseDetected: 'past',
      conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
      ruleChecks: [],
      knowledgeChecks: [],
    },
  };
}

async function renderAccepted(storage: MemoryStorage): Promise<void> {
  const result = await renderNovel(
    {
      version: 1,
      projectDir: PROJECT,
      selector: { type: 'all' },
      mutation: { operationId: crypto.randomUUID(), actorId: 'renderer' },
      model: 'mock-pass2',
    },
    {
      storage,
      provider: new MockPass2Provider({
        entries: {
          E001: {
            prose: 'Alice entered quietly and closed the door behind her.',
            analysis: analysis(),
          },
        },
      }),
    },
  );
  expect(result.publication.status).toBe('current');
}

describe('release-aware assembly facade', () => {
  it('assembles canonical output from strict accepted heads', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await renderAccepted(storage);

    const result = assembleCanonicalNovel(
      {
        version: 1,
        projectDir: PROJECT,
        mutation: { operationId: crypto.randomUUID(), actorId: 'assembler' },
        title: 'Canonical Title',
      },
      { storage },
    );

    expect(result.publication.status).toBe('current');
    expect(result.sceneCount).toBe(1);
    expect(storage.read(`${PROJECT}/output/novel.md`)).toBe(result.markdown);
    expect(result.markdown).toContain('# Canonical Title');
  });

  it('preserves direct novel edits and writes conflict evidence', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await renderAccepted(storage);
    const paths = resolveProjectPaths(PROJECT);
    const edited = 'User edited canonical bytes.\n';
    storage.write(paths.novelPath, edited);
    const operationId = crypto.randomUUID();

    expect(() =>
      assembleCanonicalNovel(
        {
          version: 1,
          projectDir: PROJECT,
          mutation: { operationId, actorId: 'assembler' },
        },
        { storage },
      ),
    ).toThrow(PublicationError);

    expect(storage.read(paths.novelPath)).toBe(edited);
    expect(storage.read(`${paths.conflictsDir}/novel-${operationId}.md`)).toBe(edited);
  });

  it('writes custom output and terminal operation without changing canonical files', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await renderAccepted(storage);
    const paths = resolveProjectPaths(PROJECT);
    const canonicalNovel = storage.read(paths.novelPath);
    const canonicalManifest = storage.read(paths.publicationPath);
    const operationId = crypto.randomUUID();
    const customPath = `${PROJECT}/exports/editor-copy.md`;

    const result = assembleCustomNovel(
      {
        version: 1,
        projectDir: PROJECT,
        mutation: { operationId, actorId: 'assembler' },
        outputPath: customPath,
        title: 'Editor Copy',
      },
      { storage },
    );

    expect(result.publication.status).toBe('unchanged');
    expect(storage.read(customPath)).toBe(result.markdown);
    expect(storage.read(paths.novelPath)).toBe(canonicalNovel);
    expect(storage.read(paths.publicationPath)).toBe(canonicalManifest);
    expect(JSON.parse(storage.read(`${paths.operationsDir}/${operationId}.json`)).status).toBe(
      'succeeded',
    );
  });

  it('fails closed when a required accepted metadata head is missing', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await renderAccepted(storage);
    storage.remove(`${PROJECT}/scenes/chapter-01/E001.yaml`);

    expect(() =>
      assembleCustomNovel(
        {
          version: 1,
          projectDir: PROJECT,
          mutation: { operationId: crypto.randomUUID(), actorId: 'assembler' },
          outputPath: `${PROJECT}/exports/invalid.md`,
        },
        { storage },
      ),
    ).toThrow(PublicationError);
  });
});
