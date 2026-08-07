/**
 * Host HTTP surface E2E (plan Step 10.2): health/status, setup + auth,
 * owner-only admin ACL, the capabilities product gate and honest negatives —
 * all against ONE `zhu-fu` fixture booted in `beforeAll` and closed in
 * `afterAll`, through the harness API only (see `harness/README.md`).
 *
 * The spawned production Host always has the built-in Agent disabled
 * (`agentReady` is never true outside tests), so `agent-chat` must be absent
 * from capabilities and every agent route must be unreachable (404) — the
 * enabled parity chain is covered deterministically by the host suite's
 * `tests/agent-parity-matrix.test.ts`, not duplicated here.
 *
 * NOTE on `review-hub`: capabilities currently claim the feature, but the
 * server-side browser review/gates routes are registered by a corrective
 * task (`host/browser-review-api.ts`); until it lands they 404 at the
 * listener. This spec deliberately does NOT assert the reviews route status
 * (it flips once the fix lands and is covered by that task's own tests) —
 * it only asserts the contract that holds in both states: no `/api/**`
 * response is ever the SPA shell.
 *
 * Worker note: Playwright restarts the worker after a FAILED test, wiping
 * module state, so every test here is self-sufficient: auth happens in
 * `beforeAll` (re-run by any restarted worker) and tests never depend on
 * state written by an earlier test.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_BOOTSTRAP_PASSWORD,
  type HostFixture,
  startHostFixture,
} from './harness/host-fixture.js';

test.setTimeout(120_000);

let fixture: HostFixture;
let ownerUserId = '';

const OWNER_DISPLAY_NAME = 'E2E Owner';

/** The seven features a plain production spawn must publish; agent-chat is the eighth and must be ABSENT. */
const EXPECTED_FEATURES: readonly string[] = [
  'project-home',
  'source-studio',
  'scene-canvas',
  'graph-route',
  'review-hub',
  'publication',
  'references',
];

/** Explicitly empty session header: the fixture auto-attach skips present headers. */
const NO_SESSION: RequestInit = { headers: { 'x-fabula-session': '' } };

/** Route selector the browser client itself uses at startup (canonical route). */
const CANONICAL_SELECTOR = encodeURIComponent(
  JSON.stringify({ version: 1, branchPath: { decisions: [] } }),
);

/**
 * The one hard product contract for every API path: never the SPA shell.
 * A hidden/unregistered `/api/**` route must fail as an HTTP error (404 /
 * FEATURE-unavailable), never render `index.html`.
 */
async function expectNotSpaShell(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  expect(contentType).not.toContain('text/html');
  if (!contentType.includes('application/json')) {
    const body = await response.text();
    expect(body.toLowerCase()).not.toContain('<!doctype html');
    expect(body.toLowerCase()).not.toContain('<html');
  }
}

/** Insert a real non-owner (`role='user'`) user + session into the Host SQLite. */
async function insertNonOwnerSession(home: string): Promise<string> {
  const db = new DatabaseSync(join(home, 'workbench.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const userId = `e2e-non-owner-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-${randomUUID().slice(0, 16)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          'INSERT INTO users(user_id, role, display_name, password_hash, capability_version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
        ).run(userId, 'user', 'E2E Non-Owner', 'null', 1, now, now);
        db.prepare(
          'INSERT INTO sessions(session_id, user_id, expires_at, capability_version) VALUES(?, ?, ?, ?)',
        ).run(sessionId, userId, expiresAt, 1);
        db.exec('COMMIT');
        return sessionId;
      } catch (error) {
        db.exec('ROLLBACK');
        if (attempt >= 4) throw error;
        // The persistence worker may hold a brief write lock; back off and retry.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 200);
        await promise;
      }
    }
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  fixture = await startHostFixture({ fixtures: ['zhu-fu'] });
  const owner = await fixture.bootstrapOwner();
  ownerUserId = owner.userId;
  // A login-issued session becomes the fixture session for every test.
  await fixture.login(owner.userId, DEFAULT_BOOTSTRAP_PASSWORD);
});

test.afterAll(async () => {
  await fixture?.close();
});

// ─── 1. health / status / unknown-API 404 ────────────────────────────────────

test('health ok and status shape; unknown API paths are 404 and never serve the SPA', async () => {
  const health = await fixture.fetchJson<{
    status: string;
    listener: { running: boolean; mode: string; port: number | null };
    protocol: { protocol: string };
  }>('/health');
  expect(health.status).toBe('ok');
  expect(health.listener.running).toBe(true);
  expect(health.listener.mode).toBe('loopback');
  expect(health.listener.port).toBeGreaterThan(0);
  expect(health.protocol.protocol).toBe('http');

  const status = await fixture.fetchJson<{
    status: string;
    endpoints: {
      health: { path: string };
      status: { path: string };
      reads: readonly unknown[];
      mutations: readonly unknown[];
      mcp: readonly unknown[];
    };
  }>('/status');
  expect(status.status).toBe('ok');
  expect(status.endpoints.health.path).toBe('/health');
  expect(status.endpoints.status.path).toBe('/status');
  expect(status.endpoints.reads.length).toBeGreaterThan(0);
  expect(status.endpoints.mutations.length).toBeGreaterThan(0);
  expect(status.endpoints.mcp.length).toBeGreaterThan(0);

  // Unknown API paths: 404 as plain HTTP errors, never index.html.
  for (const path of [
    '/api/v1/does-not-exist',
    '/api/v1/projects/zhu-fu/nonexistent-surface',
    '/api/v2/other',
    '/api/plain',
  ]) {
    const response = await fixture.fetch(path);
    expect(response.status, path).toBe(404);
    await expectNotSpaShell(response);
  }

  // The SPA fallback DOES exist for browser GET paths — proving the API
  // rejection above is real and not a missing static handler.
  const spa = await fixture.fetch('/some-client-route');
  expect(spa.status).toBe(200);
  expect(spa.headers.get('content-type') ?? '').toContain('text/html');
});

// ─── 2. setup / auth ─────────────────────────────────────────────────────────

test('setup/auth: bootstrap, login, session principal; unauthenticated session routes are 401', async () => {
  // Unauthenticated session routes → 401 (session, project read, admin read).
  for (const path of [
    '/api/v1/session',
    `/api/v1/projects/${fixture.projectId}/overview`,
    '/api/v1/admin/overview',
  ]) {
    const response = await fixture.fetch(path, NO_SESSION);
    expect(response.status, path).toBe(401);
  }

  // Bootstrap rejects a weak password without creating an owner, even after
  // the owner exists; a second full bootstrap is refused (single owner).
  const weak = await fixture.fetch('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'short', displayName: 'Bogus' }),
  });
  expect(weak.status).toBe(400);
  await expect(weak.json()).resolves.toEqual({ error: 'invalid_bootstrap' });

  const second = await fixture.fetch('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_BOOTSTRAP_PASSWORD, displayName: 'Second' }),
  });
  expect(second.status).toBe(409);
  await expect(second.json()).resolves.toEqual({ error: 'bootstrap_unavailable' });

  // Login issues a fresh session for the owner (proves the full flow end to end).
  const login = await fixture.login(ownerUserId, DEFAULT_BOOTSTRAP_PASSWORD);
  expect(login.userId).toBe(ownerUserId);
  expect(login.sessionId).toBeTruthy();

  // Wrong credentials fail uniformly with 401.
  const bad = await fixture.fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'ghost-account', password: 'wrong-password' }),
  });
  expect(bad.status).toBe(401);
  await expect(bad.json()).resolves.toEqual({ error: 'invalid_credentials' });

  // The current session resolves to a safe principal (never the session id).
  const principal = await fixture.fetchJson<{
    version: number;
    userId: string;
    role: string;
    displayName: string;
    capabilityVersion: number;
    expiresAt: string;
  }>('/api/v1/session');
  expect(principal.version).toBe(1);
  expect(principal.userId).toBe(ownerUserId);
  expect(principal.role).toBe('owner');
  expect(principal.displayName).toBe(OWNER_DISPLAY_NAME);
  expect(typeof principal.capabilityVersion).toBe('number');
  expect(principal.expiresAt.length).toBeGreaterThan(0);

  // The owner's server-scoped catalog lists the configured project.
  const projects = await fixture.fetchJson<{
    version: number;
    projects: readonly { projectId: string; displayName: string }[];
  }>('/api/v1/projects');
  expect(projects.version).toBe(1);
  expect(projects.projects.find((p) => p.projectId === fixture.projectId)?.displayName).toBe(
    'zhu-fu',
  );
});

// ─── 3. owner-only admin surface ─────────────────────────────────────────────

test('admin surface is owner-only: overview + config preview/apply with the owner, 401 unauthenticated, 403 non-owner', async () => {
  // Owner overview (config present; ephemeral port means restart-required).
  const overview = await fixture.fetchJson<{
    version: number;
    hostStatus: string;
    workerReady: boolean;
    openProjects: number;
    restartRequired: boolean;
    generatedAt: string;
  }>('/api/v1/admin/overview');
  expect(overview.version).toBe(1);
  expect(['ready', 'restart-required']).toContain(overview.hostStatus);
  expect(overview.workerReady).toBe(true);
  expect(overview.openProjects).toBeGreaterThanOrEqual(1);
  expect(typeof overview.restartRequired).toBe('boolean');
  expect(overview.generatedAt.length).toBeGreaterThan(0);

  // V3 config read: the fixture project is bound, Agent is disabled.
  const advanced = await fixture.fetchJson<{
    version: number;
    projects: readonly { projectId: string }[];
    operationLimits: { maxConcurrentRendersPerProject: number };
    agent: { enabled: boolean };
    generatedAt: string;
  }>('/api/v1/admin/config/advanced');
  expect(advanced.version).toBe(1);
  expect(advanced.projects.some((p) => p.projectId === fixture.projectId)).toBe(true);
  expect(advanced.operationLimits.maxConcurrentRendersPerProject).toBe(1);
  expect(advanced.agent.enabled).toBe(false);

  // Config preview: an empty V3-domain patch validates against the active revision.
  const preview = await fixture.fetchJson<{
    version: number;
    valid: boolean;
    diagnostics: readonly unknown[];
    restartRequired: boolean;
    candidateRevision: string | null;
  }>('/api/v1/admin/config/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  expect(preview.version).toBe(1);
  expect(preview.valid).toBe(true);
  expect(preview.diagnostics).toEqual([]);
  expect(preview.restartRequired).toBe(false);
  expect(typeof preview.candidateRevision).toBe('string');

  // Config apply: the same empty patch applies cleanly under the revision CAS.
  const applied = await fixture.fetchJson<{
    version: number;
    receipt: { status: string; activeRevision: string | null };
  }>('/api/v1/admin/config/advanced', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  expect(applied.version).toBe(1);
  expect(applied.receipt.status).toBe('applied');
  expect(applied.receipt.activeRevision?.length ?? 0).toBeGreaterThan(0);

  // Unauthenticated admin read → 401.
  const unauth = await fixture.fetch('/api/v1/admin/overview', NO_SESSION);
  expect(unauth.status).toBe(401);

  // A real non-owner session → 403 FORBIDDEN on admin, 403 PROJECT_MISMATCH on projects.
  const nonOwnerSession = await insertNonOwnerSession(fixture.home);
  const forbidden = await fixture.fetch('/api/v1/admin/overview', {
    headers: { 'x-fabula-session': nonOwnerSession },
  });
  expect(forbidden.status).toBe(403);
  await expect(forbidden.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });

  const forbiddenProject = await fixture.fetch(`/api/v1/projects/${fixture.projectId}/overview`, {
    headers: { 'x-fabula-session': nonOwnerSession },
  });
  expect(forbiddenProject.status).toBe(403);
  await expect(forbiddenProject.json()).resolves.toMatchObject({
    error: { code: 'PROJECT_MISMATCH' },
  });
});

// ─── 4. capabilities (the product gate) ──────────────────────────────────────

test('capabilities gate: six visible features, agent-chat absent, visible routes non-404, agent routes unreachable', async () => {
  // Capabilities are a session route: 401 without one.
  const unauth = await fixture.fetch(
    `/api/v1/projects/${fixture.projectId}/capabilities`,
    NO_SESSION,
  );
  expect(unauth.status).toBe(401);

  const caps = await fixture.fetchJson<{
    version: number;
    projectId: string;
    features: readonly string[];
  }>(`/api/v1/projects/${fixture.projectId}/capabilities`);
  expect(caps.version).toBe(1);
  expect(caps.projectId).toBe(fixture.projectId);
  for (const feature of EXPECTED_FEATURES) expect(caps.features).toContain(feature);
  expect(caps.features).not.toContain('agent-chat');
  expect(caps.features).toHaveLength(EXPECTED_FEATURES.length);

  // Every always-on + publication feature route is reachable (non-404).
  // project-home → overview; source-studio → source; scene-canvas + graph-route
  // → graphs; publication → publications. (review-hub's reviews route flips
  // with the corrective browser-review-api task — see header note.)
  const overview = await fixture.fetch(`/api/v1/projects/${fixture.projectId}/overview`);
  expect(overview.status).toBe(200);
  expect(overview.headers.get('content-type') ?? '').toContain('application/json');

  const source = await fixture.fetchJson<{
    version: number;
    projectId: string;
    working: { documents: readonly unknown[] };
  }>(`/api/v1/projects/${fixture.projectId}/source`);
  expect(source.version).toBe(1);
  expect(source.projectId).toBe(fixture.projectId);
  expect(Array.isArray(source.working.documents)).toBe(true);

  const graphs = await fixture.fetch(
    `/api/v1/projects/${fixture.projectId}/graphs?route=${CANONICAL_SELECTOR}`,
  );
  expect(graphs.status).toBe(200);
  expect(graphs.headers.get('content-type') ?? '').toContain('application/json');

  const publications = await fixture.fetchJson<{
    version: number;
    projectId: string;
    publications: readonly unknown[];
    generatedAt: string;
  }>(`/api/v1/projects/${fixture.projectId}/publications`);
  expect(publications.version).toBe(1);
  expect(publications.projectId).toBe(fixture.projectId);
  expect(Array.isArray(publications.publications)).toBe(true);

  // The disabled-agent state: every agent route is unreachable (404), never a stub.
  const agentRoutes = [
    ['POST', `/api/v1/projects/${fixture.projectId}/agent/conversations`],
    ['POST', `/api/v1/projects/${fixture.projectId}/agent/conversations/c1/runs`],
    ['GET', `/api/v1/projects/${fixture.projectId}/agent/conversations/c1/history`],
    ['GET', `/api/v1/projects/${fixture.projectId}/agent/conversations/c1/runs/r1/progress`],
    ['POST', `/api/v1/projects/${fixture.projectId}/agent/runs/r1/cancel`],
    ['POST', `/api/v1/projects/${fixture.projectId}/agent/runs/r1/retry`],
  ] as const;
  for (const [method, path] of agentRoutes) {
    const response = await fixture.fetch(path, { method });
    expect(response.status, `${method} ${path}`).toBe(404);
    await expectNotSpaShell(response);
  }
});

// ─── 5. honest negative ──────────────────────────────────────────────────────

test('honest negative: hidden/nonexistent features return typed HTTP errors, never an empty shell', async () => {
  // A nonexistent project is denied at the ACL boundary with a typed JSON
  // error (never an empty shell); the owner override applies only to
  // configured projects, so an unknown project id is 403 PROJECT_MISMATCH.
  const ghost = await fixture.fetch('/api/v1/projects/ghost-town/overview');
  expect(ghost.status).toBe(403);
  await expect(ghost.json()).resolves.toMatchObject({
    error: { code: 'PROJECT_MISMATCH' },
  });

  const ghostCaps = await fixture.fetch('/api/v1/projects/ghost-town/capabilities');
  expect(ghostCaps.status).toBe(403);
  await expect(ghostCaps.json()).resolves.toMatchObject({
    error: { code: 'PROJECT_MISMATCH' },
  });

  // A nonexistent resource on a real route → typed 404, never an empty shell.
  const missingPublication = await fixture.fetch(
    `/api/v1/projects/${fixture.projectId}/publications/does-not-exist/content`,
  );
  expect(missingPublication.status).toBe(404);
  await expect(missingPublication.json()).resolves.toMatchObject({
    error: { code: 'PUBLICATION_NOT_FOUND' },
  });

  // Unknown feature surface under a real project → 404 HTTP error, not HTML.
  const unknown = await fixture.fetch(`/api/v1/projects/${fixture.projectId}/holodeck`);
  expect(unknown.status).toBe(404);
  await expectNotSpaShell(unknown);

  // Every /api path — registered or not — never serves the SPA shell.
  for (const path of [
    `/api/v1/projects/${fixture.projectId}/reviews`,
    `/api/v1/projects/${fixture.projectId}/gates`,
  ]) {
    const response = await fixture.fetch(path);
    await expectNotSpaShell(response);
  }
});
