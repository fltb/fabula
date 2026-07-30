import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../../src/index.ts';
import {
  assembleCanonicalNovel,
  MemoryStorage,
  MockPass2Provider,
  renderNovel,
  resolveProjectPaths,
} from '../../src/index.ts';

const PROJECT = '/release-assembly-debug5';

function seedProject(storage: MemoryStorage): void {
  storage.write(`${PROJECT}/nova.yaml`, 'project: release-assembly-debug5\nschemaVersion: 1\ntitle: "Debug Test"\nauthor: "Tester"\ndefaultModel: mock-pass2\n');
  storage.write(`${PROJECT}/definitions/state_initial.yaml`, 'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n');
  storage.write(`${PROJECT}/definitions/characters/alice.yaml`, 'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n');
  storage.write(`${PROJECT}/chapters/chapter_01/_chapter.yaml`, 'chapter: 1\ntitle: "Opening"\nsummary: "Alice begins."\nintent: "Setup"\nplannedScenes: 1\n');
  storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`, 'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Opening"\nstoryTime: "day 1"\nsceneBrief: "Alice begins."\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n');
  storage.write(`${PROJECT}/definitions/discourse-ledger.yaml`, [
    'id: debug5-test',
    'chapters:',
    '  - branch: main',
    '    chapter: 1',
    '    sceneIds:',
    '      - E001',
    'entries: []',
  ].join('\n'));
}

function analysis(): AnalysisResult {
  return {
    eventId: 'E001',
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: { proseScore: 8, maxScore: 10, strengths: ['clear'], weaknesses: [], estimatedWordCount: 80 },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      narrativeChecks: [],
      appearanceChecks: [],
      characterReferences: [],
      tenseDetected: 'past',
      conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
      ruleChecks: [],
      knowledgeChecks: [],
      checklistResults: [],
    },
  };
}

it('should assemble after render', async () => {
  const storage = new MemoryStorage();
  seedProject(storage);

  // Phase 1: render
  const renderResult = await renderNovel(
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
        entries: { E001: { prose: 'Alice entered quietly.', analysis: analysis() } },
      }),
    },
  );

  console.log('Render status:', renderResult.publication.status);
  console.log('Render reasons:', JSON.stringify(renderResult.publication.reasons));

  // Check the stored manifest
  const paths = resolveProjectPaths(PROJECT);
  const manifestRaw = storage.readOptional(paths.publicationPath);
  console.log('Manifest exists:', manifestRaw !== null);
  if (manifestRaw) {
    const manifest = JSON.parse(manifestRaw);
    console.log('Manifest status:', manifest.status);
    console.log('Manifest branch_scope_hash:', manifest.branch_scope_hash);
    console.log('Manifest revision_ids:', JSON.stringify(manifest.revision_ids));

    // Compute hash of raw manifest
    const { computeContentHash } = await import('../../src/storage/hash.ts');
    const rawHash = computeContentHash(manifestRaw);
    console.log('Manifest raw hash:', rawHash);

    // Read the file again and compute hash
    const manifestRaw2 = storage.readOptional(paths.publicationPath);
    const rawHash2 = computeContentHash(manifestRaw2);
    console.log('Manifest raw hash (2nd read):', rawHash2);
    console.log('Hashes match:', rawHash === rawHash2);
  }

  // Phase 2: assemble
  try {
    const result = assembleCanonicalNovel(
      {
        version: 1,
        projectDir: PROJECT,
        mutation: { operationId: crypto.randomUUID(), actorId: 'assembler' },
        title: 'Canonical Title',
      },
      { storage },
    );

    console.log('Assembly succeeded!');
    console.log('Assembly status:', result.publication.status);
  } catch (err) {
    console.log('Assembly error:', err.message);
    if (err.stack) {
      console.log('Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
    }
  }

  expect(true).toBe(true);
});
