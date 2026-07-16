#!/usr/bin/env node
// ============================================================================
// render-mdg.mjs — Render all 13 scenes of Most Dangerous Game via LLM
// ============================================================================
// Usage: node /tmp/render-mdg.mjs [projectDir] [outputDir]
//   projectDir: defaults to fixtures/most-dangerous-game
//   outputDir:  defaults to <projectDir>/scenes
// ============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// Load .env from project root
const projectRoot = '/home/float/myfile/Projects/novalistically';
dotenvConfig({ path: path.join(projectRoot, '.env') });

// Provider config — opencode-go (local proxy at 127.0.0.1:25793)
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
  OpencodeZenProvider,
  buildSceneRenderPrompt,
  MockProvider,
  assembleNovel,
} = core;

const projectDir = process.argv[2] ?? path.join(projectRoot, 'fixtures/most-dangerous-game');
const outputDir = process.argv[3] ?? path.join(projectDir, 'scenes');

console.log('═══ Render Pipeline ═══');
console.log('  project:', projectDir);
console.log('  output :', outputDir);
console.log('');

// ── 1. Load project ────────────────────────────────────────────────
console.log('1. Loading project via EntityMapper...');
const mapper = new EntityMapper(projectDir);
const data = mapper.loadProject();
console.log(`   ${data.characters.length} characters, ${data.locations.length} locations, ${data.rules.length} rules, ${data.chapters.size} chapters`);

// Build time-anchor map
const anchors = new Map();
for (const a of data.timeAnchors ?? []) anchors.set(a.id, a.day);

// ── 2. Build event list with chapter info ──────────────────────────
console.log('2. Loading events with chapter mapping...');
const eventList = []; // { event, chapterNum }
for (const [chapterNum, chapter] of data.chapters) {
  for (const ef of chapter.events) {
    const ev = mapper.mapToNarrativeEvent(ef, chapterNum, anchors);
    eventList.push({ ev, chapterNum });
  }
}
// Add genesis from world initial state
const genesis = mapper.createGenesisEvent(data.worldInitialState);
eventList.unshift({ ev: genesis, chapterNum: 0 });
// Sort by narrative order
eventList.sort((a, b) => a.ev.narrativeOrder - b.ev.narrativeOrder);
console.log(`   ${eventList.length} events total (1 genesis + ${eventList.length - 1} narrative)`);

// ── 3. Build registry + state ──────────────────────────────────────
console.log('3. Building registry and state manager...');
const registry = new InMemoryEntityRegistry();
registry.load(projectDir);  // load entities from definitions/*.yaml
console.log(`   registry loaded ${registry.getAll().length} entities`);
const snapshotsDir = path.join(projectDir, '.nova/snapshots');
fs.mkdirSync(snapshotsDir, { recursive: true });
const stateManager = new StateManager(snapshotsDir);
for (const { ev } of eventList) stateManager.commit(ev);
console.log('   state ready');

// ── 4. Render each event ───────────────────────────────────────────
const useMock = process.env.MOCK === '1' || !PROVIDER_API_KEY;
console.log(`4. Rendering ${eventList.length} events (provider: ${useMock ? 'MOCK' : 'OPENCODE_GO @ ' + PROVIDER_BASE_URL})...`);
const provider = useMock
  ? new MockProvider({ defaultResponse: 'Mock prose for this scene.', latencyMs: 0 })
  : new OpencodeGoProvider({
      apiKey: PROVIDER_API_KEY,
      baseUrl: PROVIDER_BASE_URL,
      model: PROVIDER_MODEL,
    });

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

let totalTokens = 0;
const renderStart = Date.now();
let skipped = 0;
for (const { ev, chapterNum } of eventList) {
  if (ev.id === 'system:genesis') continue; // skip genesis

  const chapterStr = String(chapterNum).padStart(2, '0');
  const sceneDir = path.join(outputDir, `chapter-${chapterStr}`);
  fs.mkdirSync(sceneDir, { recursive: true });
  const scenePath = path.join(sceneDir, `${ev.id}.md`);

  // Skip if prose already exists and is non-empty (idempotent re-runs)
  if (fs.existsSync(scenePath) && fs.statSync(scenePath).size > 0 && !process.env.FORCE) {
    const wordCount = fs.readFileSync(scenePath, 'utf-8').split(/\s+/).filter(Boolean).length;
    const elapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
    console.log(`   ${ev.id} ch${chapterStr}: ${wordCount} words (skipped — already rendered), ${elapsed}s elapsed`);
    skipped++;
    continue;
  }

  const state = stateManager.getStateAt(ev.narrativeOrder);
  const ctx = compiler.compile(ev, state, registry);
  const style = styleByEventId[ev.id] ?? { tone: 'literary', scenePacing: 'medium' };
  const messages = buildSceneRenderPrompt({
    context: ctx,
    styleGuidance: style,
    targetLengthWords: 400,
  });

  const result = await provider.complete({
    messages,
    model: PROVIDER_MODEL,
    temperature: 0.8,
    maxTokens: 1500,
  });
  totalTokens += result.usage?.totalTokens ?? 0;

  const prose = result.content ?? '(empty)';
  fs.writeFileSync(scenePath, prose, 'utf-8');

  // Also write scene metadata YAML (assembler requires E*.yaml with narrativeOrder)
  const metaPath = path.join(sceneDir, `${ev.id}.yaml`);
  const metadata = {
    eventId: ev.id,
    title: ev.title,
    narrativeOrder: ev.narrativeOrder,
    sceneType: ev.sceneType,
    pov: ev.pov,
    sceneBrief: ev.sceneBrief,
    generatedAt: new Date().toISOString(),
  };
  // simple YAML serializer (no external dep)
  const yamlStr = [
    `eventId: ${JSON.stringify(ev.id)}`,
    `title: ${JSON.stringify(ev.title)}`,
    `narrativeOrder: ${ev.narrativeOrder}`,
    `sceneType: ${ev.sceneType}`,
    `pov: ${JSON.stringify(ev.pov)}`,
    `sceneBrief: ${JSON.stringify(ev.sceneBrief ?? '')}`,
    `generatedAt: ${JSON.stringify(metadata.generatedAt)}`,
  ].join('\n') + '\n';
  fs.writeFileSync(metaPath, yamlStr, 'utf-8');

  const wordCount = prose.split(/\s+/).filter(Boolean).length;
  const elapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
  console.log(`   ${ev.id} ch${chapterStr}: ${wordCount} words, ${result.usage?.totalTokens ?? '?'} tokens, ${elapsed}s elapsed`);
}
console.log(`   Total tokens: ${totalTokens}, elapsed: ${((Date.now() - renderStart) / 1000).toFixed(1)}s`);

// ── 5. Assemble novel ──────────────────────────────────────────────
console.log('');
console.log('5. Assembling novel...');
const result = assembleNovel({ projectDir });
console.log(`   ${result.sceneCount} scenes, ${result.wordCount} words`);
console.log(`   → ${path.join(projectDir, 'output/novel.md')}`);

console.log('');
console.log('═══ Done ═══');
