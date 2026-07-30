import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../../src/index.ts';
import {
  MemoryStorage,
  MockPass2Provider,
  renderNovel,
} from '../../src/index.ts';

const PROJECT = '/release-assembly-debug';

function seedProject(storage: MemoryStorage): void {
  storage.write(`${PROJECT}/nova.yaml`, 'project: release-assembly-debug\nschemaVersion: 1\ntitle: "Debug Test"\nauthor: "Tester"\ndefaultModel: mock-pass2\n');
  storage.write(`${PROJECT}/definitions/state_initial.yaml`, 'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n');
  storage.write(`${PROJECT}/definitions/characters/alice.yaml`, 'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n');
  storage.write(`${PROJECT}/chapters/chapter_01/_chapter.yaml`, 'chapter: 1\ntitle: "Opening"\nsummary: "Alice begins."\nintent: "Setup"\nplannedScenes: 1\n');
  storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`, 'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Opening"\nstoryTime: "day 1"\nsceneBrief: "Alice begins."\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n');
  storage.write(`${PROJECT}/definitions/discourse-ledger.yaml`, [
    'id: debug-test',
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
    },
  };
}

it('debug renderNovel', async () => {
  const storage = new MemoryStorage();
  seedProject(storage);

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
        entries: { E001: { prose: 'Alice entered quietly.', analysis: analysis() } },
      }),
    },
  );

  console.log('=== render result ===');
  console.log('status:', JSON.stringify(result.publication.status));
  console.log('sceneCount:', result.sceneCount);
  console.log('reasons:', JSON.stringify(result.publication.reasons));
  if (result.events) {
    for (const ev of result.events) {
      console.log('event', ev.eventId, 'disposition:', ev.disposition, 'status:', ev.status);
    }
  }
  console.log('markdown length:', result.publication.markdown?.length ?? 'null');

  // Check what the storage has
  const manifestRaw = storage.readOptional(`${PROJECT}/.nova/publication.json`);
  console.log('manifest exists:', manifestRaw !== null);
  if (manifestRaw) {
    const manifest = JSON.parse(manifestRaw);
    console.log('manifest status:', manifest.status);
    console.log('manifest branch_scope_hash:', manifest.branch_scope_hash);
    console.log('manifest revision_ids:', JSON.stringify(manifest.revision_ids));
    console.log('manifest novel_hash:', manifest.novel_hash);
  }

  const manifestRaw2 = storage.readOptional(`${PROJECT}/.nova/publication.json`);
  console.log('manifest raw (first 200):', manifestRaw2?.substring(0, 200));

  // Check scene files
  try {
    const sceneDir = `${PROJECT}/scenes/chapter-01`;
    const files = storage.read(sceneDir);
    console.log('scene dir:', typeof files, Array.isArray(files) ? files : 'not array');
  } catch(e: any) {
    console.log('scene dir error:', e.message);
  }

  expect(true).toBe(true);
});
