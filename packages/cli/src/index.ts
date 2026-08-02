#!/usr/bin/env node

import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  compileProject,
  getProjectStatus,
  listEntities,
  showEntity,
  validateNovel,
  type BranchPath,
  type LLMProvider,
} from '@novalistically/core';
import {
  compileGameDialogueTree,
  previewEditorialRun,
  previewSourceChange,
  renderGameDialogueTree,
  renderNovel,
  type EditorialRenderRequestV1,
  type EditorialRuntime,
  type RenderGameDialogueTreeRequestV1,
  type SceneSelector,
  type SourceChangeV1,
} from '@novalistically/core/editorial';
import { exportDAGtoDOT, exportDAGtoMermaid, inspectProjectGraph } from '@novalistically/core/tooling';
import {
  AiSdkProvider,
  FileProjectSourceLoader,
  FileProjectSourceWriter,
  createFileCoreRuntimeServices,
  FileMockPass2Provider,
} from '@novalistically/node-host';
import { Command } from 'commander';
import { resolveRoute } from './route.ts';

const sourceLoader = new FileProjectSourceLoader();
const sourceWriter = new FileProjectSourceWriter({ loader: sourceLoader });

function ensureProjectDir(): string {
  const projectDir = process.cwd();
  if (!existsSync(path.join(projectDir, 'nova.yaml'))) {
    throw new Error('Not in a Novalistically project directory (missing nova.yaml).');
  }
  return projectDir;
}

function loadSource(projectDir: string) {
  return sourceLoader.load(projectDir);
}

function parseBranchPath(raw: string | undefined): BranchPath | undefined {
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('decisions' in value) ||
    !Array.isArray(value.decisions)
  ) {
    throw new Error('--branch-path must be {"decisions": [...]}');
  }
  return value as BranchPath;
}

function selector(input: {
  eventId?: string;
  all?: boolean;
  chapter?: string;
}): SceneSelector {
  if (input.all) return { type: 'all' };
  if (input.chapter !== undefined) {
    const chapter = Number(input.chapter);
    if (!Number.isInteger(chapter) || chapter < 1) throw new Error('--chapter must be a positive integer');
    return { type: 'chapter', chapter };
  }
  if (!input.eventId) throw new Error('Provide an event ID, --all, or --chapter.');
  return { type: 'events', eventIds: [input.eventId] };
}

function provider(options: { provider?: string; referenceDir?: string }): LLMProvider {
  if (options.provider === undefined || options.provider === 'ai-sdk') {
    return new AiSdkProvider();
  }
  if (options.provider === 'mock-pass2') {
    if (!options.referenceDir) {
      throw new Error('--provider mock-pass2 requires --reference-dir <directory>.');
    }
    return new FileMockPass2Provider({ referenceDir: options.referenceDir });
  }
  throw new Error(`Unsupported provider: ${options.provider}`);
}

function runtime(projectDir: string, llm: LLMProvider): EditorialRuntime {
  return { services: createFileCoreRuntimeServices(projectDir, { provider: llm }), provider: llm };
}

function printResult(value: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

const program = new Command();
program.name('nova').description('Novalistically Node Host CLI').version('0.1.0');

program
  .command('validate')
  .option('--event <eventId>')
  .option('--json')
  .action(async (options: { event?: string; json?: boolean }) => {
    const result = await validateNovel(loadSource(ensureProjectDir()));
    if (options.event) {
      const event = result.results.get(options.event);
      if (!event) throw new Error(`Event "${options.event}" not found.`);
      printResult(event, options.json ?? false);
      if (!event.passed) process.exitCode = 1;
      return;
    }
    printResult({ passed: result.passed, results: Object.fromEntries(result.results), iss: result.iss }, options.json ?? false);
    if (!result.passed) process.exitCode = 1;
  });

program
  .command('status')
  .option('--json')
  .action((options: { json?: boolean }) => {
    printResult(getProjectStatus(loadSource(ensureProjectDir())), options.json ?? false);
  });

const entity = program.command('entity').description('Inspect compiled entities');
entity
  .command('list [kind]')
  .option('--json')
  .action((kind: string | undefined, options: { json?: boolean }) => {
    printResult(listEntities(loadSource(ensureProjectDir()), kind), options.json ?? false);
  });
entity
  .command('show <id>')
  .option('--json')
  .action((id: string, options: { json?: boolean }) => {
    const value = showEntity(loadSource(ensureProjectDir()), id);
    if (!value) throw new Error(`Entity "${id}" not found.`);
    printResult(value, options.json ?? false);
  });

program
  .command('graph')
  .option('--format <format>', 'dot or mermaid', 'dot')
  .action((options: { format: 'dot' | 'mermaid' }) => {
    const graph = inspectProjectGraph(loadSource(ensureProjectDir()));
    const events = graph.events.map((event) => ({ eventId: event.id, label: event.title }));
    console.log(options.format === 'mermaid' ? exportDAGtoMermaid(graph.adjacency, events) : exportDAGtoDOT(graph.adjacency, events));
  });

const source = program.command('source').description('Inspect and apply host-CAS authoring source changes');
source
  .command('list')
  .action(() => {
    const snapshot = loadSource(ensureProjectDir());
    printResult(snapshot.documents.map((document) => ({ logicalPath: document.logicalPath, contentHash: document.contentHash, diagnostics: document.diagnostics })), true);
  });
source
  .command('show <logicalPath>')
  .action((logicalPath: string) => {
    const document = loadSource(ensureProjectDir()).documents.find((candidate) => candidate.logicalPath === logicalPath);
    if (!document) throw new Error(`Source document "${logicalPath}" not found.`);
    process.stdout.write(document.content);
  });
source
  .command('preview <logicalPath> <contentFile>')
  .action((logicalPath: string, contentFile: string) => {
    const snapshot = loadSource(ensureProjectDir());
    const previous = snapshot.documents.find((document) => document.logicalPath === logicalPath);
    const afterContent = readFileSync(contentFile, 'utf8');
    const change: SourceChangeV1 = {
      logicalPath,
      beforeContent: previous?.content ?? null,
      beforeHash: previous?.contentHash ?? null,
      afterContent,
      afterHash: null,
    };
    printResult(previewSourceChange(snapshot, [change]), true);
  });
source
  .command('apply <logicalPath> <contentFile>')
  .action(async (logicalPath: string, contentFile: string) => {
    const projectDir = ensureProjectDir();
    const snapshot = loadSource(projectDir);
    const previous = snapshot.documents.find((document) => document.logicalPath === logicalPath);
    const afterContent = readFileSync(contentFile, 'utf8');
    const change: SourceChangeV1 = {
      logicalPath,
      beforeContent: previous?.content ?? null,
      beforeHash: previous?.contentHash ?? null,
      afterContent,
      afterHash: null,
    };
    const analysis = previewSourceChange(snapshot, [change]);
    if (analysis.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      printResult(analysis, true);
      process.exitCode = 1;
      return;
    }
    printResult(await sourceWriter.apply(projectDir, snapshot.sourceHash, [change]), true);
  });

async function render(
  projectDir: string,
  input: { eventId?: string; all?: boolean; chapter?: string; provider?: string; referenceDir?: string; branchPath?: string; discourseBranch?: string; dryRun?: boolean; json?: boolean; revision?: string },
): Promise<void> {
  const branchPath = parseBranchPath(input.branchPath);
  const llm = provider(input);
  const request: EditorialRenderRequestV1 = {
    version: 1,
    source: loadSource(projectDir),
    selector: selector(input),
    mutation: { operationId: crypto.randomUUID(), actorId: 'local-cli' },
    ...(input.revision ? { revision: { instruction: input.revision } } : {}),
    ...resolveRoute({ branchPath, discourseBranch: input.discourseBranch }),
  };
  const hostRuntime = runtime(projectDir, llm);
  if (input.dryRun) {
    const { mutation: _mutation, ...preview } = request;
    printResult(await previewEditorialRun(preview, hostRuntime), input.json ?? false);
    return;
  }
  const result = await renderNovel(request, hostRuntime);
  printResult(result, input.json ?? false);
  if (result.editorialErrors.length > 0 || result.results.some((scene) => !scene.released)) {
    process.exitCode = 1;
  }
}

program
  .command('render [eventId]')
  .option('--all')
  .option('--chapter <chapter>')
  .option('--provider <provider>', 'mock-pass2')
  .option('--reference-dir <directory>')
  .option('--branch-path <json>')
  .option('--discourse-branch <name>')
  .option('--dry-run')
  .option('--json')
  .action(async (eventId: string | undefined, options) => {
    await render(ensureProjectDir(), { ...options, eventId });
  });

program
  .command('revise [eventId]')
  .option('--all')
  .option('--chapter <chapter>')
  .option('--instruction <text>')
  .option('--provider <provider>', 'mock-pass2')
  .option('--reference-dir <directory>')
  .option('--branch-path <json>')
  .option('--discourse-branch <name>')
  .option('--json')
  .action(async (eventId: string | undefined, options) => {
    await render(ensureProjectDir(), { ...options, eventId, revision: options.instruction });
  });

program
  .command('render-tree')
  .requiredOption('--provider <provider>', 'mock-pass2')
  .requiredOption('--reference-dir <directory>')
  .option('--json')
  .action(async (options: { provider: string; referenceDir: string; json?: boolean }) => {
    const projectDir = ensureProjectDir();
    const llm = provider(options);
    const request: RenderGameDialogueTreeRequestV1 = {
      version: 1,
      source: loadSource(projectDir),
      mutation: { operationId: crypto.randomUUID(), actorId: 'local-cli' },
    };
    const result = await renderGameDialogueTree(request, runtime(projectDir, llm));
    printResult(result, options.json ?? false);
    if (result.errors.length > 0 || result.results.some((scene) => !scene.released)) process.exitCode = 1;
  });

const project = program.command('project').description('Manage local authoring projects');
project
  .command('init <name>')
  .description('Create a minimal valid authoring topology without Git history')
  .action((name: string) => {
    const root = path.resolve(process.cwd(), name);
    mkdirSync(path.join(root, 'definitions'), { recursive: true });
    mkdirSync(path.join(root, 'definitions', 'characters'), { recursive: true });
    mkdirSync(path.join(root, 'chapters', 'chapter_01'), { recursive: true });
    writeFileSync(path.join(root, 'nova.yaml'), `project: ${name}\ntitle: ${JSON.stringify(name)}\nauthor: local\ndefaultModel: mock\ndefaultLanguage: en\nsnapshotInterval: 20\n`);
    writeFileSync(path.join(root, 'definitions', 'state_initial.yaml'), 'info:\n  currentEra: initial\n  politicalSituation: undeclared\nthreads: []\nworldFacts: []\n');
    writeFileSync(path.join(root, 'definitions', 'entity-types.yaml'), 'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: []\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n');
    writeFileSync(path.join(root, 'definitions', 'characters', 'narrator.yaml'), 'id: narrator\nname: Narrator\ntype: character\ndescription: The initial point-of-view character.\ntraits: []\n');
    writeFileSync(path.join(root, 'definitions', 'discourse-ledger.yaml'), `id: ${name}_ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1]\nentries: []\n`);
    writeFileSync(path.join(root, 'chapters', 'chapter_01', '_chapter.yaml'), 'chapter: 1\ntitle: Opening\nsummary: Initial chapter.\nintent: Establish the story.\nplannedScenes: 1\n');
    writeFileSync(path.join(root, 'chapters', 'chapter_01', 'E1.yaml'), 'event: E1\nnarrativeOrder: 1\ntitle: Opening scene\nstoryTime: day_0\npov:\n  character: narrator\n  type: omniscient\nsceneBrief: Establish the initial dramatic situation.\nbeats:\n  - Establish the initial dramatic situation.\npreconditions: []\nexpectedPostconditions: []\n');
    console.log(`Initialized ${root}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
