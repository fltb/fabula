/**
 * Plugin identity + canonical snapshot E2E (plan Step 10.4).
 *
 * Plugin scenarios (through the composed Host, `WORKBENCH_PROVIDER=mock`):
 *   - A trusted allowlist match (name/version/moduleHash) activates the
 *     plugin: `nova_status` reports "Plugin health: 1 active" and an
 *     EventFile `extensions` block for the enabled namespace is accepted.
 *   - A required entry whose moduleHash does not match keeps the project
 *     OPEN but blocks: `nova_status` carries a `PLUGIN_BLOCKED` blocker and
 *     "0 active, 1 blocked, 0 disabled" in guidance.
 *   - An optional mismatch disables the plugin and records it: "0 active,
 *     0 blocked, 1 disabled", no blockers, and the disabled namespace's
 *     extension payload stays structurally valid (no source error).
 *   - Identity cache invalidation: the same trusted entry + a changed plugin
 *     module (different index.js bytes → different moduleHash) flips the
 *     activation decision from active to blocked.
 *
 * Snapshot scenarios (plan Step 8, sampled end-to-end through the launched
 * Host; the full every-fixture/every-route hash equivalence is already pinned
 * by the host-suite gate `tests/state-projection-equivalence.test.ts`):
 *   - `nova_event_state_diff` returns before/after/changed through the
 *     per-source/route projection service, and the durable snapshot records
 *     persisted under the Host runtime area verify with the SAME canonical
 *     hash function the equivalence gate uses (`computeSnapshotStateHash`).
 *   - Corrupting every persisted snapshot (hash tamper) does NOT hydrate an
 *     empty state: diffs stay byte-identical, `nova_status` keeps the full
 *     render plan, and valid snapshots are rebuilt from the immutable source
 *     (quarantine + rebuild), verified by re-running the canonical hash.
 *
 * KNOWN GAP (reported, not fixed here — src/ is out of scope for E2E specs):
 * plan 7.5's `PluginExtensionSchemaRegistrar` is only exercised through Core
 * `analyzeSource`; the composed Host's validation paths (`validateNovel`,
 * coordinator diagnostics) do not wire a registrar yet, so an unknown
 * extension namespace is currently accepted structurally and does NOT surface
 * as `SOURCE_EXTENSION_NAMESPACE_UNKNOWN` / `FIX_ACCEPTED_SOURCE` in
 * `nova_status`. The spec pins the observable contract (structural acceptance,
 * no false rejection) and the flip side (plugin health) instead.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSnapshotStateHash, verifySnapshotRecord } from '@novalistically/core';
import { expect, test } from '@playwright/test';
import { type HostFixture, startHostFixture } from './harness/host-fixture.js';
import type { McpTestClient } from './harness/mcp.js';

test.setTimeout(120_000);

// ─── Plugin fixture building blocks ──────────────────────────────────────────

const PLUGIN_NAME = 'e2e-plugin';
const PLUGIN_VERSION = '1.0.0';

/** Deterministic no-op hooks; module bytes are the identity under test. */
const PLUGIN_MODULE_V1 = [
  '// e2e-plugin v1 — deterministic no-op hooks',
  'export const hooks = {',
  "  name: 'e2e-plugin',",
  '  async onLoad() {},',
  '  async onUnload() {},',
  '};',
  '',
].join('\n');

/** Different bytes → different SHA-256 moduleHash (identity invalidation). */
const PLUGIN_MODULE_V2 = [
  '// e2e-plugin v2 — deterministic no-op hooks (changed module bytes)',
  'export const hooks = {',
  "  name: 'e2e-plugin',",
  '  async onLoad() {},',
  '  async onUnload() {},',
  '};',
  '',
].join('\n');

const PLUGIN_MANIFEST = [
  `name: ${PLUGIN_NAME}`,
  `version: ${PLUGIN_VERSION}`,
  'priority: 0',
  'provides: []',
  'requires: []',
  'conflicts: []',
  'authority:',
  '  dimensions: []',
  '  exclusive: false',
  'observes:',
  '  eventTypes: []',
  '  stateDomains: []',
  '',
].join('\n');

/** EventFile `extensions` block for the enabled plugin (plan 7.5). */
const EXTENSION_BLOCK = [
  'extensions:',
  `  ${PLUGIN_NAME}:`,
  '    enabled: true',
  '    provenance: e2e-spec',
  '',
].join('\n');

const sha256Hex = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

interface TrustedPluginEntry {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** Serialize the exact V3 `workbench.yaml` shape (mirror of the harness). */
function serializeConfigYaml(
  project: { readonly projectId: string; readonly displayName: string; readonly root: string },
  trustedPlugins: readonly TrustedPluginEntry[],
): string {
  const scalar = (value: string): string => JSON.stringify(value);
  const lines: string[] = ['version: 3', 'projects:'];
  lines.push(`  - projectId: ${scalar(project.projectId)}`);
  lines.push(`    displayName: ${scalar(project.displayName)}`);
  lines.push(`    root: ${scalar(project.root)}`);
  lines.push('    revisionMirror:');
  lines.push('      mode: disabled');
  lines.push('    providerProfile: default');
  if (trustedPlugins.length === 0) {
    lines.push('    trustedPlugins: []');
  } else {
    lines.push('    trustedPlugins:');
    for (const entry of trustedPlugins) {
      lines.push(`      - name: ${scalar(entry.name)}`);
      lines.push(`        version: ${scalar(entry.version)}`);
      lines.push(`        moduleHash: ${scalar(entry.moduleHash)}`);
      lines.push(`        required: ${String(entry.required)}`);
    }
  }
  lines.push(`defaultProjectId: ${scalar(project.projectId)}`);
  lines.push('providers: {}');
  lines.push('network:');
  lines.push('  mode: loopback');
  lines.push('  port: 0');
  lines.push('  allowedHosts: []');
  lines.push('  allowedOrigins: []');
  lines.push('  unixSocket: null');
  lines.push('referenceLimits:');
  for (const [key, value] of Object.entries(REFERENCE_LIMITS)) {
    lines.push(`  ${key}: ${typeof value === 'string' ? scalar(value) : String(value)}`);
  }
  lines.push('operationLimits:');
  lines.push('  maxQueuedPerProject: 64');
  lines.push('  maxConcurrentRendersPerProject: 1');
  lines.push('  maxConcurrentRendersPerHost: 2');
  lines.push('agent:');
  lines.push('  enabled: false');
  lines.push('  maxTurns: 16');
  lines.push('  maxToolCalls: 64');
  return `${lines.join('\n')}\n`;
}

/** Fixed V3 defaults, mirrored from the harness serializer. */
const REFERENCE_LIMITS: Readonly<Record<string, number | boolean>> = {
  enabled: true,
  maxFileBytes: 104_857_600,
  maxBytesPerProject: 5_368_709_120,
  maxItemsPerProject: 10_000,
  maxPendingJobsPerProject: 4,
  maxChunksPerProject: 1_000_000,
  maxExtractedCharactersPerProject: 2_147_483_648,
  maxChunkCharacters: 12_000,
  chunkOverlapCharacters: 400,
  extractionTimeoutMs: 120_000,
  mcpImportChunkBytes: 1_048_576,
};

interface PluginScenarioOptions {
  /** index.js bytes to write into the fixture copy. */
  readonly moduleContent: string;
  /**
   * moduleHash stamped into the trusted allowlist entry. Defaults to the
   * hash of `moduleContent` (exact match); pass a different hash to force an
   * identity mismatch.
   */
  readonly trustedModuleHash?: string;
  readonly required: boolean;
  /** nova.yaml `plugins.enabled`; defaults to true (activation attempted). */
  readonly pluginsEnabled?: boolean;
  /** Append an `extensions` block for the plugin to E5 in the fixture copy. */
  readonly addExtension?: boolean;
}

/**
 * Boot the composed Host over a fixture copy carrying a plugins/ dir, a
 * plugin-enabled nova.yaml and a V3 trustedPlugins allowlist, then return a
 * connected MCP client. The fixture writes its own V3 config into ITS temp
 * home, so the trusted allowlist is injected by overriding `WORKBENCH_HOME` /
 * `WORKBENCH_DATABASE_PATH` to a spec-owned home whose `config/workbench.yaml`
 * carries the allowlist. The spec owns cleanup of that home.
 */
async function launchPluginScenario(
  options: PluginScenarioOptions,
): Promise<{ fixture: HostFixture; mcp: McpTestClient; homeDir: string }> {
  const homeDir = mkdtempSync(join(tmpdir(), 'fabula-e2e-plugin-home-'));
  const moduleHash = sha256Hex(options.moduleContent);
  const trustedModuleHash = options.trustedModuleHash ?? moduleHash;
  const trustedPlugins: TrustedPluginEntry[] = [
    {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      moduleHash: trustedModuleHash,
      required: options.required,
    },
  ];

  const fixture = await startHostFixture({
    onProjectCopied: async ({ projectRoot, projectId }) => {
      // 1. Plugin module + manifest under the fixture copy's plugins/ dir.
      const pluginDir = join(projectRoot, 'plugins', PLUGIN_NAME);
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'manifest.yaml'), PLUGIN_MANIFEST, 'utf8');
      writeFileSync(join(pluginDir, 'index.js'), options.moduleContent, 'utf8');

      // 2. nova.yaml: enable plugins (and keep snapshotInterval from zhu-fu).
      const novaPath = join(projectRoot, 'nova.yaml');
      const nova = readFileSync(novaPath, 'utf8');
      const enabled = options.pluginsEnabled ?? true;
      writeFileSync(
        novaPath,
        `${nova.replace(/\n?$/, '\n')}plugins:\n  enabled: ${String(enabled)}\n`,
        'utf8',
      );

      // 3. Optional EventFile `extensions` block on E5 (plan 7.5).
      if (options.addExtension ?? false) {
        const eventPath = join(
          projectRoot,
          'chapters',
          'chapter_01',
          'E5_threshold_rejection.yaml',
        );
        const event = readFileSync(eventPath, 'utf8');
        writeFileSync(eventPath, `${event.replace(/\n?$/, '\n')}${EXTENSION_BLOCK}`, 'utf8');
      }

      // 4. V3 config with the trusted allowlist, in the spec-owned home.
      const configDir = join(homeDir, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'workbench.yaml'),
        serializeConfigYaml(
          { projectId, displayName: projectId, root: projectRoot },
          trustedPlugins,
        ),
        'utf8',
      );
    },
    env: {
      WORKBENCH_HOME: homeDir,
      WORKBENCH_DATABASE_PATH: join(homeDir, 'workbench.sqlite'),
    },
  }).catch((error: unknown) => {
    // Boot failure: never leak the spec-owned home.
    rmSync(homeDir, { recursive: true, force: true });
    throw error;
  });

  // The standard spec skeleton: owner session before device pairing.
  await fixture.bootstrapOwner();
  const mcp = await fixture.mcpClient({});
  return { fixture, mcp, homeDir };
}

/** Close the fixture AND the spec-owned plugin home; idempotent. */
async function closeScenario(handle: {
  fixture: HostFixture | null;
  mcp: McpTestClient | null;
  homeDir: string | null;
}): Promise<void> {
  await handle.mcp?.close().catch(() => undefined);
  await handle.fixture?.close().catch(() => undefined);
  if (handle.homeDir !== null) {
    rmSync(handle.homeDir, { recursive: true, force: true });
  }
}

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function stringField(value: unknown, key: string): string | undefined {
  if (isObject(value)) {
    const field = value[key];
    if (typeof field === 'string') return field;
  }
  return undefined;
}

interface WorkflowStatus {
  readonly sourceHash: string;
  readonly renderPlan: readonly string[];
  readonly guidance: string;
  readonly blockers: readonly JsonObject[];
  readonly validationErrors: readonly JsonObject[];
}

async function statusOf(mcp: McpTestClient): Promise<WorkflowStatus> {
  const status = await mcp.call('nova_status', {});
  expect(status.ok).toBe(true);
  const data = isObject(status.data) ? status.data : {};
  const render = isObject(data.render) ? data.render : {};
  const validation = isObject(data.validation) ? data.validation : {};
  return {
    sourceHash: stringField(data, 'sourceHash') ?? '',
    renderPlan: [
      ...stringArray(render.ready),
      ...stringArray(render.blocked),
      ...stringArray(render.waiting),
      ...stringArray(render.completed),
    ],
    guidance: stringField(data, 'guidance') ?? '',
    blockers: Array.isArray(data.blockers) ? data.blockers.filter(isObject) : [],
    validationErrors: Array.isArray(validation.errors) ? validation.errors.filter(isObject) : [],
  };
}

/** Assert the exact plugin-health counts in `nova_status` guidance. */
function expectPluginHealth(
  status: WorkflowStatus,
  active: number,
  blocked: number,
  disabled: number,
): void {
  expect(status.guidance).toContain(
    `Plugin health: ${active} active, ${blocked} blocked, ${disabled} disabled.`,
  );
}

// ─── Plugin scenarios ────────────────────────────────────────────────────────

test('trusted allowlist match activates the plugin; enabled extension namespace is accepted', async () => {
  let handle: { fixture: HostFixture | null; mcp: McpTestClient | null; homeDir: string | null } = {
    fixture: null,
    mcp: null,
    homeDir: null,
  };
  try {
    const launched = await launchPluginScenario({
      moduleContent: PLUGIN_MODULE_V1,
      required: true,
      pluginsEnabled: true,
      addExtension: true,
    });
    handle = { ...launched, mcp: launched.mcp, fixture: launched.fixture };
    const mcp = launched.mcp;
    try {
      const status = await statusOf(mcp);
      // The plugin is active: health counts + no plugin blockers.
      expectPluginHealth(status, 1, 0, 0);
      expect(status.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
      // The EventFile extensions block for the enabled namespace is accepted:
      // no source/validation errors (the strict schema is structural-only for
      // extensions; the registrar gate is a core-side contract, see header).
      expect(status.validationErrors.length).toBe(0);
      // The project is fully open and the render plan is intact.
      expect(status.renderPlan.length).toBeGreaterThan(0);
      expect(status.renderPlan).toContain('E5');
    } finally {
      await mcp.close().catch(() => undefined);
    }
  } finally {
    await closeScenario(handle);
  }
});

test('required moduleHash mismatch keeps the project open but blocks render with a diagnostic', async () => {
  let handle: { fixture: HostFixture | null; mcp: McpTestClient | null; homeDir: string | null } = {
    fixture: null,
    mcp: null,
    homeDir: null,
  };
  try {
    const launched = await launchPluginScenario({
      moduleContent: PLUGIN_MODULE_V1,
      // Trusted entry carries the hash of a DIFFERENT module (identity mismatch).
      trustedModuleHash: sha256Hex(PLUGIN_MODULE_V2),
      required: true,
      pluginsEnabled: true,
    });
    handle = { ...launched, mcp: launched.mcp, fixture: launched.fixture };
    const mcp = launched.mcp;
    try {
      const status = await statusOf(mcp);
      // The project still opens (status resolves with the full plan) …
      expect(status.sourceHash.length).toBe(64);
      expect(status.renderPlan.length).toBeGreaterThan(0);
      // … but the required plugin is blocked with a diagnostic.
      expectPluginHealth(status, 0, 1, 0);
      const pluginBlocker = status.blockers.find((blocker) => blocker.code === 'PLUGIN_BLOCKED');
      expect(pluginBlocker).toBeDefined();
      expect(stringField(pluginBlocker, 'message')).toContain(PLUGIN_NAME);
      expect(stringField(pluginBlocker, 'message')).toMatch(/module hash/i);
    } finally {
      await mcp.close().catch(() => undefined);
    }
  } finally {
    await closeScenario(handle);
  }
});

test('optional moduleHash mismatch disables and records the plugin; disabled namespace stays structurally valid', async () => {
  let handle: { fixture: HostFixture | null; mcp: McpTestClient | null; homeDir: string | null } = {
    fixture: null,
    mcp: null,
    homeDir: null,
  };
  try {
    const launched = await launchPluginScenario({
      moduleContent: PLUGIN_MODULE_V1,
      trustedModuleHash: sha256Hex(PLUGIN_MODULE_V2),
      required: false,
      pluginsEnabled: true,
      addExtension: true,
    });
    handle = { ...launched, mcp: launched.mcp, fixture: launched.fixture };
    const mcp = launched.mcp;
    try {
      const status = await statusOf(mcp);
      // Optional mismatch: disabled + recorded, never a blocker.
      expectPluginHealth(status, 0, 0, 1);
      expect(status.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
      // The disabled namespace's extension payload is still structurally
      // accepted (no source error) — plan 7.5's unknown-namespace source
      // error is NOT wired in the Host validation paths yet (see header).
      expect(status.validationErrors.length).toBe(0);
      expect(status.renderPlan.length).toBeGreaterThan(0);
    } finally {
      await mcp.close().catch(() => undefined);
    }
  } finally {
    await closeScenario(handle);
  }
});

test('identity cache invalidation: changing the plugin module flips activation from active to blocked', async () => {
  // Launch A: module v1 trusted by its own hash → active.
  const launchA = await launchPluginScenario({
    moduleContent: PLUGIN_MODULE_V1,
    required: true,
    pluginsEnabled: true,
  });
  const handleA: {
    fixture: HostFixture | null;
    mcp: McpTestClient | null;
    homeDir: string | null;
  } = {
    fixture: launchA.fixture,
    mcp: launchA.mcp,
    homeDir: launchA.homeDir,
  };
  try {
    const statusA = await statusOf(launchA.mcp);
    expectPluginHealth(statusA, 1, 0, 0);
  } finally {
    await closeScenario(handleA);
  }

  // Launch B: same trusted entry (hash of v1), but the plugin module changed
  // (v2 bytes) → the activation identity no longer matches → blocked.
  const launchB = await launchPluginScenario({
    moduleContent: PLUGIN_MODULE_V2,
    trustedModuleHash: sha256Hex(PLUGIN_MODULE_V1),
    required: true,
    pluginsEnabled: true,
  });
  const handleB: {
    fixture: HostFixture | null;
    mcp: McpTestClient | null;
    homeDir: string | null;
  } = {
    fixture: launchB.fixture,
    mcp: launchB.mcp,
    homeDir: launchB.homeDir,
  };
  try {
    const statusB = await statusOf(launchB.mcp);
    expectPluginHealth(statusB, 0, 1, 0);
    const pluginBlocker = statusB.blockers.find((blocker) => blocker.code === 'PLUGIN_BLOCKED');
    expect(pluginBlocker).toBeDefined();
    // The module hash is part of the trust identity: the blocker names the
    // plugin and the hash mismatch that flipped the activation decision.
    expect(stringField(pluginBlocker, 'message')).toContain(PLUGIN_NAME);
    expect(stringField(pluginBlocker, 'message')).toMatch(/module hash/i);
  } finally {
    await closeScenario(handleB);
  }
});

// ─── Snapshot scenarios (plan Step 8, sampled through the composed Host) ─────

interface SnapshotRecordLike {
  readonly version: number;
  readonly key: unknown;
  readonly sequence: number;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly snapshotHash: string;
  readonly state: unknown;
}

/**
 * Parse one derived-stream snapshot file (Host runtime area). The full raw
 * record (including the stream `key`) is preserved so tampered records still
 * pass the repository's structural filter and reach the ReplayEngine hash
 * verification — the actual quarantine path.
 */
function readSnapshotFile(file: string): SnapshotRecordLike[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown };
  if (!Array.isArray(parsed.records)) return [];
  return parsed.records
    .filter(isObject)
    .map((record) => ({
      version: record.version as number,
      key: record.key,
      sequence: record.sequence as number,
      schema: stringField(record, 'schema') ?? '',
      schemaVersion: record.schemaVersion as number,
      snapshotHash: stringField(record, 'snapshotHash') ?? '',
      state: record.state,
    }))
    .filter((record) => Number.isInteger(record.sequence) && record.snapshotHash.length > 0);
}

test('snapshot projection: diff correctness through the host + quarantine/rebuild from immutable source', async () => {
  let handle: { fixture: HostFixture | null; mcp: McpTestClient | null; homeDir: string | null } = {
    fixture: null,
    mcp: null,
    homeDir: null,
  };
  try {
    const fixture = await startHostFixture(); // default zhu-fu (snapshotInterval 3)
    await fixture.bootstrapOwner();
    const mcp = await fixture.mcpClient({});
    handle = { fixture, mcp, homeDir: null };
    try {
      // First status call lazily builds the derived stream and persists the
      // interval snapshots under the Host runtime area.
      const status = await statusOf(mcp);
      expect(status.renderPlan.length).toBeGreaterThan(0);
      // Default fixture does not enable plugins: no plugin health line.
      expect(status.guidance).not.toContain('Plugin health');

      // Every planned event diffs through the per-source/route projection
      // service (nearest verified snapshot → suffix replay).
      const diffs = new Map<string, unknown>();
      for (const eventId of status.renderPlan) {
        const diff = await mcp.call('nova_event_state_diff', { eventId });
        expect(diff.ok, `diff failed for ${eventId}: ${JSON.stringify(diff)}`).toBe(true);
        expect(isObject(diff.data)).toBe(true);
        expect(stringField(diff.data, 'eventId')).toBe(eventId);
        expect(isObject(diff.data)).toBe(true);
        const data = diff.data as JsonObject;
        expect(isObject(data.before)).toBe(true);
        expect(isObject(data.after)).toBe(true);
        expect(Array.isArray(data.changed)).toBe(true);
        diffs.set(eventId, diff.data);
      }
      expect(diffs.size).toBeGreaterThan(0);

      // The persisted snapshots verify with the SAME canonical hash the
      // equivalence gate uses (host-suite: state-projection-equivalence).
      const snapshotDir = join(
        fixture.home,
        'projects',
        fixture.projectId,
        'runtime',
        'state-snapshots',
      );
      const snapshotFiles = readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(snapshotDir, name));
      expect(snapshotFiles.length).toBeGreaterThan(0);
      const snapshotFile = snapshotFiles[0];
      const records = readSnapshotFile(snapshotFile);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.schema).toBe('canonical-world');
        expect(record.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
        // THE equivalence-helper assertion: stored hash == canonical hash of
        // the stored state (the same function the host-suite gate imports).
        expect(record.snapshotHash).toBe(computeSnapshotStateHash(record.state as never));
        expect(verifySnapshotRecord(record as never).valid).toBe(true);
      }
      const originalSequences = records.map((record) => record.sequence);

      // Corrupt EVERY snapshot: tamper the stored hashes (detectable without
      // trusting the store). A corrupt snapshot must never hydrate as an
      // empty state — quarantine + rebuild from the immutable source.
      const tampered = records.map((record) => ({ ...record, snapshotHash: '0'.repeat(64) }));
      writeFileSync(
        snapshotFile,
        JSON.stringify({ version: 1, key: records[0]?.key ?? null, records: tampered }),
        'utf8',
      );

      // Diffs stay byte-identical after corruption (full-replay fallback).
      for (const eventId of status.renderPlan) {
        const diff = await mcp.call('nova_event_state_diff', { eventId });
        expect(diff.ok).toBe(true);
        expect(diff.data).toEqual(diffs.get(eventId));
      }

      // Status keeps the full render plan — never an empty state.
      const statusAfter = await statusOf(mcp);
      expect(statusAfter.renderPlan).toEqual(status.renderPlan);

      // Rebuild: valid snapshots derived from the immutable source now cover
      // every original snapshot position.
      const rebuilt = readSnapshotFile(snapshotFile);
      const validBySequence = new Map<number, SnapshotRecordLike>();
      for (const record of rebuilt) {
        if (verifySnapshotRecord(record as never).valid)
          validBySequence.set(record.sequence, record);
      }
      for (const sequence of originalSequences) {
        const valid = validBySequence.get(sequence);
        expect(valid, `no valid rebuilt snapshot at sequence ${sequence}`).toBeDefined();
        expect(valid?.snapshotHash).toBe(computeSnapshotStateHash(valid?.state as never));
      }
    } finally {
      await mcp.close().catch(() => undefined);
    }
  } finally {
    await closeScenario(handle);
  }
});

test('snapshot sampling: a second fixture diffs and persists verifiable snapshots through the host', async () => {
  let fixture: HostFixture | null = null;
  let mcp: McpTestClient | null = null;
  try {
    // Same derived-stream machinery over a second, non-default project. The
    // full every-fixture/every-route hash equivalence stays in the host
    // suite (state-projection-equivalence); this leg samples one extra
    // fixture end-to-end through the composed Host. NOTE: the nested branch
    // fixtures (zhu-fu-variants/…) cannot boot through the harness — the V3
    // config rejects a '/' in the projectId (fixture name) — and most older
    // fixtures fail the current StoryGraph compiler, so the two-event
    // arcane-aftermath fixture stands in for the branch sample.
    fixture = await startHostFixture({
      fixtures: ['arcane-aftermath'],
      onProjectCopied: async ({ projectRoot }) => {
        // 2 canonical events with the fixture's interval 20 would persist no
        // snapshots; force interval 1 so the derived stream persists both
        // positions and the canonical-hash verification has records to check.
        const novaPath = join(projectRoot, 'nova.yaml');
        const nova = readFileSync(novaPath, 'utf8');
        writeFileSync(
          novaPath,
          nova.replace(/snapshotInterval:\s*\d+/, 'snapshotInterval: 1'),
          'utf8',
        );
      },
    });
    await fixture.bootstrapOwner();
    mcp = await fixture.mcpClient({});

    const status = await statusOf(mcp);
    expect(status.renderPlan.length).toBeGreaterThan(0);
    for (const eventId of status.renderPlan) {
      const diff = await mcp.call('nova_event_state_diff', { eventId });
      expect(diff.ok, `branch diff failed for ${eventId}: ${JSON.stringify(diff)}`).toBe(true);
      const data = diff.data as JsonObject;
      expect(isObject(data.before)).toBe(true);
      expect(isObject(data.after)).toBe(true);
      expect(Array.isArray(data.changed)).toBe(true);
    }

    // The second stream's persisted snapshots verify with the same canonical
    // hash function the equivalence gate imports.
    const snapshotDir = join(
      fixture.home,
      'projects',
      fixture.projectId,
      'runtime',
      'state-snapshots',
    );
    const snapshotFiles = readdirSync(snapshotDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(snapshotDir, name));
    expect(snapshotFiles.length).toBeGreaterThan(0);
    for (const record of readSnapshotFile(snapshotFiles[0])) {
      expect(record.snapshotHash).toBe(computeSnapshotStateHash(record.state as never));
      expect(verifySnapshotRecord(record as never).valid).toBe(true);
    }
  } finally {
    await mcp?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
  }
});
