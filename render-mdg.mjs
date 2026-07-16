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
console.log(`[debug] PROVIDER_API_KEY = ${PROVIDER_API_KEY.slice(0, 12)}..., BASE_URL = ${PROVIDER_BASE_URL}`);

const core = await import(path.join(projectRoot, 'packages/core/dist/index.js'));
const {
  EntityMapper,
  InMemoryEntityRegistry,
  StateManager,
  ContextCompiler,
  OpencodeGoProvider,
  OpencodeZenProvider,
  PostRenderValidator,
  buildSceneRenderPrompt,
  MockProvider,
  assembleNovel,
} = core;

// Post-render validator — checks LLM output against source event claims
const postValidator = new PostRenderValidator({
  canonicalNames: ['Rainsford', 'Whitney', 'Zaroff', 'Ivan', 'Lazarus'],
});

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

  // Skip if BOTH prose AND render record exist and are non-empty (idempotent re-runs)
  const recordPath = path.join(sceneDir, `${ev.id}.render.json`);
  if (
    fs.existsSync(scenePath) &&
    fs.statSync(scenePath).size > 0 &&
    fs.existsSync(recordPath) &&
    !process.env.FORCE
  ) {
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

  // Capture the WorldState snapshot BEFORE rendering — so we can later
  // diff (state-after-render) vs (state-before-render) to verify the LLM
  // actually wrote what we expected.
  const stateBefore = stateManager.getStateAt(ev.narrativeOrder);

  const llmStart = Date.now();
  let result;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await provider.complete({
        messages,
        model: PROVIDER_MODEL,
        temperature: 0.8,
        maxTokens: 3000,  // deepseek reasoning_content consumes budget; allow more
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.log(`   (attempt ${attempt + 1} failed: ${err.message.slice(0, 80)}, retrying in ${(attempt + 1) * 2}s)`);
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
    }
  }
  if (!result) {
    console.error(`   E${ev.id} FAILED after 3 attempts: ${lastError?.message}`);
    result = { content: '(LLM call failed after retries)', model: PROVIDER_MODEL, usage: { totalTokens: 0 }, finishReason: 'error', id: null };
  }
  const llmLatencyMs = Date.now() - llmStart;
  totalTokens += result.usage?.totalTokens ?? 0;

  const prose = result.content ?? '(empty)';
  fs.writeFileSync(scenePath, prose, 'utf-8');

  // ── Run PostRenderValidator (THE core meaning: verify LLM output) ──
  const postRenderResult = postValidator.validate(prose, ev, stateBefore);

  // ─── Comprehensive machine-readable render record ─────────────
  // This is the "data the user wants" — everything a future graph
  // detector or anomaly check needs to verify the render:
  //   - source event (full: preconditions, postconditions, threads, etc.)
  //   - context package summary (so we know what the LLM saw)
  //   - world state snapshot (what was true when rendered)
  //   - LLM call metadata (model, tokens, latency, finishReason)
  //   - rendered prose (for diff against canonical)
  //   - style guidance + style notes actually applied
  //   - condition checks: which preconditions were satisfied at render
  //     time (vs the postconditions the event claims to establish)
  const renderRecord = {
    schemaVersion: 1,
    eventId: ev.id,
    renderedAt: new Date().toISOString(),

    // 1. Source event — full canonical record
    sourceEvent: {
      id: ev.id,
      event: ev.event,
      title: ev.title,
      narrativeOrder: ev.narrativeOrder,
      storyTime: ev.storyTime,
      sceneType: ev.sceneType,
      pov: ev.pov,
      sceneBrief: ev.sceneBrief,
      preconditions: ev.preconditions,
      expectedPostconditions: ev.postconditions,
      threadProgress: ev.threadProgress,
      foreshadowing: ev.foreshadowing,
      relationshipEffects: ev.relationshipEffects,
      ruleEffects: ev.ruleEffects,
      styleGuidance: ev.styleGuidance,
      branchExistence: ev.branchExistence,
      participants: ev.participants,
    },

    // 2. Style guidance actually applied (may differ from event default)
    appliedStyle: style,

    // 3. Context package — summary form (full pkg is large)
    contextSummary: {
      eventId: ctx.eventId,
      characterCount: ctx.characterSnapshots?.length ?? 0,
      relationshipCount: ctx.relationshipContext?.length ?? 0,
      worldFactCount: ctx.worldFacts?.length ?? 0,
      threadCount: ctx.activeThreads?.length ?? 0,
      knownFactCount: ctx.knowledgeBoundary?.knownFacts?.length ?? 0,
      // Include the character names so we can verify the LLM was told about them
      characterNames: (ctx.characterSnapshots ?? []).map((c) => c.name ?? c.id),
      // World facts the LLM was given
      worldFactIds: (ctx.worldFacts ?? []).map((f) => f.id),
    },

    // 4. World state snapshot at render time (only counts, full state is large)
    worldStateBefore: {
      entityCount: Object.keys(stateBefore.entities ?? {}).length,
      factCount: (stateBefore.facts ?? []).length,
      relationshipCount: Object.keys(stateBefore.relationships ?? {}).length,
      threadCount: Object.keys(stateBefore.threads ?? {}).length,
      // Which preconditions were satisfied before render
      preconditionsSatisfied: (ev.preconditions ?? []).map((pc) => ({
        entity: pc.entityId,
        attribute: pc.attribute,
        expectedValue: pc.value,
        currentValue: stateBefore.entities?.[pc.entityId]?.[pc.attribute] ?? null,
        satisfied:
          JSON.stringify(stateBefore.entities?.[pc.entityId]?.[pc.attribute]) ===
          JSON.stringify(pc.value),
      })),
    },

    // 5. LLM call — full metadata for reproducibility
    llmCall: {
      provider: provider.name ?? 'unknown',
      model: result.model ?? PROVIDER_MODEL,
      temperature: 0.8,
      maxTokens: 1500,
      promptMessages: messages.length,
      promptChars: messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0),
      usage: {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
      },
      finishReason: result.finishReason ?? 'unknown',
      requestId: result.id ?? null,
      latencyMs: llmLatencyMs,
    },

    // 6. Rendered prose
    prose: prose,
    wordCount: prose.split(/\s+/).filter(Boolean).length,
    charCount: prose.length,

    // 7. POST-RENDER VALIDATION (the core meaning of the system)
    //    This is what makes the renderer trustworthy: every render is
    //    checked against the event's claims, and any divergence is recorded
    //    in the record so downstream anomaly detection / graph checks can
    //    use it.
    postRenderValidation: {
      passed: postRenderResult.passed,
      confidence: postRenderResult.confidence,
      coverage: postRenderResult.coverage,
      issueCount: postRenderResult.issues.length,
      errorCount: postRenderResult.issues.filter((i) => i.severity === 'error').length,
      warningCount: postRenderResult.issues.filter((i) => i.severity === 'warning').length,
      issues: postRenderResult.issues,
    },
  };

  fs.writeFileSync(recordPath, JSON.stringify(renderRecord, null, 2), 'utf-8');

  const wordCount = prose.split(/\s+/).filter(Boolean).length;
  const elapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
  const vIcon = postRenderResult.passed ? '✅' : '⚠';
  console.log(`   ${ev.id} ch${chapterStr}: ${wordCount} words, ${result.usage?.totalTokens ?? '?'} tokens, ${elapsed}s elapsed, ${vIcon}val conf=${postRenderResult.confidence.toFixed(2)} (${postRenderResult.issues.length} issues)`);
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
