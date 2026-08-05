#!/usr/bin/env node

import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  type BranchPath,
  getProjectStatus,
  type LLMProvider,
  listEntities,
  showEntity,
  validateNovel,
} from '@novalistically/core';
import {
  type EditorialRenderRequestV1,
  type EditorialRuntime,
  previewEditorialRun,
  previewSourceChange,
  type RenderGameDialogueTreeRequestV1,
  renderGameDialogueTree,
  renderNovel,
  type SceneSelector,
  type SourceChangeV1,
} from '@novalistically/core/editorial';
import { computeSourceDocumentHash } from '@novalistically/core/source';
import {
  exportDAGtoDOT,
  exportDAGtoMermaid,
  inspectProjectGraph,
} from '@novalistically/core/tooling';
import {
  AiSdkProvider,
  createFileCoreRuntimeServices,
  FileMockPass2Provider,
  FileProjectSourceLoader,
  FileProjectSourceWriter,
} from '@novalistically/node-host';
import { Command } from 'commander';
import { resolveRoute } from './route.ts';
import {
  createWorkbenchClient,
  resolveWorkbenchMode,
  type WorkbenchClient,
  WorkbenchClientError,
} from './workbench-client.ts';

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
function remoteClient(): WorkbenchClient | null {
  const options = program.opts<{
    readonly mode?: string;
    readonly project?: string;
    readonly host?: string;
  }>();
  const mode = resolveWorkbenchMode({
    mode: options.mode,
    projectId: options.project,
    host: options.host,
  });
  return mode.mode === 'standalone' ? null : createWorkbenchClient(mode);
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

function selector(input: { eventId?: string; all?: boolean; chapter?: string }): SceneSelector {
  if (input.all) return { type: 'all' };
  if (input.chapter !== undefined) {
    const chapter = Number(input.chapter);
    if (!Number.isInteger(chapter) || chapter < 1)
      throw new Error('--chapter must be a positive integer');
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
program
  .name('nova')
  .description('Novalistically Node Host CLI')
  .version('0.1.0')
  .option('--mode <mode>', 'standalone or via-workbench')
  .option('--project <projectId>', 'Workbench project ID for via-workbench mode')
  .option('--host <url>', 'Workbench Host base URL');

program
  .command('validate')
  .option('--event <eventId>')
  .option('--json')
  .action(async (options: { event?: string; json?: boolean }) => {
    const client = remoteClient();
    if (client !== null) {
      const result = (await client.validate()) as Record<string, unknown>;
      if (
        options.event !== undefined &&
        result.results !== undefined &&
        typeof result.results === 'object' &&
        result.results !== null
      ) {
        const event = (result.results as Record<string, unknown>)[options.event];
        if (event === undefined) throw new Error(`Event "${options.event}" not found.`);
        printResult(event, options.json ?? false);
        if (
          typeof event === 'object' &&
          event !== null &&
          'passed' in event &&
          event.passed === false
        )
          process.exitCode = 1;
        return;
      }
      printResult(result, options.json ?? false);
      if (result.passed === false) process.exitCode = 1;
      return;
    }
    const result = await validateNovel(loadSource(ensureProjectDir()));
    if (options.event) {
      const event = result.results.get(options.event);
      if (!event) throw new Error(`Event "${options.event}" not found.`);
      printResult(event, options.json ?? false);
      if (!event.passed) process.exitCode = 1;
      return;
    }
    printResult(
      { passed: result.passed, results: Object.fromEntries(result.results), iss: result.iss },
      options.json ?? false,
    );
    if (!result.passed) process.exitCode = 1;
  });

program
  .command('status')
  .option('--json')
  .action(async (options: { json?: boolean }) => {
    const client = remoteClient();
    printResult(
      client === null ? getProjectStatus(loadSource(ensureProjectDir())) : await client.status(),
      options.json ?? false,
    );
  });

const entity = program.command('entity').description('Inspect compiled entities');
entity
  .command('list [kind]')
  .option('--json')
  .action(async (kind: string | undefined, options: { json?: boolean }) => {
    const client = remoteClient();
    printResult(
      client === null
        ? listEntities(loadSource(ensureProjectDir()), kind)
        : await client.entityList(kind === undefined ? {} : { kind }),
      options.json ?? false,
    );
  });
entity
  .command('show <id>')
  .option('--json')
  .action(async (id: string, options: { json?: boolean }) => {
    const client = remoteClient();
    if (client !== null) {
      printResult(await client.entityGet({ entityId: id }), options.json ?? false);
      return;
    }
    const value = showEntity(loadSource(ensureProjectDir()), id);
    if (!value) throw new Error(`Entity "${id}" not found.`);
    printResult(value, options.json ?? false);
  });

program
  .command('graph')
  .option('--format <format>', 'dot or mermaid', 'dot')
  .action(async (options: { format: 'dot' | 'mermaid' }) => {
    const client = remoteClient();
    if (client !== null) {
      printResult(await client.graph(), true);
      return;
    }
    const graph = inspectProjectGraph(loadSource(ensureProjectDir()));
    const events = graph.events.map((event) => ({ eventId: event.id, label: event.title }));
    console.log(
      options.format === 'mermaid'
        ? exportDAGtoMermaid(graph.adjacency, events)
        : exportDAGtoDOT(graph.adjacency, events),
    );
  });
const source = program
  .command('source')
  .description('Inspect and apply host-CAS authoring source changes');
source.command('list').action(async () => {
  const client = remoteClient();
  if (client !== null) {
    printResult(await client.sourceList(), true);
    return;
  }
  const snapshot = loadSource(ensureProjectDir());
  printResult(
    snapshot.documents.map((document) => ({
      logicalPath: document.logicalPath,
      contentHash: document.contentHash,
      diagnostics: document.diagnostics,
    })),
    true,
  );
});
source.command('show <logicalPath>').action(async (logicalPath: string) => {
  const client = remoteClient();
  if (client !== null) {
    const document = (await client.sourceGet({ logicalPath })) as { readonly content?: unknown };
    if (typeof document.content !== 'string')
      throw new Error(`Source document "${logicalPath}" not found.`);
    process.stdout.write(document.content);
    return;
  }
  const document = loadSource(ensureProjectDir()).documents.find(
    (candidate) => candidate.logicalPath === logicalPath,
  );
  if (!document) throw new Error(`Source document "${logicalPath}" not found.`);
  process.stdout.write(document.content);
});

source
  .command('preview <logicalPath> <contentFile>')
  .action(async (logicalPath: string, contentFile: string) => {
    const client = remoteClient();
    const afterContent = readFileSync(contentFile, 'utf8');
    if (client !== null) {
      const previous = (await client.sourceGet({ logicalPath })) as {
        readonly content?: unknown;
        readonly contentHash?: unknown;
      };
      const change = {
        logicalPath,
        beforeContent: typeof previous.content === 'string' ? previous.content : null,
        beforeHash: typeof previous.contentHash === 'string' ? previous.contentHash : null,
        afterContent,
        afterHash: computeSourceDocumentHash(afterContent),
      };
      printResult(await client.sourcePreview({ changes: [change] }), true);
      return;
    }
    const snapshot = loadSource(ensureProjectDir());
    const previous = snapshot.documents.find((document) => document.logicalPath === logicalPath);
    const change: SourceChangeV1 = {
      logicalPath,
      beforeContent: previous?.content ?? null,
      beforeHash: previous?.contentHash ?? null,
      afterContent,
      afterHash: computeSourceDocumentHash(afterContent),
    };
    printResult(previewSourceChange(snapshot, [change]), true);
  });

source
  .command('apply <logicalPath> <contentFile>')
  .action(async (logicalPath: string, contentFile: string) => {
    const client = remoteClient();
    const afterContent = readFileSync(contentFile, 'utf8');
    if (client !== null) {
      const listing = (await client.authoringDocumentList()) as {
        readonly documents?: readonly {
          readonly documentId: string;
          readonly logicalPath: string;
        }[];
        readonly workspaceDigest?: unknown;
      };
      const descriptor = listing.documents?.find(
        (document) => document.logicalPath === logicalPath,
      );
      if (descriptor === undefined || typeof listing.workspaceDigest !== 'string') {
        throw new WorkbenchClientError({
          status: 409,
          code: 'AUTHORING_DOCUMENT_NOT_FOUND',
          message: `Workbench authoring document "${logicalPath}" is unavailable.`,
        });
      }
      const document = (await client.authoringDocumentRead({
        version: 2,
        documentId: descriptor.documentId,
      })) as {
        readonly stateVectorHash?: unknown;
        readonly acceptedSourceHash?: unknown;
      };
      if (
        typeof document.stateVectorHash !== 'string' ||
        (document.acceptedSourceHash !== null && typeof document.acceptedSourceHash !== 'string')
      ) {
        throw new WorkbenchClientError({
          status: 502,
          code: 'INVALID_HOST_RESPONSE',
          message: 'Workbench returned an invalid authoring document projection.',
        });
      }
      printResult(
        await client.authoringDocumentEdit({
          version: 2,
          documentId: descriptor.documentId,
          expectedWorkspaceDigest: listing.workspaceDigest,
          expectedAcceptedSourceHash: document.acceptedSourceHash as string | null,
          expectedStateVectorHash: document.stateVectorHash,
          replacementText: afterContent,
        }),
        true,
      );
      return;
    }
    const projectDir = ensureProjectDir();
    const snapshot = loadSource(projectDir);
    const previous = snapshot.documents.find((document) => document.logicalPath === logicalPath);
    const change: SourceChangeV1 = {
      logicalPath,
      beforeContent: previous?.content ?? null,
      beforeHash: previous?.contentHash ?? null,
      afterContent,
      afterHash: computeSourceDocumentHash(afterContent),
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
  input: {
    eventId?: string;
    all?: boolean;
    chapter?: string;
    provider?: string;
    referenceDir?: string;
    branchPath?: string;
    discourseBranch?: string;
    dryRun?: boolean;
    json?: boolean;
    revision?: string;
  },
): Promise<void> {
  const client = remoteClient();
  if (client !== null) {
    if (input.dryRun) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: '--dry-run is only available in standalone mode.',
      });
    }
    const result =
      input.revision === undefined
        ? await client.render({ sceneSelector: selector(input) })
        : await client.revise({ sceneSelector: selector(input) });
    printResult(result, input.json ?? false);
    return;
  }
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
    await render(remoteClient() === null ? ensureProjectDir() : process.cwd(), {
      ...options,
      eventId,
    });
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
    await render(remoteClient() === null ? ensureProjectDir() : process.cwd(), {
      ...options,
      eventId,
      revision: options.instruction,
    });
  });

program
  .command('render-tree')
  .requiredOption('--provider <provider>', 'mock-pass2')
  .requiredOption('--reference-dir <directory>')
  .option('--json')
  .action(async (options: { provider: string; referenceDir: string; json?: boolean }) => {
    const client = remoteClient();
    if (client !== null) {
      printResult(
        await client.renderTree({ sceneSelector: { type: 'all' } }),
        options.json ?? false,
      );
      return;
    }
    const projectDir = ensureProjectDir();
    const llm = provider(options);
    const request: RenderGameDialogueTreeRequestV1 = {
      version: 1,
      source: loadSource(projectDir),
      mutation: { operationId: crypto.randomUUID(), actorId: 'local-cli' },
    };
    const result = await renderGameDialogueTree(request, runtime(projectDir, llm));
    printResult(result, options.json ?? false);
    if (result.errors.length > 0 || result.results.some((scene) => !scene.released))
      process.exitCode = 1;
  });

const project = program.command('project').description('Manage local authoring projects');
project
  .command('init <name>')
  .description('Create a minimal valid authoring topology without Git history')
  .action((name: string) => {
    if (remoteClient() !== null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'project init is only available in standalone mode.',
      });
    }
    const root = path.resolve(process.cwd(), name);
    mkdirSync(path.join(root, 'definitions'), { recursive: true });
    for (const directory of [
      'characters',
      'locations',
      'items',
      'factions',
      'relationships',
      'rules',
      'narrators',
      'assertions',
    ]) {
      mkdirSync(path.join(root, 'definitions', directory), { recursive: true });
    }
    mkdirSync(path.join(root, 'chapters', 'chapter_01'), { recursive: true });
    writeFileSync(
      path.join(root, 'nova.yaml'),
      `project: ${name}\ntitle: ${JSON.stringify(name)}\nauthor: local\ndefaultModel: mock\ndefaultLanguage: en\nsnapshotInterval: 20\n`,
    );
    writeFileSync(
      path.join(root, 'definitions', 'state_initial.yaml'),
      'info:\n  currentEra: initial\n  politicalSituation: undeclared\nthreads: []\nknowledge:\n  claims: []\n  commonGround: []\nworldFacts: []\n',
    );
    writeFileSync(
      path.join(root, 'definitions', 'entity-types.yaml'),
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: []\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    );
    writeFileSync(path.join(root, 'definitions', 'thread-types.yaml'), 'types: {}\n');
    writeFileSync(
      path.join(root, 'definitions', 'propositions.yaml'),
      'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    );
    writeFileSync(path.join(root, 'definitions', 'relationship-types.yaml'), 'types: {}\n');
    writeFileSync(path.join(root, 'definitions', 'rule-types.yaml'), 'types: {}\n');
    writeFileSync(
      path.join(root, 'definitions', 'characters', 'narrator.yaml'),
      'id: narrator\nname: Narrator\ntype: character\ndescription: The initial point-of-view character.\ntraits: []\n',
    );
    writeFileSync(
      path.join(root, 'definitions', 'discourse-ledger.yaml'),
      `id: ${name}_ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1]\nentries: []\n`,
    );
    writeFileSync(
      path.join(root, 'chapters', 'chapter_01', '_chapter.yaml'),
      'chapter: 1\ntitle: Opening\nsummary: Initial chapter.\nintent: Establish the story.\nplannedScenes: 1\n',
    );
    writeFileSync(
      path.join(root, 'chapters', 'chapter_01', 'E1.yaml'),
      'event: E1\nnarrativeOrder: 1\ntitle: Opening scene\nstoryTime: day_0\npov:\n  character: narrator\n  type: omniscient\nsceneBrief: Establish the initial dramatic situation.\nbeats:\n  - Establish the initial dramatic situation.\npreconditions: []\nexpectedPostconditions: []\n',
    );
    console.log(`Initialized ${root}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error instanceof WorkbenchClientError ? error.exitCode : error instanceof TypeError ? 2 : 1;
});
