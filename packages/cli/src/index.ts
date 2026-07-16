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
} from '@novalistically/core';

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
  .action((name: string) => {
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

    const aggregator = new ResultAggregator();
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
          projectDir,
          entityRegistry: registry,
          events,
          threads: threads.map((t) => ({ id: t.id, name: t.name })),
          rules: data.rules,
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
          currentChapter: Math.max(1, ...events.map((e) => Math.ceil(e.narrativeOrder / 3))),
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

// --- render ---
program
  .command('render <event>')
  .description('Compile context and show the Context Package for an event')
  .option('--dry-run', 'Save prompt without calling LLM')
  .action((eventId: string, options: { dryRun?: boolean }) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);

    const targetEvent = events.find((e) => e.id === eventId);
    if (!targetEvent) {
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
    const state = stateManager.getStateAt(targetEvent.narrativeOrder - 1);

    const compiler = new ContextCompiler();
    const pkg = compiler.compile(targetEvent, state, registry);

    console.log(pkg.markdown);

    if (options.dryRun) {
      const dryRunDir = path.join(projectDir, '.nova', 'dry-runs');
      fs.mkdirSync(dryRunDir, { recursive: true });
      const dryRunPath = path.join(dryRunDir, `${eventId}_prompt.md`);
      fs.writeFileSync(dryRunPath, pkg.markdown, 'utf-8');
      console.log(`\nDry-run prompt saved to: ${dryRunPath}`);
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

// Parse
export async function main(args: string[] = process.argv) {
  await program.parseAsync(args);
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli/dist/index.js')) {
  main();
}
