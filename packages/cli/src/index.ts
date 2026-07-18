// ============================================================================
// Novalistically CLI — Command-line interface
// ============================================================================

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  renderNovel,
  validateNovel,
  getProjectStatus,
  diffEvent,
  listEntities,
  showEntity,
  assembleNovel,
  ReviewManager,
  clearEventCache,
  FsStorage,
  EntityMapper,
  InMemoryEntityRegistry,
  StateManager,
  buildCausalEdges,
  exportDAGtoDOT,
  exportDAGtoMermaid,
} from '@novalistically/core';
import type { ReviewComment } from '@novalistically/core';
import { runAll, runRegressionBench, runPerformanceBench } from '@novalistically/bench';

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
      'rejected_proposals',
      '.nova/responses',
      '.nova/derived',
      '.nova/snapshots',
    ];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
    }

    // Create .gitkeep in rejected_proposals
    fs.writeFileSync(path.join(projectDir, 'rejected_proposals', '.gitkeep'), '', 'utf-8');

    // Write branch_points.yaml template
    const branchPointsYaml = `# Branch Points
# Define narrative branch points here.
# Each branch point occurs at a specific event and offers choices.
# branch_points:
#   - id: BP1
#     at_event: E5
#     description: "The protagonist faces a critical decision"
#     choices:
#       - path: trust_ally
#         branch_id: branch_a
#         label: "Trust the ally"
#       - path: go_alone
#         branch_id: branch_b
#         label: "Go alone"
`;
    fs.writeFileSync(path.join(projectDir, 'branches', 'branch_points.yaml'), branchPointsYaml, 'utf-8');

    // Write nova.yaml
    const novaYaml = `project: ${name}
title: "${name}"
author: "Author"
default_model: claude-sonnet-4-20250514
default_language: zh
snapshot_interval: 20
validator_overrides: {}
  # Override validator behavior per-validator
  # Format: { validator_name: 'off' | 'warning' | 'error' }
  # Example: { factual_detail: 'warning', voice_drift: 'off' }
circuit_breaker:
  max_retries: 3
  # Maximum render retries before marking scene as needs_review
review_expiry:
  enabled: false
  auto_resolve_days: 30
  # Auto-resolve unresolved reviews after N days
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
  .option('--strict', 'Enforce strict ISS thresholds')
  .option('--event <eventId>', 'Validate a specific event only')
  .action((options: { strict?: boolean; event?: string }) => {
    const projectDir = ensureProjectDir();

    const result = validateNovel(projectDir);

    if (options.event) {
      const vr = result.results.get(options.event);
      if (!vr) {
        console.error(`Error: Event "${options.event}" not found.`);
        process.exit(1);
      }
      printValidationResult(vr);
      return;
    }

    let totalErrors = 0;
    let totalWarnings = 0;

    for (const [eventId, vr] of result.results) {
      totalErrors += vr.errors.length;
      totalWarnings += vr.warnings.length;
      if (!vr.passed || vr.warnings.length > 0 || vr.infos.length > 0) {
        console.log(`\n--- ${eventId} ---`);
        printValidationResult(vr);
      }
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Validated ${result.results.size} events`);
    console.log(`  Errors:   ${totalErrors}`);
    console.log(`  Warnings: ${totalWarnings}`);
    console.log(totalErrors === 0 ? '✅ All passed' : '❌ Has errors');

    if (options.strict) {
      const allGaps = result.iss.dimensions.flatMap((d) => d.gaps);
      if (allGaps.length > 0) {
        console.log(`\nISS gaps: ${allGaps.length}`);
        for (const gap of allGaps) {
          console.log(`  - ${gap.suggestion} (${gap.fixTarget})`);
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
    const status = getProjectStatus(projectDir);

    console.log(`\nSummary: ${status.summary.totalEvents} events, ${status.summary.renderedCount} rendered, ${status.summary.blockedCount} blocked`);

    console.log('\n## Events');
    for (const ev of status.events) {
      console.log(`  ${ev.id}: ${ev.status} (chapter ${ev.chapter})${ev.wordCount ? `, ${ev.wordCount} words` : ''}`);
    }

    console.log('\n## Thread Progress');
    for (const t of status.threads) {
      console.log(`  ${t.id}: ${t.progress}/${t.total}`);
    }
  });

// --- assemble ---
program
  .command('assemble')
  .description('Assemble all committed scenes into output/novel.md')
  .option('--output <path>', 'Custom output path')
  .action((options: { output?: string }) => {
    const projectDir = ensureProjectDir();

    const result = assembleNovel({
      projectDir,
      outputPath: options.output,
    });

    console.log(`✅ Novel assembled: ${result.wordCount} words, ${result.sceneCount} scenes`);
    console.log(`   Output: ${options.output ?? path.join(projectDir, 'output', 'novel.md')}`);
  });

// --- entity ---
const entityCmd = program.command('entity').description('Manage entities');

entityCmd
  .command('list [kind]')
  .description('List entities (optionally filtered by kind)')
  .option('--status <status>', 'Filter events by status (draft|rendered|blocked|needs_review)')
  .action((kind?: string, options?: { status?: string }) => {
    const projectDir = ensureProjectDir();

    if (options?.status) {
      // Show events filtered by status
      const mapper = new EntityMapper(projectDir);
      const data = mapper.loadProject();
      const events = mapper.loadAllEvents(data.chapters);
      
      const filtered = events.filter(e => {
        if (e.id === 'system:genesis') return false;
        return e.status === options!.status;
      });
      
      if (filtered.length === 0) {
        console.log(`No events with status "${options.status}".`);
        return;
      }
      
      for (const e of filtered) {
        console.log(`  ${e.id}: "${e.title}" — ${e.status}`);
      }
      return;
    }

    const entities = listEntities(projectDir, kind);

    for (const e of entities) {
      console.log(`  [${e.kind}] ${e.name || e.id} (${e.id})`);
    }
  });

entityCmd
  .command('show <id>')
  .description('Show entity details')
  .action((id: string) => {
    const projectDir = ensureProjectDir();
    const entity = showEntity(projectDir, id);

    if (!entity) {
      console.error(`Entity "${id}" not found.`);
      process.exit(1);
    }

    console.log(`\n${entity.name || entity.id} (${entity.id})`);
    console.log(`Kind: ${entity.kind}`);
    console.log(`Definition: ${entity.definitionFile}`);
    console.log('\nState:');
    for (const [key, value] of Object.entries(entity.state as Record<string, unknown>)) {
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

    const result = await renderNovel({
      projectDir,
      model: options.model,
      eventId: options.all ? undefined : eventId,
      dryRun: options.dryRun,
    });

    if (result.errors.length > 0 && result.results.length === 0) {
      console.error('Render errors:');
      for (const err of result.errors) {
        console.error(`  ❌ ${err}`);
      }
      process.exit(1);
    }

    for (const r of result.results) {
      const status = r.errors.length > 0 ? '❌' : '✅';
      if (options.dryRun) {
        console.log(`  ${status} ${r.eventId}: Dry-run (saved to .nova/dry-runs/)`);
      } else {
        console.log(`  ${status} ${r.eventId}: ${r.wordCount} words, cache=${r.cacheHit}`);
      }
      for (const e of r.errors) console.log(`       Error: ${e}`);
    }

    if (result.errors.length > 0) {
      console.error('\nPipeline errors:');
      for (const err of result.errors) {
        console.error(`  ❌ ${err}`);
      }
    }

    if (!options.dryRun && result.results.length > 0) {
      console.log(`\nDone. Output written to scenes/`);
    }
  });

// --- diff ---
program
  .command('diff <event>')
  .description('Show state changes for an event')
  .action((eventId: string) => {
    const projectDir = ensureProjectDir();
    const result = diffEvent(projectDir, eventId);

    if (!result) {
      console.error(`Error: Event "${eventId}" not found.`);
      process.exit(1);
    }

    console.log(`\nChanges: ${result.changed.length} attributes`);
    console.log('━'.repeat(50));
    for (const key of result.changed) {
      console.log(`  ${key}:`);
      console.log(`    before: ${JSON.stringify(result.before[key])}`);
      console.log(`    after:  ${JSON.stringify(result.after[key])}`);
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

// --- graph ---
program
  .command('graph')
  .description('Export DAG visualization of causal event edges')
  .option('--format <format>', 'Output format (dot or mermaid)', 'dot')
  .action((options: { format?: string }) => {
    const projectDir = ensureProjectDir();

    const mapper = new EntityMapper(projectDir);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);
    const { edges } = buildCausalEdges(events);

    const eventProps = events.map((e: { id: string; title: string; sceneType: string }) => ({
      eventId: e.id,
      title: e.title,
      sceneType: e.sceneType,
    }));

    const output = options.format === 'mermaid'
      ? exportDAGtoMermaid(edges, eventProps)
      : exportDAGtoDOT(edges, eventProps);

    console.log(output);
  });

// --- bench ---
program
  .command('bench')
  .description('Run regression + performance benchmarks against the project')
  .option('--regression', 'Run only regression benchmarks', false)
  .option('--performance', 'Run only performance benchmarks', false)
  .action(async (options: { regression?: boolean; performance?: boolean }) => {
    const projectDir = ensureProjectDir();

    const onlyReg = options.regression && !options.performance;
    const onlyPerf = options.performance && !options.regression;

    if (onlyReg) {
      console.log('── Regression Benchmarks ──');
      const r = await runRegressionBench(projectDir);
      for (const s of r.stages) {
        const icon = s.passed ? '✅' : '❌';
        console.log(`  ${icon} ${s.stage}: ${s.passed ? 'PASS' : 'FAIL'} (${s.ms}ms) — ${s.detail}`);
      }
      console.log(`  ── ${r.totalPassed}/${r.stages.length} passed, ${r.totalFailed} failed, ${r.totalTime}ms total ──`);
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
