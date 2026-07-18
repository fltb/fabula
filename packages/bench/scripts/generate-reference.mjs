// ============================================================================
// Generate reference AnalysisResult JSON from real LLM for benchmark fixtures.
// Stores data in fixtures/{project}/reference/{eventId}.json
// ============================================================================
import { EntityMapper, ReplayEngine, ResultAggregator, ContextCompiler, RenderPipeline, FsStorage, AiSdkProvider, InMemoryEntityRegistry, writeValidationReport } from '../../core/dist/index.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../..');

const projectName = process.argv[2] || 'zhu-fu';
const projectDir = join(rootDir, 'fixtures', projectName);
const referenceDir = join(projectDir, 'reference', 'data');

if (!existsSync(projectDir)) {
  console.error(`Project not found: ${projectDir}`);
  process.exit(1);
}

const apiKey = process.env.NOVALISTICALLY_AI_API_KEY;
if (!apiKey) {
  console.error('NOVALISTICALLY_AI_API_KEY not set in .env');
  process.exit(1);
}

// AiSdkProvider auto-detects base URL and model from key prefix
const provider = new AiSdkProvider({ apiKey });

// ── Empty initial state matching WorldState interface ────────────
const EMPTY_STATE = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};

// ── Setup ──────────────────────────────────────────────────────────
const storage = new FsStorage();
const aggregator = new ResultAggregator();
const mapper = new EntityMapper(projectDir);
const registry = new InMemoryEntityRegistry();
const compiler = new ContextCompiler();
const replay = new ReplayEngine();

// ── Load fixtures ──────────────────────────────────────────────────
console.log(`Loading ${projectName} fixtures...`);
const projectData = mapper.loadProject();
const events = mapper.loadAllEvents(projectData.chapters);
console.log(`  ${events.length} events loaded`);

registry.load(projectDir);

// ── Build per-event state (incremental replay) ─────────────────────
// Sort by narrativeOrder for deterministic state reconstruction
const sorted = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
let currentState = replay.replay([]); // empty initial WorldState
const eventStates = [];
for (const event of sorted) {
  // Deep clone via JSON round-trip (structuredClone may not exist in older Node)
  eventStates.push({ event, stateBefore: JSON.parse(JSON.stringify(currentState)) });
  // Advance state to include this event
  currentState = replay.getStateAt(sorted, event.narrativeOrder);
}

// ── Pipeline ───────────────────────────────────────────────────────
const model = process.env.NOVALISTICALLY_AI_MODEL || 'deepseek-v4-flash';
const pipeline = new RenderPipeline({
  provider,
  model,
  storage,
  aggregator,
  cacheDir: join(projectDir, '.nova/render-cache'),
});

// ── Generate reference data ────────────────────────────────────────
mkdirSync(referenceDir, { recursive: true });
let succeeded = 0;
let failed = 0;

for (const { event, stateBefore } of eventStates) {
  const refFile = join(referenceDir, `${event.id}.json`);

  if (existsSync(refFile)) {
    console.log(`  ${event.id}: skipping (already exists)`);
    succeeded++;
    continue;
  }

  process.stdout.write(`  ${event.id}: rendering... `);
  try {
    const context = compiler.compile(event, stateBefore ?? EMPTY_STATE, registry);
    if (!context) {
      console.log('SKIP (no context)');
      continue;
    }

    const result = await pipeline.renderScene({
      event,
      stateBefore: stateBefore ?? EMPTY_STATE,
      context,
      chapter: 1,
    });

    // Extract prose from RenderSceneResult
    const prose = result.prose;

    // Save reference entry (MockPass2Provider compatible)
    const reference = {
      prose,
      analysis: result.analysis, // may be null if Pass 2 failed
      _metadata: {
        eventId: event.id,
        title: event.title,
        sceneBrief: event.sceneBrief,
        generatedAt: new Date().toISOString(),
        cacheHit: result.cacheHit,
        attempts: result.attempts,
        errors: result.errors,
      },
    };

    writeFileSync(refFile, JSON.stringify(reference, null, 2));
    console.log('OK');
    succeeded++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.log(`FAIL: ${msg}`);
    if (stack) console.error(`  ${stack.split('\n').slice(0, 3).join('\n  ')}`);
    failed++;
  }
}

console.log(`\nDone: ${succeeded} succeeded, ${failed} failed`);
console.log(`Reference data: ${referenceDir}/`);

// ── Write per-project validation report ──────────────────────────────
console.log('\nWriting validation report...');
const aggregatorForReport = new ResultAggregator();
const results = aggregatorForReport.validateAll(events, currentState, registry);
const allL1Issues = [];
for (const r of results.values()) {
  allL1Issues.push(...r.errors, ...r.warnings, ...r.infos);
}
const reportPath = writeValidationReport(projectDir, {
  projectName: projectName,
  generatedAt: new Date().toISOString(),
  l1Issues: allL1Issues,
  l2Issues: [],
});
console.log(`Validation report: ${reportPath}`);
