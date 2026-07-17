#!/usr/bin/env node
// ============================================================================
// render-mdg.mjs — Render Most Dangerous Game via RenderPipeline
// ============================================================================
// Two-pass + parallel + cache + maxTokens=10000
// Output format follows PROJECT.md: .md, .yaml, _render_request.yaml, .nova/
// ============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';

const projectRoot = '/home/float/myfile/Projects/novalistically';
dotenvConfig({ path: path.join(projectRoot, '.env') });

const PROVIDER_BASE_URL = process.env.OPENCODE_GO_BASE_URL ?? 'http://127.0.0.1:25793/v1';
const PROVIDER_API_KEY = process.env.OPENCODE_GO_API_KEY ?? 'ocg-6f87c1b4-38c9158a';
const PROVIDER_MODEL = process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash';

const core = await import(path.join(projectRoot, 'packages/core/dist/index.js'));
const {
  EntityMapper,
  InMemoryEntityRegistry,
  StateManager,
  ContextCompiler,
  OpencodeGoProvider,
  MockProvider,
  assembleNovel,
  FsStorage,
  RenderPipeline,
  buildAndWriteOutputs,
} = core;

const projectDir = process.argv[2] ?? path.join(projectRoot, 'fixtures/most-dangerous-game');
const scenesDir = process.argv[3] ?? path.join(projectDir, 'scenes');

console.log('═══ Render Pipeline (Two-Pass + Parallel + Cache) ═══');
console.log('  project:', projectDir);
console.log('  scenes :', scenesDir);
console.log('');

// ── 1. Load project ────────────────────────────────────────────────
console.log('1. Loading project via EntityMapper...');
const mapper = new EntityMapper(projectDir);
const data = mapper.loadProject();
const anchors = new Map();
for (const a of data.timeAnchors ?? []) anchors.set(a.id, a.day);
console.log(`   ${data.characters.length} chars, ${data.locations.length} locs, ${data.rules.length} rules`);

// ── 2. Build event list ────────────────────────────────────────────
console.log('2. Loading events...');
const eventList = [];
for (const [chapterNum, chapter] of data.chapters) {
  for (const ef of chapter.events) {
    const ev = mapper.mapToNarrativeEvent(ef, chapterNum, anchors);
    eventList.push({ ev, chapterNum });
  }
}
const genesis = mapper.createGenesisEvent(data.worldInitialState);
eventList.unshift({ ev: genesis, chapterNum: 0 });
eventList.sort((a, b) => a.ev.narrativeOrder - b.ev.narrativeOrder);
const narrativeEvents = eventList.filter(({ ev }) => ev.id !== 'system:genesis');
console.log(`   ${eventList.length} total (1 genesis + ${narrativeEvents.length} narrative)`);

// ── 3. Build registry + state manager ──────────────────────────────
console.log('3. Building registry + state...');
const registry = new InMemoryEntityRegistry();
registry.load(projectDir);
const stateManager = new StateManager(path.join(projectDir, '.nova/snapshots'));
for (const { ev } of eventList) stateManager.commit(ev);
console.log('   state ready');

// ── 4. Compile context for each event + build jobs ──────────────────
console.log('4. Compiling context for each event...');
const compiler = new ContextCompiler(8000);

const styleByEventId = {
  E0_yacht_dialogue: { tone: 'philosophical', scenePacing: 'leisurely', atmosphere: 'Caribbean night' },
  E1_pipe_fall: { tone: 'sudden', scenePacing: 'fast', atmosphere: 'black water' },
  E2_jungle_sleep: { tone: 'disorienting', scenePacing: 'slow', atmosphere: 'tropical heat' },
  E3_chateau_arrival: { tone: 'tense', scenePacing: 'measured', atmosphere: 'gothic grandeur' },
  E4_dinner_manifesto: { tone: 'sinister', scenePacing: 'dialogue-heavy', atmosphere: 'candlelit' },
  E5_hounds_revealed: { tone: 'horrifying', scenePacing: 'reveal', atmosphere: 'cellar' },
  E6_hunt_begins: { tone: 'desperate', scenePacing: 'fast', atmosphere: 'dusk jungle' },
  E7_tree_hide: { tone: 'tense', scenePacing: 'suspended', atmosphere: 'treetop night' },
  E8_man_catcher: { tone: 'triumphant', scenePacing: 'sharp', atmosphere: 'jungle dawn' },
  E9_tiger_pit: { tone: 'relentless', scenePacing: 'measured', atmosphere: 'Death Swamp' },
  E10_knife_trap: { tone: 'gruesome', scenePacing: 'sharp', atmosphere: 'Burmese pit' },
  E11_sea_leap: { tone: 'desperate', scenePacing: 'fast', atmosphere: 'sea cliffs' },
  E12_chateau_finale: { tone: 'dark', scenePacing: 'climactic', atmosphere: 'bedroom' },
};

const jobs = [];
for (const { ev, chapterNum } of narrativeEvents) {
  const stateBefore = stateManager.getStateAt(ev.narrativeOrder);
  const ctx = compiler.compile(ev, stateBefore, registry);
  jobs.push({ event: ev, stateBefore, context: ctx, chapter: chapterNum });
}
console.log(`   ${jobs.length} jobs built`);

// ── 5. Render (parallel, two-pass, cached) ─────────────────────────
const useMock = process.env.MOCK === '1';
console.log(`5. Rendering ${jobs.length} scenes (provider: ${useMock ? 'MOCK' : 'OPENCODE_GO'})...`);

const provider = useMock
  ? new MockProvider({ defaultResponse: 'Mock prose for this scene.', latencyMs: 0 })
  : new OpencodeGoProvider({
      apiKey: PROVIDER_API_KEY,
      baseUrl: PROVIDER_BASE_URL,
      model: PROVIDER_MODEL,
    });

const storage = new FsStorage();
const novaDir = path.join(projectDir, '.nova');
const cacheDir = novaDir;

const pipeline = new RenderPipeline({
  provider,
  model: PROVIDER_MODEL,
  cacheDir,
  storage,
  concurrency: 5,
  maxTokens: 10000,
});

// Initialize cache keys from event map
// Find matching files on disk (event IDs may be short, files may have long names)
const eventsFileMap = new Map();
for (const { ev, chapterNum } of narrativeEvents) {
  const chapterDir = path.join(projectDir, 'chapters', `chapter_${String(chapterNum).padStart(2, '0')}`);
  const files = fs.readdirSync(chapterDir);
  const match = files.find((f) => f.startsWith(ev.id + '_') || f === ev.id + '.yaml');
  eventsFileMap.set(ev.id, {
    narrativeOrder: ev.narrativeOrder,
    chapter: chapterNum,
    filePath: path.join(chapterDir, match || `${ev.id}.yaml`),
  });
}
const defsDir = path.join(projectDir, 'definitions');
await pipeline.initCache(eventsFileMap, defsDir);

// Render all scenes in parallel
const renderStart = Date.now();
const results = await pipeline.renderAll(jobs);
const elapsed = ((Date.now() - renderStart) / 1000).toFixed(1);

// ── 6. Write outputs ───────────────────────────────────────────────
console.log('');
console.log('6. Writing outputs...');

let emptyCount = 0;
for (const r of results) {
  const wordCount = r.prose.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) emptyCount++;
  const cacheIcon = r.cacheHit ? '📦' : ' ';
  const errIcon = r.errors.length > 0 ? '⚠' : ' ';
  console.log(`   ${cacheIcon}${errIcon}${r.eventId}: ${wordCount} words${r.cacheHit ? ' (cached)' : ''}`);
}

// buildAndWriteOutputs handles all file output (PROJECT.md format):
//   scenes/chapter-NN/{eventId}.md
//   scenes/chapter-NN/{eventId}.yaml
//   scenes/chapter-NN/{eventId}_render_request.yaml
//   .nova/responses/{eventId}.json
//   .nova/derived/{threads,foreshadowing,relationships,rules}.yaml
buildAndWriteOutputs(storage, projectDir, jobs, results);

console.log(`   Wrote ${results.length} scenes`);
if (emptyCount > 0) console.log(`   ⚠ ${emptyCount} scenes have empty prose`);

// ── 7. Assemble novel ──────────────────────────────────────────────
console.log('');
console.log('7. Assembling novel...');
const result = assembleNovel({ projectDir });
console.log(`   ${result.sceneCount} scenes, ${result.wordCount} words`);
console.log(`   → ${path.join(projectDir, 'output/novel.md')}`);

console.log('');
console.log(`═══ Done (${elapsed}s) ═══`);
