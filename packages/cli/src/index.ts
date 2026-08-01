// ============================================================================
// Novalistically CLI — Command-line interface
// ============================================================================

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAll, runPerformanceBench, runRegressionBench } from '@novalistically/bench';
import type {
  BranchPath,
  CommentFilter,
  EditorialRenderRequestV1,
  EditorialRuntime,
  EditorialScopedRequestV1,
  NewReviewComment,
  RenderGameDialogueTreeRequestV1,
  ReviewComment,
  SceneProseInput,
  SceneSelector,
  SourceChangePreviewV1,
  SourceDocumentV1,
} from '@novalistically/core';
import {
  addReviewComment,
  adoptSceneProse,
  analyzeProjectImpact,
  applySourceChange,
  assembleCanonicalNovel,
  assembleCustomNovel,
  branchPathsEqual,
  compileGameDialogueTree,
  computeEvidenceHash,
  diffEvent,
  exportDAGtoDOT,
  exportDAGtoMermaid,
  FsStorage,
  getEditorialOperation,
  getProjectStatus,
  getSourceDocument,
  initializeProject,
  inspectScenes,
  listEditorialOperations,
  listEntities,
  listReviewComments,
  listSceneRevisions,
  listSourceDocuments,
  MockPass2Provider,
  previewEditorialRun,
  previewSourceChange,
  reconcileSourceWorkingCopy,
  renderGameDialogueTree,
  renderNovel,
  replaceReviewComment,
  resolveTemporalContext,
  rollbackSceneRevision,
  setSceneLock,
  showEntity,
  TypedEventBus,
  updateReviewComment,
  validateNovel,
  verifyEvidenceChain,
} from '@novalistically/core';
import { Command } from 'commander';

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

function parseBranchPath(raw: string | undefined): BranchPath | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--branch-path must be valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !('decisions' in parsed) ||
    !Array.isArray(parsed.decisions)
  ) {
    throw new Error('--branch-path must be exactly { "decisions": [...] }');
  }
  for (const decision of parsed.decisions) {
    if (
      typeof decision !== 'object' ||
      decision === null ||
      Array.isArray(decision) ||
      Object.keys(decision).length !== 3 ||
      typeof decision.atEventId !== 'string' ||
      typeof decision.choiceId !== 'string' ||
      typeof decision.narrativeOrder !== 'number' ||
      !Number.isFinite(decision.narrativeOrder)
    ) {
      throw new Error(
        '--branch-path decisions must contain exactly atEventId, choiceId, and narrativeOrder',
      );
    }
  }
  return parsed as BranchPath;
}
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveCliSelector(input: {
  eventId?: string;
  sceneIds?: readonly string[];
  chapter?: string;
  all?: boolean;
}): SceneSelector {
  const explicitSceneIds = input.sceneIds ?? [];
  const scopedByChapterOrAll = input.chapter !== undefined || Boolean(input.all);
  const eventIds = [
    ...(!scopedByChapterOrAll && input.eventId ? [input.eventId] : []),
    ...explicitSceneIds,
  ];
  const modes =
    Number(eventIds.length > 0) + Number(input.chapter !== undefined) + Number(Boolean(input.all));
  if (modes !== 1) {
    throw new Error('Choose exactly one selector: [event]/--scene, --chapter, or --all');
  }
  if (input.all) return { type: 'all' };
  if (input.chapter !== undefined) {
    const chapter = Number(input.chapter);
    if (!Number.isInteger(chapter) || chapter <= 0) {
      throw new Error('--chapter must be a positive integer');
    }
    return { type: 'chapter', chapter };
  }
  return { type: 'events', eventIds: [...new Set(eventIds)] };
}

function computeProjectSourceHash(documents: readonly SourceDocumentV1[]): string {
  const digest = crypto.createHash('sha256');
  for (const document of [...documents].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update(`${document.path}\0${document.contentHash}\0`);
  }
  return digest.digest('hex');
}

function resolveRoute(options: { branchPath?: BranchPath; discourseBranch?: string }): {
  branchPath?: BranchPath;
  discourseBranch?: string;
} {
  return {
    ...(options.branchPath ? { branchPath: options.branchPath } : {}),
    ...(options.discourseBranch ? { discourseBranch: options.discourseBranch } : {}),
  };
}

function requireCompleteGameLeaf(
  projectDir: string,
  branchPath: BranchPath | undefined,
  discourseBranch: string | undefined,
): void {
  // Assemble requires an explicit complete leaf route. The no-path rule is
  // scoped to this pre-check; shared runtime callers keep their no-route
  // behavior.
  if (!branchPath) {
    throw new Error('Game dialogue assembly requires one complete, ordered leaf --branch-path');
  }
  // Compile the canonical runtime against the SELECTED route — never the
  // implicit default branch — so a project whose dialogue ledger has no
  // "main" chapter sequence still reaches the leaf-completeness check.
  const project = initializeProject(
    projectDir,
    new FsStorage(),
    resolveRoute({ branchPath, discourseBranch }),
  );
  const temporalContext = resolveTemporalContext(project.events, project.data.timeAnchors);
  const tree = compileGameDialogueTree(project.events, temporalContext);
  if (tree && !tree.leafPaths.some((leafPath) => branchPathsEqual(leafPath, branchPath))) {
    throw new Error('Game dialogue assembly requires one complete, ordered leaf --branch-path');
  }
}

// ============================================================================
// Commands
// ============================================================================

const program = new Command();

program.name('nova').description('Novalistically — Narrative Engineering System').version('0.1.0');

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
      'chapters/chapter_01',
      'scenes',
      'notes',
      'reference',
      'output',
      'reviews',
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

    // Write nova.yaml
    const novaYaml = `project: ${name}
title: "${name}"
author: "Author"
defaultModel: claude-sonnet-4-20250514
defaultLanguage: zh
snapshotInterval: 20
validatorOverrides: {}
  # Override validator behavior per-validator
  # Format: { validator_name: 'off' | 'warning' | 'error' }
  # Example: { factual_detail: 'warning', voice_drift: 'off' }
circuitBreaker:
  maxRetries: 3
  # Maximum render retries before marking scene as needs_review
reviewExpiry:
  enabled: false
  autoResolveDays: 30
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
    at: day_0
    description: "Day 0 — Story begins"

threads: []

world_facts: []
`;
    fs.writeFileSync(
      path.join(projectDir, 'definitions', 'state_initial.yaml'),
      stateInitial,
      'utf-8',
    );

    // Write entity type catalog template (versionless source contract).
    // Declares the six supported kinds with lifecycle + common attributes;
    // extend attributes per kind before writing to them in story facts.
    const entityTypesYaml = `# definitions/entity-types.yaml
# Entity type catalog — strict, versionless source contract (no version fields).
# Every entity kind the story writes to must be declared here with explicit
# attribute policies; undeclared attributes fail validation on write.
types:
  character:
    typeId: character
    kind: character
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      name:
        attributeId: name
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      age:
        attributeId: age
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
      gender:
        attributeId: gender
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      appearance:
        attributeId: appearance
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: appearance
      emotionalState:
        attributeId: emotionalState
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: emotional
      location:
        attributeId: location
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: location
      status:
        attributeId: status
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: lifecycle
      traits:
        attributeId: traits
        valueType: string_list
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
  location:
    typeId: location
    kind: location
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      name:
        attributeId: name
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      description:
        attributeId: description
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      status:
        attributeId: status
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: lifecycle
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
  item:
    typeId: item
    kind: item
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      name:
        attributeId: name
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      description:
        attributeId: description
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      status:
        attributeId: status
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: lifecycle
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
  faction:
    typeId: faction
    kind: faction
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      name:
        attributeId: name
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      description:
        attributeId: description
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      status:
        attributeId: status
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: lifecycle
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
  concept:
    typeId: concept
    kind: concept
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      description:
        attributeId: description
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      value:
        attributeId: value
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: identity
    typedInvariants: []
  rule:
    typeId: rule
    kind: rule
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates:
          - active
          - inactive
          - retired
        unsetAllowed: false
        semanticRole: lifecycle
      name:
        attributeId: name
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      category:
        attributeId: category
        valueType: string
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
    lifecyclePolicy:
      allowedTransitions:
        - - active
          - inactive
        - - active
          - retired
        - - inactive
          - active
        - - inactive
          - retired
    referenceCapabilities:
      defaultEligibility: identity
    typedInvariants: []
`;
    fs.writeFileSync(
      path.join(projectDir, 'definitions', 'entity-types.yaml'),
      entityTypesYaml,
      'utf-8',
    );

    // Write an initial event with the event-local choice contract as comments.
    const eventFile = `# chapters/chapter_01/E1.yaml
event: E1
narrativeOrder: 1
title: "Opening scene"
storyTime: story_beginning
pov:
  character: narrator
  type: omniscient
sceneBrief: "Describe this continuous dramatic unit."
beats:
  - "Describe the first action or turn of this scene."
  - "Describe the second action or turn of this scene."
preconditions: []

# choices:
#   - id: accept_hunt
#     label: "Accept the hunt"
#     description: "Enter the jungle with a knife and three hours' head start."
#     targetEvent: E2
#     effects:
#       - entity: protagonist
#         attribute: chose_hunt
#         value: true
`;
    fs.writeFileSync(
      path.join(projectDir, 'chapters', 'chapter_01', 'E1.yaml'),
      eventFile,
      'utf-8',
    );

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
  .action(async (options: { strict?: boolean; event?: string }) => {
    const projectDir = ensureProjectDir();

    const result = await validateNovel(projectDir, undefined, new FsStorage());

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
    if (totalErrors > 0) process.exitCode = 1;

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

function printValidationResult(result: {
  errors: Array<{
    message: string;
    validator?: string;
    kind?: string;
    observationRef?: { field?: string; analysisPointer?: string };
  }>;
  warnings: Array<{
    message: string;
    validator?: string;
    kind?: string;
    observationRef?: { field?: string; analysisPointer?: string };
  }>;
  infos: Array<{ message: string; kind?: string }>;
  passed: boolean;
}) {
  for (const err of result.errors) {
    const kind = err.kind ? ` (${err.kind})` : '';
    const ref = err.observationRef
      ? ` [${err.observationRef.field}${err.observationRef.analysisPointer ? ` ${err.observationRef.analysisPointer}` : ''}]`
      : '';
    console.log(
      `  ❌ ERROR${err.validator ? ` [${err.validator}]` : ''}${kind}${ref}: ${err.message}`,
    );
  }
  for (const warn of result.warnings) {
    const kind = warn.kind ? ` (${warn.kind})` : '';
    const ref = warn.observationRef
      ? ` [${warn.observationRef.field}${warn.observationRef.analysisPointer ? ` ${warn.observationRef.analysisPointer}` : ''}]`
      : '';
    console.log(
      `  ⚠️  WARNING${warn.validator ? ` [${warn.validator}]` : ''}${kind}${ref}: ${warn.message}`,
    );
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
    const status = getProjectStatus(projectDir, undefined, new FsStorage());

    console.log(
      `\nSummary: ${status.summary.totalEvents} events, ${status.summary.renderedCount} rendered, ${status.summary.blockedCount} blocked`,
    );

    console.log('\n## Events');
    for (const ev of status.events) {
      console.log(
        `  ${ev.id}: ${ev.status} (chapter ${ev.chapter})${ev.wordCount ? `, ${ev.wordCount} words` : ''}`,
      );
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
  .option('--branch-path <json>', 'Complete game-tree BranchPath JSON')
  .option('--discourse-branch <name>', 'Discourse branch name (default: main)')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .action(
    (options: {
      output?: string;
      branchPath?: string;
      discourseBranch?: string;
      actor?: string;
    }) => {
      const projectDir = ensureProjectDir();
      let branchPath: BranchPath | undefined;
      try {
        branchPath = parseBranchPath(options.branchPath);
        requireCompleteGameLeaf(projectDir, branchPath, options.discourseBranch);
      } catch (error) {
        console.error(`Invalid --branch-path: ${(error as Error).message}`);
        process.exit(1);
      }
      const request = {
        version: 1 as const,
        projectDir,
        mutation: {
          operationId: crypto.randomUUID(),
          actorId: options.actor ?? 'local-cli',
        },
        ...(options.output ? { outputPath: options.output } : {}),
        ...resolveRoute({ branchPath, discourseBranch: options.discourseBranch }),
      };
      const result = options.output
        ? assembleCustomNovel(request)
        : assembleCanonicalNovel(request);
      console.log(`Novel assembled: ${result.wordCount} words, ${result.sceneCount} scenes`);
      console.log(`   Output: ${result.publication.outputPath}`);
    },
  );

// --- entity ---
const entityCmd = program.command('entity').description('Manage entities');

entityCmd
  .command('list [kind]')
  .description('List entities (optionally filtered by kind)')
  .option('--status <status>', 'Filter events by status (draft|rendered|blocked|needs_review)')
  .action((kind?: string, options?: { status?: string }) => {
    const projectDir = ensureProjectDir();

    if (options?.status) {
      // Show events filtered by status (authored events only)
      const events = initializeProject(projectDir, new FsStorage()).events;

      const filtered = events.filter((e) => e.status === options?.status);

      if (filtered.length === 0) {
        console.log(`No events with status "${options.status}".`);
        return;
      }

      for (const e of filtered) {
        console.log(`  ${e.id}: "${e.title}" — ${e.status}`);
      }
      return;
    }

    const entities = listEntities(projectDir, kind, new FsStorage());

    for (const e of entities) {
      console.log(`  [${e.kind}] ${e.name || e.id} (${e.id})`);
    }
  });

entityCmd
  .command('show <id>')
  .description('Show entity details')
  .action((id: string) => {
    const projectDir = ensureProjectDir();
    const entity = showEntity(projectDir, id, new FsStorage());

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
// scene — Inspect and manage scene revisions
// ============================================================================

const sceneCmd = program.command('scene').description('Inspect and manage scene revisions');

sceneCmd
  .command('list')
  .description('List all scenes with inspection state')
  .option(
    '--status <status>',
    'Filter by state: missing | current | stale | manual_change_untracked | legacy_unverified',
  )
  .option('--chapter <number>', 'Filter by chapter number')
  .option('--json', 'Output as JSON')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .action(async (opts: { status?: string; chapter?: string; json?: boolean; actor?: string }) => {
    const projectDir = ensureProjectDir();
    const request: EditorialScopedRequestV1 & { selector?: SceneSelector } = {
      version: 1,
      projectDir,
    };
    if (opts.chapter) {
      request.selector = { type: 'chapter', chapter: Number(opts.chapter) };
    }

    const scenes = await inspectScenes(request);
    const filtered = opts.status ? scenes.filter((s) => s.state === opts.status) : scenes;

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    if (filtered.length === 0) {
      console.log('No scenes found.');
      return;
    }

    for (const s of filtered) {
      const lockMark = s.locked ? '🔒' : ' ';
      const stateMark = s.state === 'current' ? '✅' : s.state === 'missing' ? '❌' : '⚠️';
      console.log(
        `  ${stateMark}${lockMark} E${s.eventId} (ch ${s.chapter}): ${s.state}${s.revisionId ? ` rev=${s.revisionId.slice(0, 8)}` : ''} reviews=${s.openReviewCount}`,
      );
    }
  });

sceneCmd
  .command('show <eventId>')
  .description('Show detailed scene inspection for an event')
  .option('--json', 'Output as JSON')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .action(async (eventId: string, opts: { json?: boolean; actor?: string }) => {
    const projectDir = ensureProjectDir();
    const request: EditorialScopedRequestV1 & { selector?: SceneSelector } = {
      version: 1,
      projectDir,
      selector: { type: 'events', eventIds: [eventId] },
    };

    const scenes = await inspectScenes(request);
    const scene = scenes.find((s) => s.eventId === eventId);
    if (!scene) {
      console.error(`Scene "${eventId}" not found.`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(scene, null, 2));
      return;
    }

    console.log(`\nEvent: ${scene.eventId}`);
    console.log(`Chapter: ${scene.chapter}`);
    console.log(`State: ${scene.state}`);
    console.log(`Locked: ${scene.locked}`);
    console.log(`Prose source: ${scene.proseSource ?? 'none'}`);
    console.log(`Prose hash: ${scene.proseHash ?? 'none'}`);
    console.log(`Open reviews: ${scene.openReviewCount}`);
    console.log(`Revision: ${scene.revisionId ?? 'none'}`);
    if (scene.latestCandidate) {
      console.log(
        `Latest candidate: ${scene.latestCandidate.revisionId} (${scene.latestCandidate.status})`,
      );
    }
    if (scene.staleReasons.length > 0) {
      console.log('Stale reasons:');
      for (const r of scene.staleReasons) {
        console.log(`  - [${r.code}] ${r.message}`);
      }
    }
  });

sceneCmd
  .command('history <eventId>')
  .description('Show revision history for a scene')
  .option('--json', 'Output as JSON')
  .action((eventId: string, opts: { json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const revisions = listSceneRevisions({ projectDir, eventId });

    if (opts.json) {
      console.log(JSON.stringify(revisions, null, 2));
      return;
    }

    if (revisions.length === 0) {
      console.log(`No revisions found for "${eventId}".`);
      return;
    }

    console.log(`\nRevision history for "${eventId}":`);
    for (const r of revisions) {
      const headMark = r.isHead ? ' ← HEAD' : '';
      console.log(
        `  ${r.revisionId.slice(0, 12)}  ${r.origin.padEnd(14)}  ${r.createdAt}  ${r.actorId}${headMark}`,
      );
    }
  });

sceneCmd
  .command('adopt <eventId>')
  .description('Evaluate and adopt replacement or working-copy prose')
  .option('--file <path>', 'Read replacement prose from a file')
  .option('--prose <text>', 'Use inline replacement prose')
  .option('--lock', 'Lock the accepted human revision')
  .option('--note <text>', 'Audit note for the adoption')
  .option('--model <model>', 'LLM model to use for Pass 2')
  .option('--provider <provider>', 'Provider: ai-sdk or mock-pass2')
  .option('--reference-dir <path>', 'Approved mock reference directory')
  .option('--branch-path <json>', 'Complete game-tree BranchPath JSON')
  .option('--discourse-branch <name>', 'Discourse branch name (default: main)')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output as JSON')
  .action(
    async (
      eventId: string,
      opts: {
        file?: string;
        prose?: string;
        lock?: boolean;
        note?: string;
        model?: string;
        provider?: string;
        referenceDir?: string;
        branchPath?: string;
        discourseBranch?: string;
        actor?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = ensureProjectDir();
      if (opts.file && opts.prose) {
        console.error('--file and --prose are mutually exclusive');
        process.exit(1);
      }
      if (opts.provider === 'mock-pass2' && !opts.referenceDir) {
        console.error('--provider mock-pass2 requires --reference-dir');
        process.exit(1);
      }
      if (opts.provider && opts.provider !== 'ai-sdk' && opts.provider !== 'mock-pass2') {
        console.error(`Unsupported provider: ${opts.provider}`);
        process.exit(1);
      }
      let branchPath: BranchPath | undefined;
      try {
        branchPath = parseBranchPath(opts.branchPath);
      } catch (error) {
        console.error(`Invalid --branch-path: ${(error as Error).message}`);
        process.exit(1);
      }
      const [current] = await inspectScenes({
        version: 1,
        projectDir,
        selector: { type: 'events', eventIds: [eventId] },
        ...resolveRoute({ branchPath, discourseBranch: opts.discourseBranch }),
      });
      if (!current) {
        console.error(`Scene "${eventId}" not found.`);
        process.exit(1);
      }
      let proseInput: SceneProseInput;
      if (opts.file || opts.prose !== undefined) {
        const prose = opts.file ? fs.readFileSync(opts.file, 'utf-8') : (opts.prose ?? '');
        proseInput = {
          type: 'replacement',
          prose,
          expectedRevisionId: current.revisionId,
          expectedSceneHash: current.sceneHash,
        };
      } else {
        if (current.sceneContent === null) {
          console.error(`Scene "${eventId}" has no working copy.`);
          process.exit(1);
        }
        proseInput = {
          type: 'working_copy',
          expectedSceneHash: crypto.createHash('sha256').update(current.sceneContent).digest('hex'),
        };
      }
      const result = await adoptSceneProse(
        {
          version: 1,
          projectDir,
          mutation: {
            operationId: crypto.randomUUID(),
            actorId: opts.actor ?? 'local-cli',
          },
          eventId,
          input: proseInput,
          ...(opts.lock ? { lockAfter: true } : {}),
          ...(opts.note ? { note: opts.note } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...resolveRoute({ branchPath, discourseBranch: opts.discourseBranch }),
        },
        {
          provider:
            opts.provider === 'mock-pass2'
              ? new MockPass2Provider({ referenceDir: opts.referenceDir })
              : undefined,
        },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.released) {
        console.log(
          `✅ Scene "${eventId}" adopted ` + `(rev=${result.revisionId?.slice(0, 12) ?? 'none'})`,
        );
      } else {
        console.error('❌ Scene adoption blocked:');
        for (const error of result.editorialErrors) {
          console.error(`  [${error.code}] ${error.message}`);
        }
      }
      if (!result.released) process.exit(1);
    },
  );

sceneCmd
  .command('lock <eventId>')
  .description('Lock a scene to prevent edits')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output as JSON')
  .action(async (eventId: string, opts: { actor?: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const actorId = opts.actor ?? 'local-cli';
    const operationId = crypto.randomUUID();
    const [current] = await inspectScenes({
      version: 1,
      projectDir,
      selector: { type: 'events', eventIds: [eventId] },
    });
    if (!current?.sceneHash) {
      console.error(`Scene "${eventId}" has no accepted head.`);
      process.exit(1);
    }

    const result = await setSceneLock({
      version: 1,
      projectDir,
      mutation: { operationId, actorId },
      eventId,
      locked: true,
      expectedSceneHash: current.sceneHash,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.locked) {
      console.log(`🔒 Scene "${eventId}" locked.`);
    } else {
      console.error(`❌ Failed to lock scene "${eventId}".`);
      for (const e of result.editorialErrors) {
        console.error(`  [${e.code}] ${e.message}`);
      }
      process.exit(1);
    }
  });

sceneCmd
  .command('unlock <eventId>')
  .description('Unlock a scene to allow edits')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output as JSON')
  .action(async (eventId: string, opts: { actor?: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const actorId = opts.actor ?? 'local-cli';
    const operationId = crypto.randomUUID();
    const [current] = await inspectScenes({
      version: 1,
      projectDir,
      selector: { type: 'events', eventIds: [eventId] },
    });
    if (!current?.sceneHash) {
      console.error(`Scene "${eventId}" has no accepted head.`);
      process.exit(1);
    }

    const result = await setSceneLock({
      version: 1,
      projectDir,
      mutation: { operationId, actorId },
      eventId,
      locked: false,
      expectedSceneHash: current.sceneHash,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!result.locked) {
      console.log(`🔓 Scene "${eventId}" unlocked.`);
    } else {
      console.error(`❌ Failed to unlock scene "${eventId}".`);
      for (const e of result.editorialErrors) {
        console.error(`  [${e.code}] ${e.message}`);
      }
      process.exit(1);
    }
  });

sceneCmd
  .command('rollback <eventId> <revisionId>')
  .description('Roll back a scene to a previous revision')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output as JSON')
  .action(async (eventId: string, revisionId: string, opts: { actor?: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const actorId = opts.actor ?? 'local-cli';
    const operationId = crypto.randomUUID();

    const result = await rollbackSceneRevision({
      version: 1,
      projectDir,
      mutation: { operationId, actorId },
      eventId,
      revisionId,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.released) {
      console.log(`✅ Scene "${eventId}" rolled back to revision ${revisionId.slice(0, 12)}.`);
    } else {
      console.error(`❌ Rollback failed for "${eventId}":`);
      for (const e of result.editorialErrors) {
        console.error(`  [${e.code}] ${e.message}`);
      }
      process.exit(1);
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
  .argument('<action>', 'list | add | replace | resolve | wontfix | reopen | escalate')
  .argument('[targetId]', 'Event ID or comment ID to target')
  .argument('[message]', 'Comment text (for add/replace actions)')
  .option(
    '--severity <severity>',
    'Severity for "add" action: info | warning | blocking',
    'warning',
  )
  .option('--category <category>', 'Review category', 'style')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output machine-readable JSON')
  .action(
    (
      action: string,
      targetId: string | undefined,
      message: string | undefined,
      opts: {
        severity?: string;
        category?: NewReviewComment['category'];
        actor?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = ensureProjectDir();
      const actorId = opts.actor ?? 'local-cli';
      const operationId = crypto.randomUUID();

      switch (action) {
        case 'list': {
          const filter: CommentFilter = {};
          if (targetId) filter.targetId = targetId;
          const comments = listReviewComments({ projectDir, filter });
          if (opts.json) {
            console.log(JSON.stringify(comments, null, 2));
            break;
          }
          if (comments.length === 0) {
            console.log('No review comments found.');
            return;
          }
          for (const c of comments) {
            console.log(
              `[${c.severity}] ${c.status} ${c.target.type}:${c.target.id} — ${c.content}`,
            );
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
          const input: NewReviewComment = {
            target: { type: 'scene', id: targetId },
            severity: severityMap[opts.severity || 'warning'] ?? 'suggestion',
            category: opts.category ?? 'style',
            content: message,
          };
          const comment = addReviewComment({
            projectDir,
            input,
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(comment, null, 2)
              : `Review comment added: ${comment.id} (op=${operationId})`,
          );
          break;
        }

        case 'replace': {
          if (!targetId || !message) {
            console.error('Usage: nova review replace <commentId> "<message>"');
            process.exit(1);
          }
          const current = listReviewComments({ projectDir }).find(
            (comment) => comment.id === targetId,
          );
          if (!current) {
            console.error(`Review comment not found: ${targetId}`);
            process.exit(1);
          }
          const replacement = replaceReviewComment({
            projectDir,
            commentId: targetId,
            input: {
              target: current.target,
              severity: current.severity,
              category: current.category,
              content: message,
            },
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(replacement, null, 2)
              : `Review comment replaced: ${replacement.id} (op=${operationId})`,
          );
          break;
        }

        case 'wontfix': {
          if (!targetId) {
            console.error('Usage: nova review wontfix <commentId>');
            process.exit(1);
          }
          const comment = updateReviewComment({
            projectDir,
            commentId: targetId,
            action: 'wontfix',
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(comment, null, 2)
              : `Comment marked wontfix: ${targetId} (op=${operationId})`,
          );
          break;
        }

        case 'resolve': {
          if (!targetId) {
            console.error('Usage: nova review resolve <commentId>');
            process.exit(1);
          }
          const comment = updateReviewComment({
            projectDir,
            commentId: targetId,
            action: 'resolve',
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(comment, null, 2)
              : `Comment resolved: ${targetId} (op=${operationId})`,
          );
          break;
        }

        case 'reopen': {
          if (!targetId) {
            console.error('Usage: nova review reopen <commentId>');
            process.exit(1);
          }
          const comment = updateReviewComment({
            projectDir,
            commentId: targetId,
            action: 'reopen',
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(comment, null, 2)
              : `Comment reopened: ${targetId} (op=${operationId})`,
          );
          break;
        }

        case 'escalate': {
          if (!targetId) {
            console.error('Usage: nova review escalate <commentId>');
            process.exit(1);
          }
          const comment = updateReviewComment({
            projectDir,
            commentId: targetId,
            action: 'escalate',
            mutation: { operationId, actorId },
          });
          console.log(
            opts.json
              ? JSON.stringify(comment, null, 2)
              : `Comment escalated: ${targetId} (op=${operationId})`,
          );
          break;
        }

        default:
          console.error(
            `Unknown action: "${action}". Use: list, add, replace, resolve, wontfix, reopen, escalate`,
          );
          process.exit(1);
      }
    },
  );

// --- render ---
program
  .command('render [event]')
  .description('Render one or more scenes, a chapter, or the full branch')
  .option('--dry-run', 'Compile context without calling an LLM')
  .option('--scene <event>', 'Add an event to the render selector', collectOption, [])
  .option('--all', 'Render all branch-required events')
  .option('--chapter <number>', 'Render a single chapter by number')
  .option('--model <model>', 'LLM model to use (overrides config)')
  .option('--provider <provider>', 'Provider: ai-sdk or mock-pass2')
  .option('--reference-dir <path>', 'Approved mock reference directory')
  .option('--trace', 'Emit trace JSONL in the configured work directory')
  .option('--concurrency <number>', 'Max concurrent LLM calls')
  .option('--branch-path <json>', 'Complete game-tree BranchPath JSON')
  .option('--discourse-branch <name>', 'Discourse branch name (default: main)')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output the core DTO as JSON')
  .action(
    async (
      eventId: string | undefined,
      options: {
        dryRun?: boolean;
        scene?: string[];
        all?: boolean;
        chapter?: string;
        model?: string;
        provider?: string;
        referenceDir?: string;
        trace?: boolean;
        concurrency?: string;
        branchPath?: string;
        discourseBranch?: string;
        actor?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = ensureProjectDir();
      let branchPath: BranchPath | undefined;
      let selector: SceneSelector;
      try {
        branchPath = parseBranchPath(options.branchPath);
      } catch (error) {
        console.error(`Invalid --branch-path: ${(error as Error).message}`);
        process.exit(1);
      }
      try {
        selector = resolveCliSelector({
          eventId,
          sceneIds: options.scene,
          chapter: options.chapter,
          all: options.all,
        });
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
      if (options.provider === 'mock-pass2' && !options.referenceDir) {
        console.error('--provider mock-pass2 requires --reference-dir');
        process.exit(1);
      }
      if (options.provider && options.provider !== 'ai-sdk' && options.provider !== 'mock-pass2') {
        console.error(`Unsupported provider: ${options.provider}`);
        process.exit(1);
      }
      const provider =
        options.provider === 'mock-pass2'
          ? new MockPass2Provider({ referenceDir: options.referenceDir })
          : undefined;
      const eventBus = new TypedEventBus();
      eventBus.on('pipeline:render:after', (data) => {
        const mark = data.success && data.errorCount === 0 ? '✓' : '·';
        console.error(`  ${mark} ${data.eventId}: ${data.wordCount} words, cache=${data.cacheHit}`);
      });
      const request: EditorialRenderRequestV1 = {
        version: 1,
        projectDir,
        selector,
        mutation: {
          operationId: crypto.randomUUID(),
          actorId: options.actor ?? 'local-cli',
        },
        ...(options.model ? { model: options.model } : {}),
        ...resolveRoute({ branchPath, discourseBranch: options.discourseBranch }),
      };
      const runtime: EditorialRuntime = {
        storage: new FsStorage(),
        provider,
        eventBus,
        trace: options.trace,
        concurrency: options.concurrency ? Number(options.concurrency) : undefined,
      };
      if (options.dryRun) {
        const { mutation: _, ...previewRequest } = request;
        const preview = await previewEditorialRun(previewRequest, runtime);
        if (options.json) {
          console.log(JSON.stringify(preview, null, 2));
        } else {
          for (const scene of preview.scenes) {
            console.log(`  · ${scene.eventId}: Dry-run (state: ${scene.state})`);
          }
          for (const error of preview.errors) {
            console.error(`  ❌ ${error}`);
          }
        }
        if (preview.errors.length > 0 && preview.scenes.length === 0) {
          process.exit(1);
        }
        return;
      }
      const result = await renderNovel(request, runtime);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const entry of result.results) {
          console.log(
            `  ${entry.released ? '✅' : '❌'} ${entry.eventId}: ` +
              `${entry.wordCount} words, cache=${entry.cacheHit}`,
          );
          for (const error of entry.errors) {
            console.log(`       Error: ${error}`);
          }
          for (const message of entry.validationIssueMessages) {
            console.log(`       Validation: ${message}`);
          }
        }
        if (result.results.length > 0) {
          console.log('\nDone. Output written to scenes/');
        }
      }
      for (const error of result.editorialErrors) {
        console.error(
          `  ❌ [${error.code}] ${error.eventId ? `${error.eventId}: ` : ''}${error.message}`,
        );
      }
      if (result.results.some((entry) => !entry.released) || result.editorialErrors.length > 0) {
        process.exit(1);
      }
    },
  );

program
  .command('revise [event]')
  .description('Revise accepted prose using open review feedback')
  .option('--scene <event>', 'Add an event to the revision selector', collectOption, [])
  .option('--all', 'Revise all branch-required events')
  .option('--chapter <number>', 'Revise a single chapter by number')
  .option('--review <id>', 'Apply a specific open review', collectOption, [])
  .option('--instruction <text>', 'Inline instruction for a single scene')
  .option('--model <model>', 'LLM model to use (overrides config)')
  .option('--provider <provider>', 'Provider: ai-sdk or mock-pass2')
  .option('--reference-dir <path>', 'Approved mock reference directory')
  .option('--branch-path <json>', 'Complete game-tree BranchPath JSON')
  .option('--discourse-branch <name>', 'Discourse branch name (default: main)')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output the core DTO as JSON')
  .action(
    async (
      eventId: string | undefined,
      options: {
        scene?: string[];
        all?: boolean;
        chapter?: string;
        review?: string[];
        instruction?: string;
        model?: string;
        provider?: string;
        referenceDir?: string;
        branchPath?: string;
        discourseBranch?: string;
        actor?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = ensureProjectDir();
      let branchPath: BranchPath | undefined;
      let selector: SceneSelector;
      try {
        branchPath = parseBranchPath(options.branchPath);
      } catch (error) {
        console.error(`Invalid --branch-path: ${(error as Error).message}`);
        process.exit(1);
      }
      try {
        selector = resolveCliSelector({
          eventId,
          sceneIds: options.scene,
          chapter: options.chapter,
          all: options.all,
        });
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
      if (options.provider === 'mock-pass2' && !options.referenceDir) {
        console.error('--provider mock-pass2 requires --reference-dir');
        process.exit(1);
      }
      if (options.provider && options.provider !== 'ai-sdk' && options.provider !== 'mock-pass2') {
        console.error(`Unsupported provider: ${options.provider}`);
        process.exit(1);
      }
      const result = await renderNovel(
        {
          version: 1,
          projectDir,
          selector,
          revision: {
            ...(options.review?.length ? { reviewIds: options.review } : {}),
            ...(options.instruction ? { instruction: options.instruction } : {}),
          },
          mutation: {
            operationId: crypto.randomUUID(),
            actorId: options.actor ?? 'local-cli',
          },
          ...(options.model ? { model: options.model } : {}),
          ...resolveRoute({ branchPath, discourseBranch: options.discourseBranch }),
        },
        {
          storage: new FsStorage(),
          provider:
            options.provider === 'mock-pass2'
              ? new MockPass2Provider({ referenceDir: options.referenceDir })
              : undefined,
        },
      );
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const entry of result.results) {
          console.log(
            `  ${entry.released ? '✅' : '❌'} ${entry.eventId}: ` + `${entry.disposition}`,
          );
        }
      }
      for (const error of result.editorialErrors) {
        console.error(`  ❌ [${error.code}] ${error.message}`);
      }
      if (result.results.some((entry) => !entry.released) || result.editorialErrors.length > 0) {
        process.exit(1);
      }
    },
  );

program
  .command('render-tree')
  .description('Render every event-local game dialogue node exactly once')
  .option('--model <model>', 'LLM model to use (overrides config)')
  .option('--provider <provider>', 'Provider: ai-sdk or mock-pass2')
  .option('--reference-dir <path>', 'Approved mock reference directory')
  .option('--trace', 'Emit trace JSONL to .nova/traces/<job>.jsonl')
  .option('--concurrency <number>', 'Max concurrent LLM calls')
  .option('--discourse-branch <name>', 'Discourse branch name (default: main)')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .action(
    async (options: {
      model?: string;
      provider?: string;
      referenceDir?: string;
      trace?: boolean;
      concurrency?: string;
      discourseBranch?: string;
      actor?: string;
    }) => {
      const projectDir = ensureProjectDir();
      if (options.provider === 'mock-pass2' && !options.referenceDir) {
        console.error('--provider mock-pass2 requires --reference-dir');
        process.exit(1);
      }
      if (options.provider && options.provider !== 'ai-sdk' && options.provider !== 'mock-pass2') {
        console.error(`Unsupported provider: ${options.provider}`);
        process.exit(1);
      }
      const provider =
        options.provider === 'mock-pass2'
          ? new MockPass2Provider({ referenceDir: options.referenceDir })
          : undefined;
      const eventBus = new TypedEventBus();
      eventBus.on('pipeline:render:after', (data) => {
        const mark = data.success && data.errorCount === 0 ? '✓' : '·';
        console.error(`  ${mark} ${data.eventId}: ${data.wordCount} words, cache=${data.cacheHit}`);
      });

      const operationId = crypto.randomUUID();
      const actor = options.actor ?? 'local-cli';

      const request: RenderGameDialogueTreeRequestV1 = {
        version: 1,
        projectDir,
        mutation: { operationId, actorId: actor },
        model: options.model,
      };
      const runtime: EditorialRuntime = {
        storage: new FsStorage(),
        provider,
        eventBus,
        trace: options.trace,
        concurrency: options.concurrency ? Number(options.concurrency) : undefined,
      };

      const result = await renderGameDialogueTree(request, runtime);
      for (const entry of result.results) {
        console.log(
          `  ${entry.released ? '✅' : '❌'} ${entry.eventId}: ${entry.wordCount} words, cache=${entry.cacheHit}`,
        );
      }
      if (result.errors.length > 0) {
        console.error('Render-tree errors:');
        for (const error of result.errors) console.error(`  ❌ ${error}`);
      }
      if (result.errors.length > 0 || result.results.some((entry) => !entry.released)) {
        process.exit(1);
      }
      if (result.outputPath) {
        console.log(`\nDone. Dialogue tree written to ${result.outputPath}`);
      }
    },
  );
// --- trace ---
const traceCmd = program.command('trace').description('Inspect pipeline trace output');

traceCmd
  .command('event <eventId>')
  .description('Show trace events for a single event')
  .action((eventId: string) => {
    const projectDir = ensureProjectDir();
    const tracesDir = path.join(projectDir, '.nova', 'traces');
    if (!fs.existsSync(tracesDir)) {
      console.error('No trace data found. Run with --trace flag during render first.');
      process.exit(1);
    }
    const files = fs.readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) {
      console.log('No trace files found.');
      return;
    }
    // Load all trace events, filter by eventId
    const matching: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(tracesDir, file), 'utf-8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        try {
          const ev = JSON.parse(line);
          if (ev.eventId === eventId) {
            matching.push(ev);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    if (matching.length === 0) {
      console.log(`No trace events found for event "${eventId}".`);
      return;
    }
    // Display formatted trace
    matching.sort((a, b) => (a.timestamp as string)?.localeCompare(b.timestamp as string) ?? 0);
    console.log(`\nTrace events for "${eventId}" (${matching.length} events):`);
    console.log('━'.repeat(60));
    for (const ev of matching) {
      const phase = String(ev.phase ?? '').padEnd(12);
      const state = String(ev.state ?? '').padEnd(6);
      const dur = ev.durationMs != null ? ` ${String(ev.durationMs).padStart(4)}ms` : '       ';
      const code = ev.code ? ` [${ev.code}]` : '';
      console.log(
        `  ${String(ev.timestamp ?? '').slice(11, 23)}  ${phase} ${state}${dur}${code}  span=${ev.spanId}`,
      );
    }
  });

traceCmd
  .command('stats')
  .description('Show aggregate trace statistics')
  .action(() => {
    const projectDir = ensureProjectDir();
    const tracesDir = path.join(projectDir, '.nova', 'traces');
    if (!fs.existsSync(tracesDir)) {
      console.error('No trace data found. Run with --trace flag during render first.');
      process.exit(1);
    }
    const files = fs.readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) {
      console.log('No trace files found.');
      return;
    }
    // Gather stats
    const phaseCounts: Record<string, number> = {};
    const phaseDurations: Record<string, number[]> = {};
    let totalEvents = 0;
    for (const file of files) {
      const content = fs.readFileSync(path.join(tracesDir, file), 'utf-8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        try {
          const ev = JSON.parse(line);
          totalEvents++;
          const phase = String(ev.phase ?? 'unknown');
          phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
          if (ev.durationMs != null) {
            phaseDurations[phase] = phaseDurations[phase] ?? [];
            phaseDurations[phase].push(Number(ev.durationMs));
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    console.log(`\nTrace Stats (${files.length} files, ${totalEvents} events):`);
    console.log('━'.repeat(60));
    console.log('  Phase               Count    Avg(ms)   Min(ms)   Max(ms)');
    console.log(`  ${'─'.repeat(56)}`);
    const sortedPhases = Object.keys(phaseCounts).sort();
    for (const phase of sortedPhases) {
      const count = phaseCounts[phase];
      const durs = phaseDurations[phase];
      if (durs && durs.length > 0) {
        const avg = (durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1);
        const min = Math.min(...durs).toFixed(0);
        const max = Math.max(...durs).toFixed(0);
        console.log(
          `  ${phase.padEnd(20)} ${String(count).padStart(5)}  ${avg.padStart(8)}  ${min.padStart(7)}  ${max.padStart(7)}`,
        );
      } else {
        console.log(
          `  ${phase.padEnd(20)} ${String(count).padStart(5)}       N/A       N/A       N/A`,
        );
      }
    }
  });
// --- diff ---
program
  .command('diff')
  .description('Show state changes for an event or compare project versions')
  .argument('[event]', 'Event ID to diff (state before/after)')
  .option('--project <path>', 'Compare current project YAML with version at <path>')
  .option('--json', 'Output in JSON format (project diff only)')
  .action((eventId: string | undefined, opts: { project?: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();

    if (opts.project) {
      // Impact analysis mode
      const oldPath = path.resolve(opts.project);
      const result = analyzeProjectImpact(oldPath, projectDir);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const redEvents = Object.entries(result.events)
        .filter(([, level]) => level === 'red')
        .map(([id]) => id)
        .sort();
      const yellowEvents = Object.entries(result.events)
        .filter(([, level]) => level === 'yellow')
        .map(([id]) => id)
        .sort();
      const greenEvents = Object.entries(result.events)
        .filter(([, level]) => level === 'green')
        .map(([id]) => id)
        .sort();

      console.log('\nImpact Analysis:');
      console.log(`  ${'━'.repeat(50)}`);
      if (redEvents.length > 0) {
        console.log(
          `  Red (causal chain broken): ${redEvents.length} event${redEvents.length !== 1 ? 's' : ''} (${redEvents.join(', ')})`,
        );
        for (const [id, downstreamIds] of Object.entries(result.downstream)) {
          console.log(`    ${id} downstream: ${downstreamIds.join(', ')}`);
        }
      } else {
        console.log('  Red (causal chain broken):  0 events');
      }
      if (yellowEvents.length > 0) {
        console.log(
          `  Yellow (needs rewrite):     ${yellowEvents.length} event${yellowEvents.length !== 1 ? 's' : ''} (${yellowEvents.join(', ')})`,
        );
      } else {
        console.log('  Yellow (needs rewrite):     0 events');
      }
      if (greenEvents.length > 0) {
        console.log(
          `  Green (no effect):          ${greenEvents.length} event${greenEvents.length !== 1 ? 's' : ''} (${greenEvents.join(', ')})`,
        );
      } else {
        console.log('  Green (no effect):          0 events');
      }
      return;
    }

    if (!eventId) {
      console.error('Error: Provide an event ID or --project <path>');
      process.exit(1);
    }

    // Existing event state diff mode
    const result = diffEvent(projectDir, eventId, new FsStorage());

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

// --- verify ---
program
  .command('verify')
  .description('Verify evidence chain for all cached scenes')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const storage = new FsStorage();
    const cacheDir = path.join(projectDir, '.nova', 'render-cache');

    // Load authored events to compute current evidence hashes
    const events = initializeProject(projectDir, storage).events;

    // Build evidence hash map
    const evidenceHashes = new Map<string, string>();
    for (const event of events) {
      const hash = computeEvidenceHash(
        event.id,
        event.preconditions ?? [],
        event.postconditions ?? [],
      );
      evidenceHashes.set(event.id, hash);
    }

    const result = verifyEvidenceChain(cacheDir, evidenceHashes, storage);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('\nEvidence Chain Verification:');
    console.log(`  ${'━'.repeat(50)}`);
    console.log(`  Total cached:  ${result.totalCached}`);
    console.log(`  Valid:         ${result.valid}`);
    console.log(`  Stale:         ${result.stale}`);
    console.log(`  Missing:       ${result.missing}`);

    if (result.details.length > 0) {
      const issues = result.details.filter((d) => d.status !== 'valid');
      if (issues.length > 0) {
        console.log('\n  Issues:');
        for (const d of issues) {
          console.log(`    ${d.eventId}: ${d.status}${d.reason ? ` (${d.reason})` : ''}`);
        }
      }
    }

    if (result.stale === 0 && result.missing === 0) {
      console.log('\n  ✅ All cached scenes verified.');
    } else if (result.valid > 0) {
      console.log('\n  ⚠️  Some cached scenes are stale or missing. Re-render recommended.');
    } else {
      console.log('\n  ❌ No valid cached scenes found.');
    }
  });
program
  .command('commit')
  .description('Commit current state (auto-run after validation)')
  .action(() => {
    const projectDir = ensureProjectDir();
    const storage = new FsStorage();

    initializeProject(projectDir, storage);
  });

// --- graph ---
program
  .command('graph')
  .description('Export DAG visualization of causal event edges')
  .option('--format <format>', 'Output format (dot or mermaid)', 'dot')
  .action((options: { format?: string }) => {
    const projectDir = ensureProjectDir();

    const project = initializeProject(projectDir, new FsStorage());

    const eventProps = project.events.map((e) => ({
      eventId: e.id,
      title: e.title,
      sceneType: e.sceneType,
    }));

    const adjacency = project.runtime.graphs.storyAdjacency;

    const output =
      options.format === 'mermaid'
        ? exportDAGtoMermaid(adjacency, eventProps)
        : exportDAGtoDOT(adjacency, eventProps);

    console.log(output);
  });

// ============================================================================
// source — Manage project source documents
// ============================================================================

const sourceCmd = program.command('source').description('Manage project source documents');

sourceCmd
  .command('list')
  .description('List all source documents')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const documents = await listSourceDocuments({ projectDir: ensureProjectDir() });
    if (opts.json) {
      console.log(JSON.stringify(documents, null, 2));
      return;
    }
    for (const document of documents) {
      console.log(`${document.path}  ${document.kind}  ${document.contentHash.slice(0, 12)}`);
    }
  });

sourceCmd
  .command('show <path>')
  .description('Show a source document')
  .option('--json', 'Output as JSON')
  .action(async (documentPath: string, opts: { json?: boolean }) => {
    const document = await getSourceDocument({
      projectDir: ensureProjectDir(),
      path: documentPath,
    });
    if (opts.json) {
      console.log(JSON.stringify(document, null, 2));
      return;
    }
    console.log(document.content);
  });

sourceCmd
  .command('preview <path>')
  .description('Preview replacing one source document with exact file bytes')
  .requiredOption('--file <path>', 'Replacement YAML file')
  .option('--json', 'Output preview result as JSON')
  .action(async (documentPath: string, opts: { file: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const [document, documents] = await Promise.all([
      getSourceDocument({ projectDir, path: documentPath }),
      listSourceDocuments({ projectDir }),
    ]);
    const changeSet = {
      version: 1 as const,
      expectedProjectSourceHash: computeProjectSourceHash(documents),
      changes: [
        {
          type: 'put' as const,
          path: document.path,
          expectedHash: document.contentHash,
          content: fs.readFileSync(opts.file, 'utf-8'),
        },
      ],
    };
    const preview = await previewSourceChange({ projectDir, changeSet });
    if (opts.json) {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    console.log(`Preview token: ${preview.previewToken}`);
    console.log(`Documents affected: ${preview.documents.length}`);
    console.log(`Validation: ${preview.validation.valid ? 'valid' : 'invalid'}`);
    for (const error of preview.validation.errors) {
      console.log(`  ${error.path ?? 'project'}: ${error.message}`);
    }
    for (const changed of preview.documents) {
      console.log(`  modified ${changed.path}`);
    }
  });

sourceCmd
  .command('apply <preview>')
  .description('Apply a SourceChangePreviewV1 JSON file')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--note <text>', 'Optional note for the change')
  .option('--json', 'Output result as JSON')
  .action(
    async (
      previewPath: string,
      opts: {
        actor?: string;
        note?: string;
        json?: boolean;
      },
    ) => {
      const result = await applySourceChange({
        projectDir: ensureProjectDir(),
        preview: JSON.parse(fs.readFileSync(previewPath, 'utf-8')) as SourceChangePreviewV1,
        mutation: {
          operationId: crypto.randomUUID(),
          actorId: opts.actor ?? 'local-cli',
        },
        ...(opts.note ? { note: opts.note } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Source change applied: ${result.changedDocuments.length} document(s), ` +
          `revision ${result.sourceRevisionId}`,
      );
    },
  );

sourceCmd
  .command('reconcile')
  .description('Version valid external source working-copy edits')
  .option('--actor <actor>', 'Actor ID for the operation', 'local-cli')
  .option('--json', 'Output result as JSON')
  .action(async (opts: { actor?: string; json?: boolean }) => {
    const result = await reconcileSourceWorkingCopy({
      projectDir: ensureProjectDir(),
      mutation: {
        operationId: crypto.randomUUID(),
        actorId: opts.actor ?? 'local-cli',
      },
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      result
        ? `Source reconciled: ${result.changedDocuments.length} change(s).`
        : 'Source working copy is already tracked.',
    );
  });

// ============================================================================
// operation — Inspect editorial operations
// ============================================================================

const operationCmd = program.command('operation').description('Inspect editorial operations');

operationCmd
  .command('list')
  .description('List all editorial operations')
  .option('--limit <number>', 'Max operations to show', '20')
  .option('--json', 'Output as JSON')
  .action((opts: { limit?: string; json?: boolean }) => {
    const operations = listEditorialOperations({
      projectDir: ensureProjectDir(),
    }).slice(0, opts.limit ? Number(opts.limit) : 20);
    if (opts.json) {
      console.log(JSON.stringify(operations, null, 2));
      return;
    }
    for (const operation of operations) {
      console.log(
        `${operation.operationId}  ${operation.kind}  ${operation.status}  ${operation.startedAt}`,
      );
    }
  });

operationCmd
  .command('show <operationId>')
  .description('Show an editorial operation by ID')
  .option('--json', 'Output as JSON')
  .action((operationId: string, opts: { json?: boolean }) => {
    const operation = getEditorialOperation({
      projectDir: ensureProjectDir(),
      operationId,
    });
    if (opts.json) {
      console.log(JSON.stringify(operation, null, 2));
      return;
    }
    console.log(`Operation: ${operation.operationId}`);
    console.log(`Kind: ${operation.kind}`);
    console.log(`Status: ${operation.status}`);
    console.log(`Actor: ${operation.actorId}`);
    console.log(`Started: ${operation.startedAt}`);
    if (operation.completedAt) console.log(`Completed: ${operation.completedAt}`);
    for (const error of operation.errors) {
      console.log(`Error [${error.code}]: ${error.message}`);
    }
    if (operation.result) {
      console.log(`Result: ${JSON.stringify(operation.result, null, 2)}`);
    }
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
        console.log(
          `  ${icon} ${s.stage}: ${s.passed ? 'PASS' : 'FAIL'} (${s.ms}ms) — ${s.detail}`,
        );
      }
      console.log(
        `  ── ${r.totalPassed}/${r.stages.length} passed, ${r.totalFailed} failed, ${r.totalTime}ms total ──`,
      );
      return;
    }

    if (onlyPerf) {
      console.log('── Performance Benchmarks ──');
      const r = await runPerformanceBench();
      console.table(
        r.measurements.map(
          (m: {
            name: string;
            hz: number;
            meanMs: number;
            samples: number;
            scale: string | number;
          }) => ({
            Stage: m.name,
            Hz: m.hz.toFixed(1),
            'Mean (ms)': m.meanMs.toFixed(3),
            Samples: m.samples,
            Scale: m.scale,
          }),
        ),
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

// Shared routing helper for CLI and MCP
export { resolveRoute };

// Allow running directly
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/cli/dist/index.js')
) {
  main();
}
