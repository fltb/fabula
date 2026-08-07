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
  PiOpenAICompatibleProvider,
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
  type WorkbenchPublicationPublishInputV1,
  type WorkbenchReviewCategoryV1,
  type WorkbenchReviewSeverityV1,
  type WorkbenchReviewTargetV1,
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
    return new PiOpenAICompatibleProvider();
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

/** Resolve a promise after `ms` milliseconds (bounded CLI polling). */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Parse a comma-separated `--review-ids` value into a bounded unique list. */
function parseReviewIds(raw: string): readonly string[] {
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (ids.length === 0) throw new Error('--review-ids must contain at least one review id.');
  const unique = [...new Set(ids)];
  if (unique.length > 256) throw new Error('--review-ids accepts at most 256 review ids.');
  return unique;
}

/** Validate the accepted source layer (standalone Core or Host `nova_validate`). */
async function runAcceptedValidate(options: { event?: string; json?: boolean }): Promise<void> {
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
}

/** Validate the Host working authoring layer without accepting it. */
async function runWorkingValidate(json: boolean): Promise<void> {
  const client = remoteClient();
  if (client === null) {
    throw new WorkbenchClientError({
      status: 400,
      code: 'UNSUPPORTED_MODE',
      message: 'nova source validate --working requires via-workbench mode.',
    });
  }
  const status: unknown = await client.authoringStatus();
  const state =
    typeof status === 'object' && status !== null && 'state' in status ? status.state : undefined;
  const workspaceDigest =
    typeof state === 'object' && state !== null && 'workspaceDigest' in state
      ? state.workspaceDigest
      : undefined;
  const acceptedSourceHash =
    typeof state === 'object' && state !== null && 'acceptedSourceHash' in state
      ? state.acceptedSourceHash
      : undefined;
  if (
    typeof workspaceDigest !== 'string' ||
    (acceptedSourceHash !== null && typeof acceptedSourceHash !== 'string')
  ) {
    throw new WorkbenchClientError({
      status: 502,
      code: 'INVALID_HOST_RESPONSE',
      message: 'Workbench returned an invalid authoring status projection.',
    });
  }
  const result: unknown = await client.authoringValidate({
    version: 2,
    expectedWorkspaceDigest: workspaceDigest,
    expectedAcceptedSourceHash: acceptedSourceHash,
  });
  printResult(result, json);
  const passed =
    typeof result === 'object' && result !== null && 'passed' in result ? result.passed : undefined;
  if (passed === false) process.exitCode = 1;
  console.log(
    passed === false
      ? 'Next step: fix the working documents, then run "nova source validate --working" again.'
      : 'Next step: run "nova source submit" to accept the working layer.',
  );
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
    await runAcceptedValidate(options);
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
  .command('validate')
  .option('--working', 'validate the Host working authoring layer instead of the accepted source')
  .option('--event <eventId>')
  .option('--json')
  .action(async (options: { working?: boolean; event?: string; json?: boolean }) => {
    if (options.working) {
      await runWorkingValidate(options.json ?? false);
      return;
    }
    await runAcceptedValidate(options);
  });

source
  .command('submit')
  .option('--message <text>')
  .option('--json')
  .action(async (options: { message?: string; json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova source submit requires via-workbench mode.',
      });
    }
    const status: unknown = await client.authoringStatus();
    const state =
      typeof status === 'object' && status !== null && 'state' in status ? status.state : undefined;
    const workspaceDigest =
      typeof state === 'object' && state !== null && 'workspaceDigest' in state
        ? state.workspaceDigest
        : undefined;
    if (typeof workspaceDigest !== 'string') {
      throw new WorkbenchClientError({
        status: 502,
        code: 'INVALID_HOST_RESPONSE',
        message: 'Workbench returned an invalid authoring status projection.',
      });
    }
    const result: unknown = await client.authoringSubmit({
      version: 2,
      expectedWorkspaceDigest: workspaceDigest,
      ...(options.message === undefined ? {} : { message: options.message }),
    });
    printResult(result, options.json ?? false);
    if (typeof result !== 'object' || result === null) return;
    const resultStatus = 'status' in result ? result.status : undefined;
    if (resultStatus === 'rejected') {
      process.exitCode = 1;
      return;
    }
    const receipt = 'receipt' in result ? result.receipt : undefined;
    if (resultStatus === 'queued') {
      const operationId =
        typeof receipt === 'object' &&
        receipt !== null &&
        'operationId' in receipt &&
        typeof receipt.operationId === 'string'
          ? receipt.operationId
          : null;
      console.log(
        operationId === null
          ? 'Next step: run "nova status" to see the accepted layer.'
          : `Next step: run "nova operation wait ${operationId}" to track the submission.`,
      );
      return;
    }
    const submit = 'submit' in result ? result.submit : undefined;
    const submitRevisionId =
      typeof submit === 'object' &&
      submit !== null &&
      'revisionId' in submit &&
      typeof submit.revisionId === 'string'
        ? submit.revisionId
        : null;
    const receiptRevisionId =
      typeof receipt === 'object' &&
      receipt !== null &&
      'revisionId' in receipt &&
      typeof receipt.revisionId === 'string'
        ? receipt.revisionId
        : null;
    const revisionId = submitRevisionId ?? receiptRevisionId;
    console.log(
      revisionId === null
        ? 'Next step: run "nova status" to see the accepted layer.'
        : `Accepted revision ${revisionId}. Next step: run "nova status" to see the accepted layer.`,
    );
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
      console.log('Next step: run "nova source validate --working" to validate the working layer.');
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
    instruction?: string;
    reviewIds?: string;
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
    if (input.instruction === undefined && input.reviewIds === undefined) {
      printResult(await client.render({ sceneSelector: selector(input) }), input.json ?? false);
      return;
    }
    printResult(
      await client.revise({
        sceneSelector: selector(input),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        ...(input.reviewIds === undefined ? {} : { reviewIds: parseReviewIds(input.reviewIds) }),
      }),
      input.json ?? false,
    );
    return;
  }
  if (input.reviewIds !== undefined) {
    throw new WorkbenchClientError({
      status: 400,
      code: 'UNSUPPORTED_MODE',
      message: '--review-ids is only available in via-workbench mode.',
    });
  }
  const branchPath = parseBranchPath(input.branchPath);
  const llm = provider(input);
  const request: EditorialRenderRequestV1 = {
    version: 1,
    source: loadSource(projectDir),
    selector: selector(input),
    mutation: { operationId: crypto.randomUUID(), actorId: 'local-cli' },
    ...(input.instruction ? { revision: { instruction: input.instruction } } : {}),
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
  .option('--review-ids <ids>', 'comma-separated review ids addressed by this revision')
  .option('--provider <provider>', 'mock-pass2')
  .option('--reference-dir <directory>')
  .option('--branch-path <json>')
  .option('--discourse-branch <name>')
  .option('--json')
  .action(async (eventId: string | undefined, options) => {
    await render(remoteClient() === null ? ensureProjectDir() : process.cwd(), {
      ...options,
      eventId,
    });
  });

program
  .command('event-diff <eventId>')
  .description('Show the world state before/after one event (via-workbench)')
  .option('--json')
  .action(async (eventId: string, options: { json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova event-diff requires via-workbench mode (Host event state diff).',
      });
    }
    printResult(await client.eventStateDiff({ eventId }), options.json ?? false);
  });

const operation = program
  .command('operation')
  .description('Inspect and wait on Host authoring operations');
operation
  .command('get <id>')
  .option('--json')
  .action(async (id: string, options: { json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova operation requires via-workbench mode.',
      });
    }
    printResult(
      await client.operationGet({ version: 2, operationHandle: id }),
      options.json ?? false,
    );
  });
operation
  .command('wait <id>')
  .option('--timeout <seconds>', 'bounded wait in seconds', '60')
  .option('--interval <milliseconds>', 'poll interval in milliseconds', '1000')
  .option('--json')
  .action(async (id: string, options: { timeout?: string; interval?: string; json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova operation requires via-workbench mode.',
      });
    }
    const timeoutSeconds = Number(options.timeout);
    const intervalMs = Number(options.interval);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
      throw new Error('--timeout must be a positive number of seconds.');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
      throw new Error('--interval must be a positive number of milliseconds.');
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const result: unknown = await client.operationGet({ version: 2, operationHandle: id });
      const receipt =
        typeof result === 'object' && result !== null && 'receipt' in result
          ? result.receipt
          : undefined;
      if (receipt === null || receipt === undefined) {
        throw new WorkbenchClientError({
          status: 404,
          code: 'OPERATION_NOT_FOUND',
          message: `Operation "${id}" was not found.`,
        });
      }
      if (typeof receipt === 'object' && 'status' in receipt) {
        const status = receipt.status;
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'stale' ||
          status === 'conflict'
        ) {
          printResult(result, options.json ?? false);
          if (status !== 'completed') process.exitCode = 1;
          return;
        }
      }
      if (Date.now() >= deadline) {
        printResult(result, options.json ?? false);
        console.error(
          `Operation "${id}" did not reach a terminal state within ${timeoutSeconds}s.`,
        );
        process.exitCode = 1;
        return;
      }
      await delay(intervalMs);
    }
  });
operation
  .command('cancel <id>')
  .description('Cancel a Host operation (unsupported: no nova_operation_cancel MCP tool)')
  .action(async (_id: string) => {
    throw new WorkbenchClientError({
      status: 400,
      code: 'UNSUPPORTED_TOOL',
      message:
        'nova operation cancel is unavailable: the Host MCP catalog exposes no nova_operation_cancel tool.',
    });
  });

const authoring = program
  .command('authoring')
  .description('Inspect and resolve Host authoring conflicts');
authoring
  .command('conflict')
  .option('--json')
  .action(async (options: { json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova authoring conflict requires via-workbench mode.',
      });
    }
    printResult(await client.authoringConflictRead(), options.json ?? false);
    console.log(
      'Resolve with: nova authoring resolve --choice keep-working|accept-external|apply-proposed-disjoint-merge [--candidate-hash <hash>]',
    );
  });
authoring
  .command('resolve')
  .requiredOption(
    '--choice <choice>',
    'keep-working, accept-external, or apply-proposed-disjoint-merge',
  )
  .option('--candidate-hash <hash>')
  .option('--json')
  .action(async (options: { choice?: string; candidateHash?: string; json?: boolean }) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova authoring resolve requires via-workbench mode.',
      });
    }
    const choice = options.choice;
    if (
      choice !== 'keep-working' &&
      choice !== 'accept-external' &&
      choice !== 'apply-proposed-disjoint-merge'
    ) {
      throw new Error(
        '--choice must be keep-working, accept-external, or apply-proposed-disjoint-merge.',
      );
    }
    printResult(
      await client.conflictResolve({
        version: 2,
        choice,
        candidateHash: options.candidateHash ?? null,
      }),
      options.json ?? false,
    );
  });

const REVIEW_SEVERITIES = ['nit', 'suggestion', 'blocking'] as const;
const REVIEW_CATEGORIES = [
  'style',
  'pacing',
  'character_voice',
  'plot_logic',
  'world_consistency',
  'reader_experience',
] as const;
const REVIEW_ACTIONS = ['replace', 'resolve', 'wontfix', 'reopen', 'escalate'] as const;

function reviewClient(): WorkbenchClient {
  const client = remoteClient();
  if (client === null) {
    throw new WorkbenchClientError({
      status: 400,
      code: 'UNSUPPORTED_MODE',
      message: 'nova review and nova gate require via-workbench mode.',
    });
  }
  return client;
}

function reviewSeverity(raw: string): (typeof REVIEW_SEVERITIES)[number] {
  if (!REVIEW_SEVERITIES.includes(raw as (typeof REVIEW_SEVERITIES)[number])) {
    throw new Error(`--severity must be one of: ${REVIEW_SEVERITIES.join(', ')}.`);
  }
  return raw as (typeof REVIEW_SEVERITIES)[number];
}

function reviewCategory(raw: string): (typeof REVIEW_CATEGORIES)[number] {
  if (!REVIEW_CATEGORIES.includes(raw as (typeof REVIEW_CATEGORIES)[number])) {
    throw new Error(`--category must be one of: ${REVIEW_CATEGORIES.join(', ')}.`);
  }
  return raw as (typeof REVIEW_CATEGORIES)[number];
}

const review = program
  .command('review')
  .description('Inspect review comments and revise from them (via-workbench)');
review
  .command('list')
  .option('--event-id <id>', 'filter comments targeting one scene event')
  .option('--json')
  .action(async (options: { eventId?: string; json?: boolean }) => {
    const client = reviewClient();
    printResult(
      await client.reviewList(
        options.eventId === undefined ? { version: 1 } : { version: 1, eventId: options.eventId },
      ),
      options.json ?? false,
    );
  });
review
  .command('add')
  .requiredOption('--event-id <id>', 'scene event the comment targets')
  .requiredOption('--text <text>')
  .option('--severity <severity>', 'nit, suggestion, or blocking', 'suggestion')
  .option('--category <category>', REVIEW_CATEGORIES.join(', '), 'reader_experience')
  .option('--json')
  .action(
    async (options: {
      eventId?: string;
      text?: string;
      severity?: string;
      category?: string;
      json?: boolean;
    }) => {
      if (!options.eventId || !options.text) {
        throw new Error('nova review add requires --event-id and --text.');
      }
      const client = reviewClient();
      printResult(
        await client.reviewAdd({
          version: 1,
          target: { type: 'scene', id: options.eventId },
          severity: reviewSeverity(options.severity ?? 'suggestion'),
          category: reviewCategory(options.category ?? 'reader_experience'),
          content: options.text,
        }),
        options.json ?? false,
      );
    },
  );
review
  .command('update')
  .requiredOption('--comment-id <id>')
  .requiredOption(
    '--action <action>',
    'replace, resolve, wontfix, reopen, or escalate (addressed is written only by a revision)',
  )
  .option('--text <text>', 'replacement content (required for --action replace)')
  .option('--severity <severity>', 'nit, suggestion, or blocking (replace only)')
  .option('--category <category>', REVIEW_CATEGORIES.join(', ') + ' (replace only)')
  .option('--json')
  .action(
    async (options: {
      commentId?: string;
      action?: string;
      text?: string;
      severity?: string;
      category?: string;
      json?: boolean;
    }) => {
      if (!options.commentId || !options.action) {
        throw new Error('nova review update requires --comment-id and --action.');
      }
      if (!REVIEW_ACTIONS.includes(options.action as (typeof REVIEW_ACTIONS)[number])) {
        throw new Error(`--action must be one of: ${REVIEW_ACTIONS.join(', ')}.`);
      }
      const client = reviewClient();
      if (options.action !== 'replace') {
        printResult(
          await client.reviewUpdate({
            version: 1,
            commentId: options.commentId,
            action: options.action as 'resolve' | 'wontfix' | 'reopen' | 'escalate',
          }),
          options.json ?? false,
        );
        return;
      }
      if (options.text === undefined) {
        throw new Error('--action replace requires --text <text>.');
      }
      const current = (await client.reviewGet({
        version: 1,
        commentId: options.commentId,
      })) as {
        comment?: {
          target?: unknown;
          severity?: unknown;
          category?: unknown;
        } | null;
      };
      const comment = current.comment;
      if (comment === null || comment === undefined) {
        throw new WorkbenchClientError({
          status: 404,
          code: 'REVIEW_COMMENT_NOT_FOUND',
          message: `Review comment "${options.commentId}" was not found.`,
        });
      }
      const target = comment.target;
      const severity =
        options.severity === undefined ? comment.severity : reviewSeverity(options.severity);
      const category =
        options.category === undefined ? comment.category : reviewCategory(options.category);
      if (
        typeof target !== 'object' ||
        target === null ||
        typeof severity !== 'string' ||
        typeof category !== 'string'
      ) {
        throw new WorkbenchClientError({
          status: 502,
          code: 'INVALID_HOST_RESPONSE',
          message: 'Workbench returned an invalid review comment projection.',
        });
      }
      printResult(
        await client.reviewUpdate({
          version: 1,
          commentId: options.commentId,
          action: 'replace',
          target: target as WorkbenchReviewTargetV1,
          severity: severity as WorkbenchReviewSeverityV1,
          category: category as WorkbenchReviewCategoryV1,
          content: options.text,
        }),
        options.json ?? false,
      );
    },
  );
review
  .command('history')
  .option('--event-id <id>', 'filter history to one scene event')
  .option('--json')
  .action(async (options: { eventId?: string; json?: boolean }) => {
    const client = reviewClient();
    printResult(
      await client.reviewHistory(
        options.eventId === undefined ? { version: 1 } : { version: 1, eventId: options.eventId },
      ),
      options.json ?? false,
    );
  });
review
  .command('revise [eventId]')
  .description('Revise scenes and address the given review comments (nova_revise alias)')
  .requiredOption('--ids <ids>', 'comma-separated review ids addressed by this revision')
  .option('--all')
  .option('--instruction <text>')
  .option('--provider <provider>', 'mock-pass2')
  .option('--reference-dir <directory>')
  .option('--branch-path <json>')
  .option('--discourse-branch <name>')
  .option('--json')
  .action(async (eventId: string | undefined, options) => {
    const client = remoteClient();
    if (client === null) {
      throw new WorkbenchClientError({
        status: 400,
        code: 'UNSUPPORTED_MODE',
        message: 'nova review revise requires via-workbench mode.',
      });
    }
    await render(process.cwd(), {
      eventId,
      all: options.all,
      provider: options.provider,
      referenceDir: options.referenceDir,
      branchPath: options.branchPath,
      discourseBranch: options.discourseBranch,
      json: options.json,
      instruction: options.instruction,
      reviewIds: options.ids,
    });
  });

const gate = program
  .command('gate')
  .description('Inspect and decide release gates (via-workbench)');
gate
  .command('list')
  .option('--event-id <id>', 'filter gates for one scene event')
  .option('--json')
  .action(async (options: { eventId?: string; json?: boolean }) => {
    const client = reviewClient();
    printResult(
      await client.gateList(
        options.eventId === undefined ? { version: 1 } : { version: 1, eventId: options.eventId },
      ),
      options.json ?? false,
    );
  });
gate
  .command('decide')
  .requiredOption('--event-id <id>')
  .requiredOption('--candidate-revision <id>')
  .requiredOption('--decision <decision>', 'accept or reject')
  .requiredOption('--reason <text>')
  .option('--json')
  .action(
    async (options: {
      eventId?: string;
      candidateRevision?: string;
      decision?: string;
      reason?: string;
      json?: boolean;
    }) => {
      if (!options.eventId || !options.candidateRevision || !options.reason) {
        throw new Error(
          'nova gate decide requires --event-id, --candidate-revision, and --reason.',
        );
      }
      if (options.decision !== 'accept' && options.decision !== 'reject') {
        throw new Error('--decision must be accept or reject.');
      }
      const client = reviewClient();
      printResult(
        await client.gateDecide({
          version: 1,
          eventId: options.eventId,
          candidateRevisionId: options.candidateRevision,
          decision: options.decision,
          reason: options.reason,
        }),
        options.json ?? false,
      );
    },
  );

/** Publication read bounds mirror the tool's wire bounds (limit 1..262144). */
const PUBLICATION_READ_DEFAULT_LIMIT = 256 * 1024;
const PUBLICATION_READ_MAX_LIMIT = 256 * 1024;

function publicationClient(): WorkbenchClient {
  const client = remoteClient();
  if (client === null) {
    throw new WorkbenchClientError({
      status: 400,
      code: 'UNSUPPORTED_MODE',
      message: 'nova publish and nova publication require via-workbench mode.',
    });
  }
  return client;
}

function parsePublicationOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('--offset must be a non-negative integer.');
  }
  return offset;
}

function parsePublicationLimit(raw: string | undefined): number {
  if (raw === undefined) return PUBLICATION_READ_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLICATION_READ_MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${PUBLICATION_READ_MAX_LIMIT}.`);
  }
  return limit;
}

program
  .command('publish')
  .description('Publish the accepted novel or a custom branch (via-workbench)')
  .option('--branch <path>', 'custom branch path JSON, e.g. {"decisions": [...]}')
  .option('--discourse-branch <name>')
  .option('--title <title>')
  .option('--json')
  .action(
    async (options: {
      branch?: string;
      discourseBranch?: string;
      title?: string;
      json?: boolean;
    }) => {
      const client = publicationClient();
      const branch = options.branch === undefined ? undefined : parseBranchPath(options.branch);
      const input: WorkbenchPublicationPublishInputV1 = {
        version: 1,
        ...(branch === undefined ? {} : { branchPath: { version: 1, branchPath: branch } }),
        ...(options.discourseBranch === undefined
          ? {}
          : { discourseBranch: options.discourseBranch }),
        ...(options.title === undefined ? {} : { title: options.title }),
      };
      const result: unknown = await client.publicationPublish(input);
      printResult(result, options.json ?? false);
      const status =
        typeof result === 'object' && result !== null && 'status' in result
          ? result.status
          : undefined;
      if (status === 'queued') {
        const operationHandle =
          typeof result === 'object' &&
          result !== null &&
          'operationHandle' in result &&
          typeof result.operationHandle === 'string'
            ? result.operationHandle
            : null;
        console.log(
          operationHandle === null
            ? 'Next step: run "nova publication status" to see the artifact.'
            : `Next step: run "nova operation wait ${operationHandle}" to track the publication.`,
        );
      }
    },
  );

const publication = program
  .command('publication')
  .description('Inspect and read Host publications (via-workbench)');
publication
  .command('status')
  .option('--publication-id <id>', 'publication id (default: canonical)')
  .option('--json')
  .action(async (options: { publicationId?: string; json?: boolean }) => {
    const client = publicationClient();
    printResult(
      await client.publicationGet({
        version: 1,
        publicationId: options.publicationId ?? 'canonical',
      }),
      options.json ?? false,
    );
  });
publication
  .command('read <id>')
  .description('Print a bounded markdown slice of one publication artifact')
  .option('--offset <n>', 'byte offset (default: 0)')
  .option('--limit <n>', `max bytes to read (default: ${PUBLICATION_READ_DEFAULT_LIMIT})`)
  .action(async (id: string, options: { offset?: string; limit?: string }) => {
    const client = publicationClient();
    const result: unknown = await client.publicationRead({
      version: 1,
      publicationId: id,
      offset: parsePublicationOffset(options.offset),
      limit: parsePublicationLimit(options.limit),
    });
    const content =
      typeof result === 'object' && result !== null && 'content' in result
        ? result.content
        : undefined;
    if (typeof content !== 'string') {
      throw new WorkbenchClientError({
        status: 502,
        code: 'INVALID_HOST_RESPONSE',
        message: 'Workbench returned an invalid publication slice.',
      });
    }
    process.stdout.write(content);
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
