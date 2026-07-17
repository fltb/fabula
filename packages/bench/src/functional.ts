// ============================================================================
// Functional Benchmarks — Run each pipeline stage on a real fixture
// ============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  NarrativeEvent,
  WorldState,
  ContextPackage,
  PreRenderInput,
  KnowledgeState,
} from '@novalistically/core';

import {
  EntityMapper,
  InMemoryEntityRegistry,
  TimelineValidator,
  CharacterStateValidator,
  KnowledgeValidator,
  WorldRuleValidator,
  CausalityValidator,
  ForeshadowingValidator,
  POVValidator,
  FactualDetailValidator,
  VoiceDriftDetector,
  BranchMergeValidator,
  ReachabilityValidator,
  ResultAggregator,
  ContextCompiler,
  ReplayEngine,
  StateManager,
  assembleNovel,
  calculateISS,
  detectAntiPatterns,
  validateStrict,
  type ProjectData,
} from '@novalistically/core';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FunctionalStageResult {
  stage: string;
  passed: boolean;
  ms: number;
  detail: string;
}

export interface FunctionalResults {
  fixturePath: string;
  fixtureName: string;
  stages: FunctionalStageResult[];
  totalPassed: number;
  totalFailed: number;
  totalTime: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mark(
  stage: string,
  fn: () => unknown,
  detailFn?: () => string,
): FunctionalStageResult {
  const start = performance.now();
  let passed = true;
  let detail = '';
  try {
    fn();
    detail = detailFn ? detailFn() : 'PASS';
  } catch (err: unknown) {
    passed = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  const ms = performance.now() - start;
  return { stage, passed, ms, detail: detail.slice(0, 250) };
}

function trunc(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function hasDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Context builder (mirrors base.ts buildContext) ─────────────────────────

function buildPreInput(
  event: NarrativeEvent,
  state: WorldState,
  registry: InMemoryEntityRegistry,
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    worldState: state,
    events,
    entityRegistry: registry,
    chapter: 1,
    queryState: (entityId: string, attribute: string) =>
      state.entities[entityId]?.[attribute],
    getKnowledge: () => ({
      worldTruth: state.facts,
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    } as KnowledgeState),
    getThreadProgress: () => ({ progress: 0, total: 0 }),
    getRuleEvidence: () => [],
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Run all functional benchmark stages against a fixture.
 * Returns rich results with timing and pass/fail per stage.
 */
export function runFunctionalBench(fixturePath?: string): FunctionalResults {
  const resolvedPath = fixturePath ?? path.resolve(
    '/home/float/myfile/Projects/novalistically/fixtures/most-dangerous-game',
  );
  const fixtureName = path.basename(resolvedPath);
  const stages: FunctionalStageResult[] = [];

  // Shared state populated across stages
  let projectData!: ProjectData;
  let registry!: InMemoryEntityRegistry;
  let allEvents: NarrativeEvent[] = [];
  let state!: WorldState;
  let contextPkg: ContextPackage | null = null;

  // ── 1. Load entities ──────────────────────────────────────────────────
  stages.push(
    mark('Load entities', () => {
      const mapper = new EntityMapper(resolvedPath);
      projectData = mapper.loadProject();
      registry = new InMemoryEntityRegistry();
      registry.load(resolvedPath);
    }, () => {
      const chars = registry.findByKind('character').length;
      const locs = registry.findByKind('location').length;
      const rules = registry.findByKind('rule').length;
      return `Characters: ${chars}, Locations: ${locs}, Rules: ${rules}`;
    }),
  );

  // ── 2. Load events ────────────────────────────────────────────────────
  stages.push(
    mark('Load events', () => {
      const mapper = new EntityMapper(resolvedPath);
      projectData = mapper.loadProject();
      allEvents = mapper.loadAllEvents(projectData.chapters);
    }, () => {
      const genesisCount = allEvents.filter((e) => e.source === 'genesis').length;
      const eventCount = allEvents.length;
      return `Total events: ${eventCount} (${genesisCount} genesis, ${eventCount - genesisCount} narrative)`;
    }),
  );

  // ── 3. Build registry — verify no duplicates ──────────────────────────
  stages.push(
    mark('Build registry', () => {
      const ids = allEvents.map((e) => e.id);
      const uniqueIds = new Set(ids);
      if (uniqueIds.size !== ids.length) {
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        throw new Error(`Duplicate event IDs: [${dupes.join(', ')}]`);
      }
    }, () => `All ${allEvents.length} events loaded, no duplicates`),
  );

  // ── 4. Replay state from genesis ──────────────────────────────────────
  stages.push(
    mark('Replay state from genesis', () => {
      const replay = new ReplayEngine();
      state = replay.replay(allEvents);
    }, () => {
      const entityCount = Object.keys(state.entities).length;
      const factCount = state.facts.length;
      return `Entities: ${entityCount}, Facts: ${factCount}, Threads: ${Object.keys(state.threads).length}`;
    }),
  );

  // ── 5–15. Run validators + aggregator ─────────────────────────────────
  const validators: Array<{ stageName: string; ValidatorClass: new () => { name?: string; validatePre: (input: PreRenderInput) => Array<{ severity: string; message: string }> } }> = [
    { stageName: 'TimelineValidator', ValidatorClass: TimelineValidator },
    { stageName: 'CharacterStateValidator', ValidatorClass: CharacterStateValidator },
    { stageName: 'KnowledgeValidator', ValidatorClass: KnowledgeValidator },
    { stageName: 'WorldRuleValidator', ValidatorClass: WorldRuleValidator },
    { stageName: 'CausalityValidator', ValidatorClass: CausalityValidator },
    { stageName: 'ForeshadowingValidator', ValidatorClass: ForeshadowingValidator },
    { stageName: 'POVValidator', ValidatorClass: POVValidator },
    { stageName: 'FactualDetailValidator', ValidatorClass: FactualDetailValidator },
    { stageName: 'VoiceDriftDetector', ValidatorClass: VoiceDriftDetector },
    { stageName: 'BranchMergeValidator', ValidatorClass: BranchMergeValidator },
    { stageName: 'ReachabilityValidator', ValidatorClass: ReachabilityValidator },
  ];

  for (const { stageName, ValidatorClass } of validators) {
    stages.push(
      mark(stageName, () => {
        const validator = new ValidatorClass();
        for (const event of allEvents) {
          const input = buildPreInput(event, state, registry, allEvents);
          validator.validatePre(input);
        }
      }, () => {
        const validator = new ValidatorClass();
        let e = 0; let w = 0; let inf = 0;
        const msgs: string[] = [];
        for (const event of allEvents) {
          const input = buildPreInput(event, state, registry, allEvents);
          for (const issue of validator.validatePre(input) ?? []) {
            if (issue.severity === 'error') e++;
            else if (issue.severity === 'warning') w++;
            else inf++;
            if (msgs.length < 3) msgs.push(trunc(issue.message, 60));
          }
        }
        return `Errors: ${e}, Warnings: ${w}, Infos: ${inf}${msgs.length ? ` — ${msgs.join('; ')}` : ''}`;
      }),
    );
  }

  // ── 16. ResultAggregator ─────────────────────────────────────────────
  stages.push(
    mark('ResultAggregator', () => {
      const aggregator = new ResultAggregator();
      const results = aggregator.validateAll(allEvents, state, registry);
      if (results.size === 0 && allEvents.filter((e) => e.id !== 'system:genesis').length > 0) {
        throw new Error('Aggregator returned empty results');
      }
    }, () => {
      const aggregator = new ResultAggregator();
      const results = aggregator.validateAll(allEvents, state, registry);
      let errors = 0; let warnings = 0; let infos = 0;
      for (const r of results.values()) {
        errors += r.errors.length;
        warnings += r.warnings.length;
        infos += r.infos.length;
      }
      return `Errors: ${errors}, Warnings: ${warnings}, Infos: ${infos} (${results.size} events validated)`;
    }),
  );

  // ── 17. Calculate ISS ────────────────────────────────────────────────
  stages.push(
    mark('Calculate ISS', () => {
      const threads = projectData.worldInitialState?.threads ?? [];
      const iss = calculateISS({
        projectDir: resolvedPath,
        entityRegistry: registry,
        events: allEvents,
        threads,
        rules: projectData.rules,
      });
      if (iss.overall < 0 || iss.overall > 100) {
        throw new Error(`ISS score out of range: ${iss.overall}`);
      }
    }, () => {
      const threads = projectData.worldInitialState?.threads ?? [];
      const iss = calculateISS({
        projectDir: resolvedPath,
        entityRegistry: registry,
        events: allEvents,
        threads,
        rules: projectData.rules,
      });
      return `ISS=${iss.overall}/100 (target=${iss.target}) — ${iss.dimensions.length} dimensions`;
    }),
  );

  // ── 18. Detect anti-patterns ─────────────────────────────────────────
  stages.push(
    mark('Detect anti-patterns', () => {
      const issues = detectAntiPatterns({
        entityRegistry: registry,
        events: allEvents,
        threads: projectData.worldInitialState?.threads ?? [],
      });
    }, () => {
      const issues = detectAntiPatterns({
        entityRegistry: registry,
        events: allEvents,
        threads: projectData.worldInitialState?.threads ?? [],
      });
      return `${issues.length} anti-patterns found`;
    }),
  );

  // ── 19. Validate strict ──────────────────────────────────────────────
  stages.push(
    mark('Validate strict', () => {
      const issues = validateStrict({
        entityRegistry: registry,
        events: allEvents,
        rules: projectData.rules,
        threads: projectData.worldInitialState?.threads ?? [],
      });
    }, () => {
      const issues = validateStrict({
        entityRegistry: registry,
        events: allEvents,
        rules: projectData.rules,
        threads: projectData.worldInitialState?.threads ?? [],
      });
      const critical = issues.filter((i) => i.severity === 'error').length;
      return `Critical: ${critical}, Total: ${issues.length}`;
    }),
  );

  // ── 20. Compile context for last narrative event ─────────────────────
  stages.push(
    mark('Compile context', () => {
      const compiler = new ContextCompiler();
      const narrativeEvents = allEvents.filter((e) => e.source !== 'genesis');
      const lastEvent = narrativeEvents[narrativeEvents.length - 1];
      if (!lastEvent) throw new Error('No narrative events to compile context for');
      contextPkg = compiler.compile(lastEvent, state, registry);
      // Verify all 5 layers present
      if (!contextPkg.systemContext) throw new Error('Missing systemContext');
      if (!contextPkg.sceneSpec) throw new Error('Missing sceneSpec');
      if (!contextPkg.characterSnapshots) throw new Error('Missing characterSnapshots');
      if (!contextPkg.relationshipContext) throw new Error('Missing relationshipContext');
      if (!contextPkg.worldFacts) throw new Error('Missing worldFacts');
      if (!contextPkg.knowledgeBoundary) throw new Error('Missing knowledgeBoundary');
      if (!contextPkg.activeThreads) throw new Error('Missing activeThreads');
      if (!contextPkg.markdown) throw new Error('Missing markdown');
    }, () => {
      if (!contextPkg) return 'Skipped';
      return `Chars: ${contextPkg.characterSnapshots.length}, Rels: ${contextPkg.relationshipContext.length}, Facts: ${contextPkg.worldFacts.length}, Threads: ${contextPkg.activeThreads.length}`;
    }),
  );

  // ── 21. Novel assembly ───────────────────────────────────────────────
  stages.push(
    mark('Assemble novel', () => {
      const scenesDir = path.join(resolvedPath, 'scenes');
      if (!hasDir(scenesDir)) {
        // Fixture has no rendered prose yet — that's a valid pre-render state
        return;
      }
      const result = assembleNovel({ projectDir: resolvedPath });
      if (result.sceneCount < 1) {
        throw new Error(`Expected ≥1 scene, got ${result.sceneCount}`);
      }
    }, () => {
      const scenesDir = path.join(resolvedPath, 'scenes');
      if (!hasDir(scenesDir)) return 'Skipped (no scenes/)';
      try {
        const result = assembleNovel({ projectDir: resolvedPath });
        return `Scenes: ${result.sceneCount}, Words: ${result.wordCount}`;
      } catch (err: unknown) {
        return `Assembly failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );

  // ── Tally ────────────────────────────────────────────────────────────
  const totalPassed = stages.filter((s) => s.passed).length;
  const totalFailed = stages.filter((s) => !s.passed).length;
  const totalTime = stages.reduce((sum, s) => sum + s.ms, 0);

  return {
    fixturePath: resolvedPath,
    fixtureName,
    stages,
    totalPassed,
    totalFailed,
    totalTime,
  };
}
