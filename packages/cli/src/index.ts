// ============================================================================
// Novalistically CLI — Command-line interface
// ============================================================================

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EntityMapper,
  InMemoryEntityRegistry,
  StateManager,
  ResultAggregator,
  ContextCompiler,
  assembleNovel,
  calculateISS,
  detectAntiPatterns,
  validateStrict,
  RenderPipeline,
  FsStorage,
  buildAndWriteOutputs,
  PluginLoader,
  ValidatorRegistry,
  ReviewManager,
  clearEventCache,
} from '@novalistically/core';
import type { LLMProvider, AnalysisResult, PluginValidator, ReviewComment } from '@novalistically/core';
import { runAll, runFunctionalBench, runPerformanceBench } from '@novalistically/bench';

// ============================================================================
// Helpers
// ============================================================================

function ensureProjectDir(): string {
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, 'nova.yaml'))) {
    console.error('Error: Not in a novalistically project directory (no nova.yaml found).');
    console.error('Run "nova project init <name>" to create a new project.');
    process.exit(1);
  }
  return cwd;
}

// ============================================================================
// Commands
// ============================================================================

const program = new Command();

program
  .name('nova')
  .description('Novalistically — Narrative Engineering System')
  .version('0.1.0');

// --- project init ---
program
  .command('project init <name>')
  .description('Initialize a new novalistically project')
  .action(async (name: string) => {
    const projectDir = path.join(process.cwd(), name);
    if (fs.existsSync(projectDir)) {
      console.error(`Error: Directory "${name}" already exists.`);
      process.exit(1);
    }

    // Create directory structure
    const dirs = [
      'definitions/characters',
      'definitions/relationships',
      'definitions/rules',
      'definitions/locations',
      'definitions/items',
      'definitions/factions',
      'chapters',
      'scenes',
      'notes',
      'reference',
      'output',
      'reviews',
      'branches',
      '.nova/responses',
      '.nova/derived',
      '.nova/snapshots',
    ];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
    }

    // Write nova.yaml
    const novaYaml = `project: ${name}
title: "${name}"
author: "Author"
default_model: claude-sonnet-4-20250514
default_language: zh
snapshot_interval: 20
`;
    fs.writeFileSync(path.join(projectDir, 'nova.yaml'), novaYaml, 'utf-8');

    // Write state_initial.yaml template
    const stateInitial = `# definitions/state_initial.yaml
# World initial state — the starting point of all dynamic state.

info:
  current_era: "story_beginning"
  political_situation: "Describe the initial political situation here."

time_anchors:
  - id: story_beginning
    day: 0
    description: "Day 0 — Story begins"

threads: []

world_facts: []
`;
    fs.writeFileSync(path.join(projectDir, 'definitions', 'state_initial.yaml'), stateInitial, 'utf-8');

    // Write PROJECT_STATUS.md
    const statusMd = `# ${name} — Project Status

_Last updated: ${new Date().toISOString().split('T')[0]}_

## Progress

No chapters created yet. Run \`nova validate\` after creating your first event files.

## Recent Validation

No validations run yet.

## Thread Status

No threads defined yet.

## Next Steps

1. Define characters in \`definitions/characters/\`
2. Define world rules in \`definitions/rules/\`
3. Create your first chapter and events in \`chapters/\`
4. Run \`nova validate\` to check consistency
`;
    fs.writeFileSync(path.join(projectDir, 'PROJECT_STATUS.md'), statusMd, 'utf-8');

    // Git init
    const { execSync } = await import('node:child_process');
    try {
      execSync('git init', { cwd: projectDir, stdio: 'ignore' });
    } catch {
      // Git may not be available — that's fine
    }

    console.log(`✅ Project "${name}" initialized at ${projectDir}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  cd ${name}`);
    console.log('  1. Define characters in definitions/characters/');
    console.log('  2. Define rules in definitions/rules/');
    console.log('  3. Create chapter events in chapters/');
    console.log('  4. Run "nova validate" to check consistency');
  });

// --- validate ---
program
  .command('validate')
  .description('Run all validators against the project')
  .option('--strict', 'Enforce strict anti-laziness thresholds')
  .option('--event <eventId>', 'Validate a specific event only')
  .action(async (options: { strict?: boolean; event?: string }) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    if (events.length === 0) {
      console.log('No events found. Create events in chapters/ and run validate again.');
      return;
    }

    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) {
      stateManager.commit(event);
    }
    const state = stateManager.getCurrentState();

    // Load plugin validators (future: load from plugins/ directory)
    const validatorRegistry = new ValidatorRegistry();
    // TODO: Discover and register plugins from plugins/ directory
    const aggregator = new ResultAggregator(undefined, validatorRegistry.validators);
    const overrides = data.config?.validatorOverrides;

    if (options.event) {
      // Validate single event
      const targetEvent = events.find((e) => e.id === options.event);
      if (!targetEvent) {
        console.error(`Error: Event "${options.event}" not found.`);
        process.exit(1);
      }
      const chapter = Math.max(1, Math.ceil(targetEvent.narrativeOrder / 3));
      const result = aggregator.validate(targetEvent, state, registry, events, chapter, overrides);
      printValidationResult(result);
    } else {
      // Validate all events
      const results = aggregator.validateAll(events, state, registry, overrides);

      let totalErrors = 0;
      let totalWarnings = 0;

      for (const [eventId, result] of results) {
        totalErrors += result.errors.length;
        totalWarnings += result.warnings.length;
        if (!result.passed || result.warnings.length > 0 || result.infos.length > 0) {
          console.log(`\n--- ${eventId} ---`);
          printValidationResult(result);
        }
      }

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Validated ${results.size} events`);
      console.log(`  Errors:   ${totalErrors}`);
      console.log(`  Warnings: ${totalWarnings}`);
      console.log(totalErrors === 0 ? '✅ All passed' : '❌ Has errors');

      // ISS
      if (options.strict || process.argv.includes('--strict')) {
        const threads = data.worldInitialState?.threads ?? [];
        const issResult = calculateISS({
          projectDir,
          entityRegistry: registry,
          events,
          threads: threads.map((t) => ({ id: t.id, name: t.name })),
          rules: data.rules,
        });

        console.log(`\nISS: ${issResult.overall}% (target: ${issResult.target}%)`);
        for (const dim of issResult.dimensions) {
          const icon = dim.status === 'green' ? '✅' : dim.status === 'yellow' ? '⚠️' : '❌';
          console.log(`  ${icon} ${dim.name}: ${dim.score}/${dim.max}`);
        }

        // Anti-patterns
        const antiPatterns = detectAntiPatterns({
          entityRegistry: registry,
          events,
          threads: threads.map((t) => ({ id: t.id, name: t.name })),
        });
        for (const ap of antiPatterns) {
          console.log(`  ⚠️ Anti-pattern: ${ap.message}`);
        }

        // Strict validation
        const strictIssues = validateStrict({
          events,
          entityRegistry: registry,
          threads: threads,
          rules: data.rules,
        });
        for (const issue of strictIssues) {
          console.log(`  ❌ Strict: ${issue.message}`);
        }
      }
    }
  });

function printValidationResult(result: { errors: Array<{ message: string }>; warnings: Array<{ message: string }>; infos: Array<{ message: string }>; passed: boolean }) {
  for (const err of result.errors) {
    console.log(`  ❌ ERROR: ${err.message}`);
  }
  for (const warn of result.warnings) {
    console.log(`  ⚠️  WARNING: ${warn.message}`);
  }
  for (const info of result.infos) {
    console.log(`  ℹ️  ${info.message}`);
  }
  if (result.passed && result.warnings.length === 0) {
    console.log('  ✅ Passed');
  }
}

// --- status ---
program
  .command('status')
  .description('Show project status summary')
  .action(() => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) {
      stateManager.commit(event);
    }
    const state = stateManager.getCurrentState();

    console.log(`\n📖 ${data.config?.title ?? 'Untitled'} — Project Status`);
    console.log('━'.repeat(40));

    // Progress
    console.log('\n## Progress');
    for (const [ch, chapter] of data.chapters) {
      const completed = chapter.events.length;
      console.log(`  Chapter ${ch}: ${chapter.metadata?.title ?? 'Untitled'} — ${completed} events`);
    }

    // Threads
    console.log('\n## Thread Status');
    for (const [threadId, threadData] of Object.entries(state.threads)) {
      const progress = `${threadData.progress}/${threadData.total}`;
      const status = threadData.progress >= threadData.total ? '✅' :
        threadData.progress > 0 ? '🔄' : '⏳';
      console.log(`  ${status} ${threadId}: ${progress}`);
    }

    // Entities
    console.log('\n## Entities');
    const characters = registry.findByKind('character');
    console.log(`  Characters: ${characters.length}`);
    for (const c of characters) {
      const loc = state.entities[c.id]?.['location'] ?? c.state['location'] ?? 'unknown';
      const status = state.entities[c.id]?.['status'] ?? c.state['status'] ?? 'unknown';
      console.log(`    - ${c.name} (${c.id}) — ${loc}, ${status}`);
    }
  });

// --- assemble ---
program
  .command('assemble')
  .description('Assemble all committed scenes into output/novel.md')
  .option('--output <path>', 'Custom output path')
  .action((options: { output?: string }) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();

    const result = assembleNovel({
      projectDir,
      outputPath: options.output,
      title: data.config?.title,
    });

    console.log(`✅ Novel assembled: ${result.wordCount} words, ${result.sceneCount} scenes`);
    console.log(`   Output: ${options.output ?? path.join(projectDir, 'output', 'novel.md')}`);
  });

// --- entity ---
const entityCmd = program.command('entity').description('Manage entities');

entityCmd
  .command('list')
  .description('List all entities')
  .option('--type <kind>', 'Filter by entity kind')
  .action((options: { type?: string }) => {
    const projectDir = ensureProjectDir();
    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const entities = options.type
      ? registry.findByKind(options.type as any)
      : registry.getAll();

    for (const entity of entities) {
      console.log(`  [${entity.kind}] ${entity.name} (${entity.id})`);
    }
  });

entityCmd
  .command('show <id>')
  .description('Show entity details')
  .action((id: string) => {
    const projectDir = ensureProjectDir();
    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const entity = registry.resolve(id);
    if (!entity) {
      console.error(`Entity "${id}" not found.`);
      process.exit(1);
    }

    console.log(`\n${entity.name} (${entity.id})`);
    console.log(`Kind: ${entity.kind}`);
    console.log(`Definition: ${entity.definitionFile}`);
    console.log('\nState:');
    for (const [key, value] of Object.entries(entity.state)) {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  });

// ============================================================================
// review — Manage review comments
// ============================================================================

const severityMap: Record<string, ReviewComment['severity']> = {
  info: 'nit',
  warning: 'suggestion',
  blocking: 'blocking',
};

program
  .command('review')
  .description('Manage review comments for rendered scenes')
  .argument('<action>', 'list | add | resolve | reopen | escalate')
  .argument('[targetId]', 'Event ID or comment ID to target')
  .argument('[message]', 'Comment text (for "add" action)')
  .option('--severity <severity>', 'Severity for "add" action: info | warning | blocking', 'warning')
  .action((action: string, targetId: string | undefined, message: string | undefined, opts: { severity?: string }) => {
    const projectDir = ensureProjectDir();
    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const manager = new ReviewManager();
    manager.load(projectDir);

    switch (action) {
      case 'list': {
        const filter = targetId ? { targetId } as any : undefined;
        const comments = manager.getComments(filter);
        if (comments.length === 0) {
          console.log('No review comments found.');
          return;
        }
        for (const c of comments) {
          console.log(`[${c.severity}] ${c.status} ${c.target.type}:${c.target.id} — ${c.content}`);
          console.log(`  ID: ${c.id}, created: ${c.createdAt}`);
          if (c.resolvedAt) console.log(`  Resolved: ${c.resolvedAt}`);
          console.log('');
        }
        break;
      }

      case 'add': {
        if (!targetId || !message) {
          console.error('Usage: nova review add <eventId> "<message>"');
          process.exit(1);
        }
        const event = events.find((e: { id: string }) => e.id === targetId);
        if (!event) {
          console.error(`Event "${targetId}" not found.`);
          process.exit(1);
        }
        const comment: ReviewComment = {
          id: `rev_${Date.now()}`,
          author: 'human',
          target: { type: 'scene', id: targetId },
          severity: severityMap[opts.severity || 'warning'] ?? 'suggestion',
          category: 'style',
          content: message,
          status: 'open',
          createdAt: new Date().toISOString(),
        };
        manager.addComment(comment);
        manager.save(projectDir);
        console.log(`Review comment added: ${comment.id}`);
        break;
      }

      case 'resolve': {
        if (!targetId) {
          console.error('Usage: nova review resolve <commentId>');
          process.exit(1);
        }
        manager.resolve(targetId);
        manager.save(projectDir);
        console.log(`Comment resolved: ${targetId}`);
        break;
      }

      case 'reopen': {
        if (!targetId) {
          console.error('Usage: nova review reopen <commentId>');
          process.exit(1);
        }
        manager.reopen(targetId);
        manager.save(projectDir);

        // Invalidate cache on reopen
        const cacheDir = path.join(projectDir, '.nova', 'render-cache');
        clearEventCache(cacheDir, targetId, new FsStorage());
        console.log(`Comment reopened and cache invalidated: ${targetId}`);
        break;
      }

      case 'escalate': {
        if (!targetId) {
          console.error('Usage: nova review escalate <commentId>');
          process.exit(1);
        }
        manager.escalate(targetId);
        manager.save(projectDir);
        console.log(`Comment escalated: ${targetId}`);
        break;
      }

      default:
        console.error(`Unknown action: "${action}". Use: list, add, resolve, reopen, escalate`);
        process.exit(1);
    }
  });

// --- render ---
program
  .command('render <event>')
  .description('Render a scene (or all scenes with --all) via LLM')
  .option('--dry-run', 'Compile context and save prompt without calling LLM')
  .option('--all', 'Render all events in order')
  .option('--model <model>', 'LLM model to use (overrides config)')
  .action(async (eventId: string, options: { dryRun?: boolean; all?: boolean; model?: string }) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    const targetEvent = events.find((e) => e.id === eventId);
    if (!targetEvent && !options.all) {
      console.error(`Error: Event "${eventId}" not found.`);
      process.exit(1);
    }

    const registry = new InMemoryEntityRegistry();
    registry.load(projectDir);

    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) {
      stateManager.commit(event);
    }

    // Build eventsFileMap with chapters for cache initialization
    const eventsFileMap = new Map<string, { narrativeOrder: number; filePath: string; chapter: number }>();
    for (const [ch, chapter] of data.chapters) {
      for (const evFile of chapter.events) {
        eventsFileMap.set(evFile.event, {
          narrativeOrder: evFile.narrativeOrder,
          filePath: evFile.filePath ?? '',
          chapter: ch,
        });
      }
    }

    if (options.dryRun) {
      // Dry-run: compile context and save prompt
      const compiler = new ContextCompiler();
      const state = stateManager.getStateAt(targetEvent!.narrativeOrder - 1);
      const pkg = compiler.compile(targetEvent!, state, registry);
      console.log(pkg.markdown);
      const dryRunDir = path.join(projectDir, '.nova', 'dry-runs');
      fs.mkdirSync(dryRunDir, { recursive: true });
      const dryRunPath = path.join(dryRunDir, `${eventId}_prompt.md`);
      fs.writeFileSync(dryRunPath, pkg.markdown, 'utf-8');
      console.log(`\nDry-run prompt saved to: ${dryRunPath}`);
      return;
    }

    // ---- Full render path ----

    // Determine which events to render
    const renderEvents = options.all
      ? events.filter((e) => e.id !== 'system:genesis')
      : events.filter((e) => e.id === eventId);

    if (renderEvents.length === 0) {
      console.error(`Error: Event "${eventId}" not found.`);
      process.exit(1);
    }

    // Initialize LLM provider
    const model = options.model ?? data.config?.defaultModel ?? 'claude-sonnet-4-20250514';
    const apiKey = process.env['OPENCODE_API_KEY'] ?? '';
    if (!apiKey) {
      console.error('Error: OPENCODE_API_KEY environment variable not set.');
      console.error('Set it in .env or export OPENCODE_API_KEY=your_key');
      process.exit(1);
    }
    const baseUrl = process.env['OPENCODE_BASE_URL'] ?? 'http://127.0.0.1:25793';

    let provider: LLMProvider;
    if (apiKey.startsWith('ocg-')) {
      const { OpencodeGoProvider } = await import('@novalistically/core');
      provider = new OpencodeGoProvider({ apiKey, baseUrl });
    } else {
      const { OpencodeZenProvider } = await import('@novalistically/core');
      provider = new OpencodeZenProvider({
        apiKey: apiKey || process.env['OPENROUTER_API_KEY'] || '',
        baseUrl: process.env['OPENROUTER_BASE_URL'] || baseUrl,
      });
    }

    // Initialize RenderPipeline
    const cacheDir = path.join(projectDir, '.nova', 'render-cache');
    const storage = new FsStorage();
    const pipeline = new RenderPipeline({
      provider,
      model,
      cacheDir,
      storage,
    });

    // Initialize cache
    await pipeline.initCache(eventsFileMap, path.join(projectDir, 'definitions'));

    // Build render jobs
    const jobs: Array<{
      event: any;
      stateBefore: any;
      context: any;
      chapter: number;
    }> = [];

    for (const ev of renderEvents) {
      // Find the chapter number for this event
      let chapterNum = 1;
      for (const [ch, chapter] of data.chapters) {
        if (chapter.events.some((e) => e.event === ev.id)) {
          chapterNum = ch;
          break;
        }
      }

      const beforeState = stateManager.getStateAt(ev.narrativeOrder - 1);
      const compiler = new ContextCompiler();
      const pkg = compiler.compile(ev, beforeState, registry);

      jobs.push({
        event: ev,
        stateBefore: beforeState,
        context: pkg,
        chapter: chapterNum,
      });
    }

    // Render
    console.log(`Rendering ${jobs.length} scene(s) with model "${model}"...`);
    try {
      const results = await pipeline.renderAll(jobs);

      // Write outputs
      buildAndWriteOutputs(storage, projectDir, jobs, results);

      // Report
      for (const r of results) {
        const status = r.errors.length > 0 ? '❌' : '✅';
        console.log(`  ${status} ${r.eventId}: ${r.prose.split(/\s+/).filter(Boolean).length} words, cache=${r.cacheHit}`);
        if (r.errors.length > 0) {
          for (const e of r.errors) console.log(`       Error: ${e}`);
        }
      }
      console.log(`\nDone. Output written to scenes/`);
    } catch (err) {
      console.error(`Render failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// --- diff ---
program
  .command('diff <event>')
  .description('Show state changes for an event')
  .action((eventId: string) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    const targetEvent = events.find((e) => e.id === eventId);
    if (!targetEvent) {
      console.error(`Error: Event "${eventId}" not found.`);
      process.exit(1);
    }

    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) {
      stateManager.commit(event);
    }

    const beforeState = stateManager.getStateAt(targetEvent.narrativeOrder - 1);
    const afterState = stateManager.getStateAt(targetEvent.narrativeOrder);

    console.log(`\nDiff: ${eventId} — "${targetEvent.title}"`);
    console.log('━'.repeat(50));

    // Show preconditions
    console.log('\n## Preconditions:');
    for (const pc of targetEvent.preconditions) {
      const before = beforeState.entities[pc.entityId]?.[pc.attribute];
      console.log(`  ${pc.entityId}.${pc.attribute}: ${JSON.stringify(before)}`);
    }

    // Show postcondition changes
    console.log('\n## State Changes:');
    for (const pc of targetEvent.postconditions) {
      const before = beforeState.entities[pc.entityId]?.[pc.attribute];
      const after = afterState.entities[pc.entityId]?.[pc.attribute];
      console.log(`  ${pc.entityId}.${pc.attribute}:`);
      console.log(`    before: ${JSON.stringify(before)}`);
      console.log(`    after:  ${JSON.stringify(after)}`);
    }

    // Show thread progress
    if (targetEvent.threadProgress.length > 0) {
      console.log('\n## Thread Progress:');
      for (const tp of targetEvent.threadProgress) {
        console.log(`  ${tp.thread}: ${tp.progressAfter}/${tp.progressTotal} — ${tp.advancement}`);
      }
    }
  });

// --- commit ---
program
  .command('commit')
  .description('Commit current state (auto-run after validation)')
  .action(() => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    if (events.length <= 1) {
      console.log('Nothing to commit.');
      return;
    }

    const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
    const stateManager = new StateManager(snapshotsDir);
    for (const event of events) {
      stateManager.commit(event);
    }

    const lastEvent = events[events.length - 1];
    console.log(`✅ Committed: ${lastEvent.id} — "${lastEvent.title}"`);
    console.log(`   Narrative order: ${lastEvent.narrativeOrder}`);
    console.log(`   Total events: ${events.length - 1} (excluding genesis)`);
  });

// --- bench ---
program
  .command('bench')
  .description('Run functional + performance benchmarks against the project')
  .option('--functional', 'Run only functional benchmarks', false)
  .option('--performance', 'Run only performance benchmarks', false)
  .action(async (options: { functional?: boolean; performance?: boolean }) => {
    const projectDir = ensureProjectDir();

    const onlyFun = options.functional && !options.performance;
    const onlyPerf = options.performance && !options.functional;

    if (onlyFun) {
      console.log('── Functional Benchmarks ──');
      const r = runFunctionalBench(projectDir);
      for (const s of r.stages) {
        const icon = s.passed ? '✅' : '❌';
        console.log(`  ${icon} ${s.stage}: ${s.passed ? 'PASS' : 'FAIL'} (${s.ms.toFixed(2)}ms) — ${s.detail}`);
      }
      console.log(`  ── ${r.totalPassed}/${r.stages.length} passed, ${r.totalFailed} failed, ${r.totalTime.toFixed(0)}ms total ──`);
      return;
    }

    if (onlyPerf) {
      console.log('── Performance Benchmarks ──');
      const r = await runPerformanceBench();
      console.table(
        r.measurements.map((m: { name: string; hz: number; meanMs: number; samples: number; scale: string | number }) => ({
          Stage: m.name,
          'Hz': m.hz.toFixed(1),
          'Mean (ms)': m.meanMs.toFixed(3),
          Samples: m.samples,
          Scale: m.scale,
        })),
      );
      return;
    }

    // Both
    await runAll(projectDir);
  });

// Parse
export async function main(args: string[] = process.argv) {
  await program.parseAsync(args);
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli/dist/index.js')) {
  main();
}
