/**
 * Harness self-test: proves the E2E host fixture works standalone — it boots
 * the BUILT composed Host child, reaches readiness (fd3 ready frame +
 * `/health`), serves the capabilities route, pairs a device over MCP, and
 * tears down cleanly (process gone, temp dirs removed).
 *
 * Sibling specs (`host-http`, `mcp-chain`, `browser`, concurrency,
 * plugin/snapshot) consume the same `startHostFixture` API — see
 * `harness/README.md` for the contract.
 */

import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { type HostFixture, MAINTAINER_SCOPES, startHostFixture } from './host-fixture.js';

test.setTimeout(90_000);

/** `process.kill(pid, 0)` throws ESRCH when the process is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('boots the composed host, serves health + capabilities, closes cleanly', async () => {
  let fixture: HostFixture | null = null;
  try {
    fixture = await startHostFixture();
    expect(fixture.projectId).toBe('zhu-fu');
    expect(fixture.ready.listenerMode).toBe('workbench');
    expect(fixture.ready.bootstrapRequired).toBe(false);
    expect(fixture.ready.endpoint).toBe(fixture.endpoint);
    expect(processAlive(fixture.hostPid)).toBe(true);

    // ── /health ─────────────────────────────────────────────────────────
    const health = await fixture.fetchJson<{ status: string }>('/health');
    expect(health.status).toBe('ok');

    // ── capabilities route (requires an owner session) ──────────────────
    const owner = await fixture.bootstrapOwner();
    expect(owner.userId).toBeTruthy();
    expect(owner.sessionId).toBeTruthy();

    const capabilities = await fixture.fetchJson<{
      version: number;
      projectId: string;
      features: readonly string[];
    }>(`/api/v1/projects/${fixture.projectId}/capabilities`);
    expect(capabilities.version).toBe(1);
    expect(capabilities.projectId).toBe(fixture.projectId);
    expect(capabilities.features).toContain('project-home');
    // The spawned production Host never enables the built-in Agent gate.
    expect(capabilities.features).not.toContain('agent-chat');

    // ── device pairing + MCP surface ────────────────────────────────────
    const paired = await fixture.pairDevice({ scopes: MAINTAINER_SCOPES });
    expect(paired.credential.startsWith('wbd_')).toBe(true);
    expect(paired.scopes).toEqual([...MAINTAINER_SCOPES]);

    const mcp = await fixture.mcpClient({ credential: paired.credential });
    try {
      const tools = await mcp.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('nova_status');
      expect(names).toContain('nova_authoring_status');

      const status = await mcp.call('nova_status', {});
      expect(status.ok).toBe(true);
      expect(status.data).toMatchObject({ version: 1, projectId: fixture.projectId });
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture?.close();
  }

  // ── clean shutdown: process gone, temp dirs removed ───────────────────
  expect(fixture?.closed).toBe(true);
  if (fixture !== null) {
    expect(processAlive(fixture.hostPid)).toBe(false);
    expect(existsSync(fixture.home)).toBe(false);
    expect(existsSync(fixture.projectsRoot)).toBe(false);
  }
});
