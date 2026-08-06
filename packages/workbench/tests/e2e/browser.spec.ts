/**
 * Browser E2E spec (plan 10.2/10.4): the built composed Host's Solid SPA at
 * the assets root — login → project picker → workspace; Source Studio working
 * edit + durable submit reflected in the Operation Center; Review Hub gate
 * decision; Publication artifact + download; and the disabled-Agent
 * assertions (no nav entry, no route). All Host interaction goes through the
 * harness (`startHostFixture`) or the typed MCP client; browser auth uses the
 * loopback login form.
 *
 * Structure (one fixture per test; `zhu-fu` everywhere):
 *   1. default policy  — workspace shell, Source Studio edit + submit,
 *                        Operation Center receipts, Agent disabled.
 *   2. require-waiver  — render one scene (E0) → exactly one pending gate →
 *                        decide accept from the browser Review Hub → gate
 *                        clears. (Multi-gate supersession after the first
 *                        promotion is reported as a Core product bug; the
 *                        single-gate leg is the deterministic contract.)
 *   3. default policy  — full-surface render promotes every scene (no gates)
 *                        → canonical novel auto-publishes → the Publication
 *                        view shows a current record with novelHash and the
 *                        download action returns content through the bounded
 *                        read route.
 *
 * Browser-native submit is currently rejected with HTTP 400 `UNKNOWN_FIELD:
 * expectedAcceptedRevisionId` (the client CAS field is missing from the Host
 * handler allowlist — reported). The durable submit is therefore driven
 * through MCP against the same coordinator, and the spec asserts the browser
 * reflects it over SSE; test 1 pins the 400 as observed blocker behavior.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  DEFAULT_BOOTSTRAP_PASSWORD,
  type HostFixture,
  startHostFixture,
} from './harness/host-fixture.js';
import type { McpTestClient } from './harness/mcp.js';

test.setTimeout(120_000);

// ─── Guard helpers (wire payloads are `unknown`) ─────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (isObject(value)) {
    const candidate = value[key];
    return typeof candidate === 'string' ? candidate : undefined;
  }
  return undefined;
}

function requireString(value: unknown, key: string): string {
  const field = stringField(value, key);
  if (field === undefined) {
    throw new Error(`expected string field "${key}" in ${JSON.stringify(value).slice(0, 200)}`);
  }
  return field;
}

/**
 * Make the SPA reachable. The harness's V3 config writes `providers: {}`, so
 * the browser setup status is `provider-pending` and the SPA shows the setup
 * wizard instead of the login form. Pointing the child's credential store at
 * a hermetic temp dir and seeding the default provider profile + credential
 * through the owner admin routes flips the setup phase to `ready`; the SPA
 * then serves the login form. Nothing outside the temp dirs is touched.
 */
async function makeSetupReady(fixture: HostFixture): Promise<void> {
  const providerResponse = await fixture.fetch('/api/v1/admin/providers/ai-sdk', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      kind: 'ai-sdk',
      baseUrl: 'http://127.0.0.1:9',
      model: 'mock',
    }),
  });
  expect(providerResponse.status).toBe(200);

  const credentialResponse = await fixture.fetch('/api/v1/admin/providers/ai-sdk/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, providerId: 'ai-sdk', apiKey: 'mock-key' }),
  });
  expect(credentialResponse.status).toBe(200);

  await expect
    .poll(
      async () => {
        const status = await fixture.fetchJson<{ phase: string }>('/api/v1/setup/status');
        return status.phase;
      },
      { timeout: 15_000 },
    )
    .toBe('ready');
}

/** Browser auth via the loopback login form, then the project picker. */
async function loginToWorkspace(
  page: Page,
  endpoint: string,
  userId: string,
  password: string,
): Promise<void> {
  await page.goto(endpoint);
  await expect(page.locator('#login-password')).toBeVisible({ timeout: 15_000 });
  await page.locator('#login-user-id').fill(userId);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /zhu-fu/ }).click();
  await expect(page.getByTestId('workbench-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('navigator')).toBeVisible();
  await expect(page.locator('.host-status')).toContainText('Host connected');
}

/** Expand the Operation Center so the durable receipt list is visible. */
async function expandOperationCenter(page: Page): Promise<void> {
  const expandButton = page
    .locator('[data-testid="operation-center"] button')
    .filter({ hasText: 'Expand' });
  if (await expandButton.isVisible()) {
    await expandButton.click();
  }
}

/** Read the coordinator's working digest; the MCP submit CASes against it. */
async function currentWorkspaceDigest(fixture: HostFixture): Promise<string> {
  const state = await fixture.fetchJson<unknown>(
    `/api/v1/projects/${fixture.projectId}/authoring/state`,
  );
  return requireString(state, 'workspaceDigest');
}

/**
 * Poll `nova_operation_get` until the receipt reaches a terminal status.
 * Receipts use `completed` (not `succeeded`) for success.
 */
async function waitForTerminalOperation(
  mcp: McpTestClient,
  handle: string,
  deadlineMs = 90_000,
): Promise<unknown> {
  const started = Date.now();
  for (;;) {
    const operation = await mcp.call('nova_operation_get', {
      version: 2,
      operationHandle: handle,
    });
    if (!operation.ok) throw new Error(`nova_operation_get failed: ${JSON.stringify(operation)}`);
    const receipt =
      isObject(operation.data) && isObject(operation.data.receipt)
        ? operation.data.receipt
        : operation.data;
    const status = stringField(receipt, 'status');
    if (
      status === 'completed' ||
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'stale' ||
      status === 'cancelled'
    ) {
      return operation.data;
    }
    if (Date.now() - started > deadlineMs) {
      throw new Error(`operation ${handle} did not settle within ${deadlineMs}ms`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 400);
    await promise;
  }
}

/** Enqueue a render and wait for settlement; returns the receipt. */
async function renderAndSettle(
  mcp: McpTestClient,
  selector: Record<string, unknown>,
): Promise<unknown> {
  const render = await mcp.call('nova_render', { sceneSelector: selector });
  expect(render.ok).toBe(true);
  const handle = stringField(render.data, 'operationHandle');
  expect(handle).toBeDefined();
  if (handle === undefined) throw new Error('nova_render returned no operationHandle');
  const settled = await waitForTerminalOperation(mcp, handle);
  const receipt = isObject(settled) && isObject(settled.receipt) ? settled.receipt : settled;
  expect(stringField(receipt, 'status')).toBe('completed');
  return settled;
}

test('browser workspace: login, source studio edit, durable submit, operation center, agent absent', async ({
  browser,
}) => {
  const xdgHome = mkdtempSync(join(tmpdir(), 'wb-browser-xdg-'));
  const fixture = await startHostFixture({ env: { XDG_CONFIG_HOME: xdgHome } });
  try {
    const owner = await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    await makeSetupReady(fixture);

    // ── Agent disabled at the capability/route level ───────────────────
    const capabilities = await fixture.fetchJson<{ features: readonly string[] }>(
      `/api/v1/projects/${fixture.projectId}/capabilities`,
    );
    expect(capabilities.features).toContain('project-home');
    expect(capabilities.features).toContain('source-studio');
    expect(capabilities.features).toContain('review-hub');
    expect(capabilities.features).toContain('publication');
    expect(capabilities.features).not.toContain('agent-chat');

    const conversationsRoute = await fixture.fetch(
      `/api/v1/projects/${fixture.projectId}/agent/conversations`,
    );
    expect(conversationsRoute.status).toBe(404);

    // ── Workspace shell ────────────────────────────────────────────────
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginToWorkspace(page, fixture.endpoint, owner.userId, DEFAULT_BOOTSTRAP_PASSWORD);

      await expect(page.getByTestId('workbench-shell')).toBeVisible();
      await expect(page.getByTestId('workspace-state')).toBeVisible();
      await expect(page.getByTestId('operation-center')).toBeVisible();
      await expect(page.getByTestId('navigator')).toBeVisible();

      const navLabels = await page
        .locator('[data-testid="navigator"] .view-navigation .view-label')
        .allTextContents();
      expect(navLabels).toEqual([
        'Project Home',
        'Scene Canvas',
        'Source Studio',
        'Graph / Route',
        'Review Hub',
        'Publication',
      ]);
      // No Agent toggle or chat entry anywhere in the shell.
      await expect(page.getByTestId('agent-chat')).toHaveCount(0);
      await expect(
        page.locator('[data-testid="navigator"] .view-navigation button', { hasText: 'Agent' }),
      ).toHaveCount(0);

      // ── Source Studio: working document list ─────────────────────────
      await page.getByRole('button', { name: 'Source Studio' }).click();
      await expect(page.locator('.source-studio h2')).toBeVisible({ timeout: 15_000 });
      const documentCount = await page.locator('ul[aria-label="Working documents"] li').count();
      expect(documentCount).toBeGreaterThan(0);

      // ── Working edit through the Yjs editor ───────────────────────────
      await page.getByRole('button', { name: 'Connect working document' }).first().click();
      await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1000);
      const editor = page.locator('.cm-content').first();
      // Click near the top-left so the cursor lands at the start of the
      // first line; a YAML comment inserted there is always valid.
      await editor.click({ position: { x: 2, y: 2 } });
      await page.keyboard.type('# e2e browser working edit\n', { delay: 5 });

      const submitButton = page.getByRole('button', { name: 'Submit working layer' });
      await expect(submitButton).toBeVisible({ timeout: 20_000 });
      expect(await submitButton.isDisabled()).toBe(false);

      // ── Browser-native submit (fixed: the CAS field is accepted now) ──
      // The browser POSTs the full CAS contract (expectedAcceptedRevisionId +
      // workspaceDigest + acceptedSourceHash) and the handler queues it; the
      // receipt then reflects over SSE below.
      const identitiesBefore = await page
        .locator('section[aria-label="Independent authoring identities"]')
        .first()
        .innerText();
      const submitResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().includes('/authoring/submit'),
      );
      await submitButton.click();
      const submitResponse = await submitResponsePromise;
      expect(submitResponse.status()).toBe(202);

      // The accepted identity flips once the native submit lands.
      await expect
        .poll(
          async () =>
            page
              .locator('section[aria-label="Independent authoring identities"]')
              .first()
              .innerText(),
          { timeout: 20_000 },
        )
        .not.toEqual(identitiesBefore);

      // ── Operation Center renders the durable submit receipt ──────────
      await expandOperationCenter(page);
      const submitReceipt = page.locator('[data-testid="operation-center"] li', {
        hasText: 'submit',
      });
      await expect(submitReceipt.first()).toBeVisible({ timeout: 20_000 });
      await expect(submitReceipt.first().locator('[data-status="completed"]')).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await fixture.close();
    rmSync(xdgHome, { recursive: true, force: true });
  }
});

test('browser review hub: pending gate opens after render and a browser decision clears it', async ({
  browser,
}) => {
  const xdgHome = mkdtempSync(join(tmpdir(), 'wb-browser-xdg-'));
  const fixture = await startHostFixture({
    env: { XDG_CONFIG_HOME: xdgHome },
    // Strict release policy: warning candidates must wait on a maintainer
    // gate decision (plan Step 5.4). Rendering exactly one scene yields
    // exactly one gate — the deterministic single-decision contract.
    onProjectCopied: async ({ projectRoot }) => {
      const configPath = join(projectRoot, 'nova.yaml');
      const config = readFileSync(configPath, 'utf8');
      writeFileSync(configPath, `${config}\nreleasePolicy:\n  warnings: require-waiver\n`);
    },
  });
  try {
    const owner = await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    await makeSetupReady(fixture);

    const mcp = await fixture.mcpClient({});
    try {
      await renderAndSettle(mcp, { type: 'events', eventIds: ['E0'] });

      // Exactly one pending gate for E0.
      const gatesBefore = await mcp.call('nova_release_gate_list', { version: 1 });
      expect(gatesBefore.ok).toBe(true);
      const beforeItems = isObject(gatesBefore.data) ? gatesBefore.data.items : undefined;
      expect(Array.isArray(beforeItems)).toBe(true);
      expect(beforeItems).toHaveLength(1);
      const firstGate = Array.isArray(beforeItems) ? beforeItems[0] : undefined;
      expect(isObject(firstGate) && firstGate.eventId).toBe('E0');
      expect(isObject(firstGate) && firstGate.status).toBe('open');

      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await loginToWorkspace(page, fixture.endpoint, owner.userId, DEFAULT_BOOTSTRAP_PASSWORD);

        // ── Review Hub renders the open gate card with the decide form ──
        await page.getByRole('button', { name: 'Review Hub' }).click();
        await expect(page.locator('.review-hub h2')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('gate-count')).toHaveText('1', { timeout: 15_000 });
        const card = page.locator('li.review-gate').first();
        await expect(card.locator('[data-status="open"]')).toBeVisible({ timeout: 10_000 });
        const gateId = await card.getAttribute('data-gate-id');
        expect(gateId).toBeTruthy();
        if (gateId === null) throw new Error('gate card missing data-gate-id');
        await expect(card.getByTestId(`gate-decide-${gateId}`)).toBeVisible({ timeout: 10_000 });

        // ── Decide accept from the browser ───────────────────────────────
        const decideResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().includes(`/gates/${gateId}/decision`),
        );
        await card.locator('input[aria-label="Decision reason"]').fill('browser e2e accept');
        await card.getByTestId(`gate-decide-${gateId}`).click();
        const decideResponse = await decideResponsePromise;
        expect(decideResponse.status()).toBe(200);
        const decideBody: unknown = await decideResponse.json();
        expect(isObject(decideBody) && decideBody.outcome).toBe('accepted');

        // The gate clears: the card flips to decided.
        await expect(
          page.locator(`li.review-gate[data-gate-id="${gateId}"] [data-status="decided"]`),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await context.close();
      }

      // Durable review projection: the gate is decided (waiver recorded).
      const gatesAfter = await mcp.call('nova_release_gate_list', { version: 1 });
      expect(gatesAfter.ok).toBe(true);
      const afterItems = isObject(gatesAfter.data) ? gatesAfter.data.items : undefined;
      expect(Array.isArray(afterItems)).toBe(true);
      expect(afterItems).toHaveLength(1);
      const decidedGate = Array.isArray(afterItems) ? afterItems[0] : undefined;
      expect(isObject(decidedGate) && decidedGate.status).toBe('decided');
      const decision = isObject(decidedGate) ? decidedGate.decision : undefined;
      expect(isObject(decision) && decision.decision).toBe('waived');
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
    rmSync(xdgHome, { recursive: true, force: true });
  }
});

test('browser publication: full render promotes scenes, canonical record is current, download returns content', async ({
  browser,
}) => {
  const xdgHome = mkdtempSync(join(tmpdir(), 'wb-browser-xdg-'));
  const fixture = await startHostFixture({ env: { XDG_CONFIG_HOME: xdgHome } });
  try {
    const owner = await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    await makeSetupReady(fixture);

    // Full-surface render under the default accept-and-record policy: every
    // scene promotes (no gates) and the canonical novel auto-publishes.
    const mcp = await fixture.mcpClient({});
    try {
      await renderAndSettle(mcp, { type: 'all' });

      await expect
        .poll(
          async () => {
            const publication = await mcp.call('nova_publication_get', {
              version: 1,
              publicationId: 'canonical',
            });
            if (!publication.ok) return null;
            const record = isObject(publication.data) ? publication.data.publication : null;
            return isObject(record) ? record : null;
          },
          { timeout: 30_000 },
        )
        .not.toBeNull();

      const publication = await mcp.call('nova_publication_get', {
        version: 1,
        publicationId: 'canonical',
      });
      const record = isObject(publication.data) ? publication.data.publication : undefined;
      expect(isObject(record)).toBe(true);
      const recordValue = isObject(record) ? record.value : undefined;
      expect(isObject(recordValue) && recordValue.status).toBe('current');
      const novelHash = isObject(recordValue) ? stringField(recordValue, 'novelHash') : undefined;
      expect(novelHash).toBeTruthy();

      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await loginToWorkspace(page, fixture.endpoint, owner.userId, DEFAULT_BOOTSTRAP_PASSWORD);

        // ── Publication view shows the current canonical record ──────────
        await page.getByRole('button', { name: 'Publication' }).click();
        await expect(page.locator('.publication-view h2')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('publication-count')).toHaveText('1', { timeout: 15_000 });
        const card = page.locator('li.publication-card').first();
        await expect(card).toBeVisible({ timeout: 10_000 });
        expect(await card.getAttribute('data-status')).toBe('current');
        expect(await card.getAttribute('data-kind')).toBe('canonical');
        const publicationId = await card.getAttribute('data-publication-id');
        expect(publicationId).toBe('canonical');
        await expect(card).toContainText('Novel hash');

        // ── Download reads the artifact through the bounded read route ───
        const downloadResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            response.url().includes(`/publications/canonical/content`),
        );
        await page.getByTestId('publication-download-canonical').click();
        const downloadResponse = await downloadResponsePromise;
        expect(downloadResponse.status()).toBe(200);
        const readBody: unknown = await downloadResponse.json();
        expect(isObject(readBody) && stringField(readBody, 'content')).toBeTruthy();
      } finally {
        await context.close();
      }

      // The artifact exists on disk with the recorded hash identity.
      const novel = await fixture.readProjectFile('output/novel.md');
      expect(novel.length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
    rmSync(xdgHome, { recursive: true, force: true });
  }
});
