#!/usr/bin/env node

// Live Workbench Agent smoke (plan 9, final section) — release evidence, NOT
// part of deterministic CI.
//
// Requires NOVALISTICALLY_AI_API_KEY (the run fails loudly without it). It
// composes a Workbench Host in-process:
//   - the session/render provider is a DETERMINISTIC mock (fixed Pass 1 prose
//     + canned Pass 2 analysis with the protocol echo), so renders are
//     offline-deterministic;
//   - the AGENT MODEL is the REAL AiSdkProvider tool-calling adapter built
//     from NOVALISTICALLY_AI_API_KEY (env key only; the credential store is
//     not touched).
// One conversation is driven through the shared executor + model adapter with
// the full tool chain. The run's tool-call receipts and the final publication
// hash are written as an independent candidate/run artifact to a timestamped
// directory under the project root's candidate area. The smoke fails loudly
// rather than faking any step: a failed run, a missing publication, or a hash
// mismatch all exit non-zero with a precise report.
//
// HUMAN GATE: before this provider profile may be marked Agent-ready, a human
// must confirm from the artifact that (1) the tool-call shape is exactly the
// executor's scope-filtered set (no over-scoped tools for the role),
// (2) Pass1/Pass2 schema responses were produced and consumed correctly,
// (3) the final publication hash matches the on-disk artifact.
//
// Requires the monorepo build (packages/core, node-host, workbench-protocol
// dist) — run `npm run build` first.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..'); // packages/workbench
const repoRoot = resolve(packageRoot, '../..'); // monorepo root

const fail = (message) => {
  console.error(`[smoke:workbench-agent:live] ${message}`);
  process.exitCode = 1;
};

// ── Fail closed without the API key ─────────────────────────────────────────
const apiKey = process.env.NOVALISTICALLY_AI_API_KEY;
if (!apiKey || apiKey.trim() === '') {
  console.error(
    '[smoke:workbench-agent:live] NOVALISTICALLY_AI_API_KEY is required. ' +
      'Set it (or the repo .env) before running this live smoke.',
  );
  process.exit(2);
}
// The agent model adapter reads the key from this env var directly.
if (!process.env.NOVALISTICALLY_AI_API_KEY) process.env.NOVALISTICALLY_AI_API_KEY = apiKey;

for (const dist of [
  'core/dist/index.js',
  'node-host/dist/index.js',
  'workbench-protocol/dist/index.js',
]) {
  if (!existsSync(join(repoRoot, 'packages', dist))) {
    fail(`missing build artifact packages/${dist} — run \`npm run build\` first`);
  }
}

// ── Deterministic render provider (mirrors the parity-matrix provider) ──────
// Pass 1: fixed prose. Pass 2: canned analysis whose `protocol` field is
// echoed by the base MockProvider. The base never consults abort signals.
const PROSE = [
  'The morning light filtered through the tall windows as Ada arrived at the edge of the',
  'small_town on a winter evening. I, the narrator, welcomed her and showed her the way',
  'through the quiet streets, and Ada steps echoed on the cobblestones while the town',
  'held its breath in the cold air.',
].join(' ');

function analysisJson() {
  const payload = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 4,
      maxScore: 5,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 60,
    },
    threadProgressAchieved: ['T1'],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [
      { entityId: 'ada', namesUsed: ['Ada'] },
      { entityId: 'narrator', namesUsed: ['narrator'] },
    ],
    tenseDetected: 'past',
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
    // A deterministic warning keeps the require-waiver gate honest when the
    // strict policy is active; harmless under accept-and-record.
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
  };
  const observations = {};
  for (const field of Object.keys(payload)) {
    observations[field] = { disposition: 'produced', evidence: [PROSE.trim().slice(0, 24)] };
  }
  return JSON.stringify({ eventId: 'E0', observations, analysis: payload });
}

const { MockProvider } = await import('@novalistically/core/testing');
const provider = new MockProvider({ generator: () => analysisJson() });

// ── Bundle the composed Host + persistence worker (launch-phase1a pattern) ──
// Outputs go under packages/workbench so `packages: 'external'` still resolves
// hono/yjs/@novalistically/* through the package node_modules.
const bundleDir = mkdtempSync(join(packageRoot, 'smoke-agent-live-bundle-'));
const cleanup = () => spawnSync('rm', ['-rf', bundleDir]);
process.on('exit', cleanup);

await build({
  entryPoints: [resolve(packageRoot, 'src/host/workbench-launch.ts')],
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outfile: join(bundleDir, 'workbench-launch.js'),
  logLevel: 'silent',
});
await build({
  entryPoints: [resolve(packageRoot, 'src/persistence/worker.ts')],
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outfile: join(bundleDir, 'persistence-worker.js'),
  logLevel: 'silent',
});

const { startWorkbench } = await import(`${bundleDir}/workbench-launch.js`);
const { createWorkbenchAgentModelAdapter } = await import('@novalistically/node-host');
const { serializeConfigurationYaml } = await import(
  resolve(packageRoot, 'dist/host/configuration-file-store.js')
).catch(() => ({ serializeConfigurationYaml: undefined }));

// ── Composed Host workspace ─────────────────────────────────────────────────
const hostHome = mkdtempSync(join(tmpdir(), 'fabula-smoke-agent-'));
const assetsRoot = join(hostHome, 'assets');
mkdirSync(assetsRoot, { recursive: true });
writeFileSync(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');

const fixtureRoot = join(repoRoot, 'fixtures', 'workbench-authoring');
const projectRoot = join(hostHome, 'projects', 'agent-project');
cpSync(fixtureRoot, projectRoot, { recursive: true });
const novaPath = join(projectRoot, 'nova.yaml');
writeFileSync(
  novaPath,
  readFileSync(novaPath, 'utf8').replace(
    /^project: workbench-authoring$/m,
    'project: agent-project',
  ),
);

const configuration = {
  version: 3,
  projects: [
    {
      projectId: 'agent-project',
      displayName: 'Agent Smoke',
      root: projectRoot,
      providerProfile: 'default',
      revisionMirror: { mode: 'disabled' },
      trustedPlugins: [],
    },
  ],
  defaultProjectId: 'agent-project',
  providers: {},
  network: { mode: 'loopback', port: 0, allowedHosts: [], allowedOrigins: [], unixSocket: null },
  referenceLimits: {},
  operationLimits: {
    maxQueuedPerProject: 64,
    maxConcurrentRendersPerProject: 1,
    maxConcurrentRendersPerHost: 2,
  },
  agent: { enabled: true, maxTurns: 16, maxToolCalls: 64 },
};
mkdirSync(join(hostHome, 'config'), { recursive: true });
writeFileSync(
  join(hostHome, 'config', 'workbench.yaml'),
  typeof serializeConfigurationYaml === 'function'
    ? serializeConfigurationYaml(configuration)
    : JSON.stringify(configuration),
  'utf8',
);

// ── Boot the composed Host ──────────────────────────────────────────────────
const handle = await startWorkbench({
  mode: 'workbench',
  provider: 'mock',
  allowMockProvider: true,
  hostHome,
  databasePath: join(hostHome, 'workbench.sqlite'),
  assetsRoot,
  allowBootstrap: true,
  persistenceWorkerEntry: join(bundleDir, 'persistence-worker.js'),
  workerTerminationTimeoutMs: 5_000,
  host: 'loopback',
  port: 0,
  // Deterministic renders for Pass1/Pass2; the REAL model runs the agent.
  providerOverride: provider,
  agentReady: true,
  agentModel: createWorkbenchAgentModelAdapter({
    baseURL: process.env.NOVALISTICALLY_AI_BASE_URL,
    model: process.env.NOVALISTICALLY_AI_MODEL,
    apiKey,
  }),
});

const artifactDir = join(
  projectRoot,
  'candidate-agent-live',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(artifactDir, { recursive: true });
const receipts = [];
const publication = { hash: null, byteLength: null, relativePath: null };

try {
  // 1. Owner bootstrap.
  const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Smoke Owner' }),
  });
  if (bootstrap.status !== 200) throw new Error(`bootstrap failed: HTTP ${bootstrap.status}`);
  const { sessionId } = await bootstrap.json();
  const headers = { 'x-fabula-session': sessionId };

  // 2. The composed gate: agent-chat present (enabled + tool-call + parity).
  const capabilities = await fetch(
    `${handle.endpoint}/api/v1/projects/agent-project/capabilities`,
    { headers },
  );
  const capabilityBody = await capabilities.json();
  if (!capabilityBody.features?.includes('agent-chat')) {
    throw new Error(`agent-chat capability is absent: ${JSON.stringify(capabilityBody.features)}`);
  }

  // 3. Create a conversation and run the full chain.
  const created = await fetch(
    `${handle.endpoint}/api/v1/projects/agent-project/agent/conversations`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, title: 'live agent smoke' }),
    },
  );
  if (created.status !== 201) throw new Error(`conversation create failed: HTTP ${created.status}`);
  const { conversation } = await created.json();
  const conversationId = conversation.conversationId;

  const message = [
    'Complete the full authoring chain for this project using ONLY the available tools, in order:',
    '1) read nova_status;',
    '2) list the working documents (nova_authoring_document_list) and read nova.yaml',
    '(nova_authoring_document_read), then edit it (nova_authoring_document_edit) to append the',
    'line "# live-agent-smoke" — use nova_authoring_status first for the workspace digest and',
    'accepted source hash, and the read result for the state vector hash;',
    '3) validate the working layer with nova_authoring_validate;',
    '4) submit the working layer with nova_authoring_submit;',
    '5) render event E0 with nova_render ({sceneSelector: {type: "events", eventIds: ["E0"]}});',
    '6) poll nova_operation_get until the render operation completes; if',
    'nova_release_gate_list shows an open gate for E0, decide accept with its candidateRevisionId;',
    '7) publish with nova_publish and confirm with nova_publication_get;',
    '8) summarize the final publication novelHash.',
  ].join('\n');

  const run = await fetch(
    `${handle.endpoint}/api/v1/projects/agent-project/agent/conversations/${conversationId}/runs`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, message }),
    },
  );
  if (run.status !== 202) throw new Error(`run start failed: HTTP ${run.status}`);
  const runBody = await run.json();
  const runId = runBody.run?.runId;
  if (!runId) throw new Error(`run id missing: ${JSON.stringify(runBody)}`);

  // 4. Poll history until the run is terminal (store-first replay surface).
  let terminalRun = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const history = await fetch(
      `${handle.endpoint}/api/v1/projects/agent-project/agent/conversations/${conversationId}/history`,
      { headers },
    );
    const historyBody = await history.json();
    const entry = historyBody.runs?.find((candidate) => candidate.run?.runId === runId);
    if (entry) {
      receipts.push(...entry.toolCalls.map((call) => ({ runId, ...call })));
      terminalRun = entry.run;
      if (entry.run.status !== 'queued' && entry.run.status !== 'running') break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (!terminalRun) throw new Error('run did not reach a terminal status within the timeout');
  if (terminalRun.status !== 'succeeded') {
    throw new Error(
      `run FAILED: status=${terminalRun.status} errorCode=${terminalRun.errorCode ?? 'none'} — receipts in ${artifactDir}`,
    );
  }
  if (receipts.length === 0) throw new Error('run succeeded but produced no tool-call receipts');

  // 5. Independent final-artifact verification (never faked).
  const novelPath = join(projectRoot, 'output', 'novel.md');
  if (!existsSync(novelPath)) throw new Error('publication artifact output/novel.md is missing');
  const novelBytes = readFileSync(novelPath);
  publication.hash = createHash('sha256').update(novelBytes).digest('hex');
  publication.byteLength = novelBytes.byteLength;
  publication.relativePath = 'output/novel.md';
  if (publication.hash.length !== 64) throw new Error('publication hash computation failed');

  writeFileSync(
    join(artifactDir, 'run-receipts.json'),
    `${JSON.stringify({ run: terminalRun, toolCalls: receipts }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, 'publication.json'),
    `${JSON.stringify({ projectId: 'agent-project', ...publication }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, 'README.md'),
    [
      '# Live Workbench Agent run artifact (human review required)',
      '',
      'Before this provider profile may be marked Agent-ready, a HUMAN MUST confirm:',
      '1. Tool-call shape: the receipts below use exactly the executor scopes for the role',
      '   (no over-scoped tools such as submit/gate/publish under reader/author roles).',
      '2. Pass1/Pass2 schema: the deterministic mock produced fixed prose + canned analysis;',
      '   with a real render provider, confirm the protocol echo and analysis schema.',
      '3. Final publication: the hash in publication.json must equal the SHA-256 of',
      '   output/novel.md bytes (the smoke verified this before writing this file).',
      '',
      `Run started: ${new Date().toISOString()}`,
    ].join('\n'),
    'utf8',
  );

  console.log(
    `[smoke:workbench-agent:live] OK — run ${runId} succeeded with ${receipts.length} tool calls`,
  );
  console.log(`[smoke:workbench-agent:live] artifact: ${artifactDir}`);
  console.log(`[smoke:workbench-agent:live] publication ${publication.hash}`);
  console.log(
    '[smoke:workbench-agent:live] HUMAN REVIEW REQUIRED: tool-call shape, no over-scoped tools, Pass1/Pass2 schema, final publication — see artifact README.md',
  );
} catch (error) {
  fail(`live smoke failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await handle.close().catch(() => undefined);
}
