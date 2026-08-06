# E2E harness — API contract

The step-10 E2E harness boots the **built composed Workbench Host** as a child
process and exposes one typed API (`startHostFixture`) plus a typed MCP client
(`McpTestClient`). Every E2E spec (`host-http`, `mcp-chain`, `browser`,
concurrency, plugin/snapshot) MUST use these helpers and nothing else to talk
to the Host.

## Prerequisites

- Build the Host + client before running E2E:
  `npm run build` in `packages/workbench` (produces `dist/host/**` and
  `dist/client/`). The fixture fails fast with a clear message when the
  artifacts are missing.
- Node `26.5.0` (`fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench test:e2e`).
- The fixture always uses `WORKBENCH_PROVIDER=mock` +
  `WORKBENCH_ALLOW_MOCK_PROVIDER=true` — deterministic, no API key, no network.

## `startHostFixture(options)` → `HostFixture`

```ts
import { startHostFixture } from './harness/host-fixture.js';

const fixture = await startHostFixture({
  fixtures: ['zhu-fu'],        // optional; fixture dirs under repo fixtures/
  readyTimeoutMs: 30_000,      // optional; readiness bound
  env: { ... },                // optional; extra env for the Host child
  onProjectCopied: async ({ projectRoot, projectId }) => { ... }, // optional
  skipConfigFile: false,       // optional; boot from env only (boot-failure specs)
  keepAlive: false,            // optional; keep temp dirs on close (debug)
});
```

What it does, exactly:

1. Creates a temp `WORKBENCH_HOME` (SQLite lives at
   `$HOME/workbench.sqlite`) and a temp projects root, then copies each
   requested fixture dir into it. The first fixture is
   `WORKBENCH_PROJECT_ROOT`; its basename is the Host `projectId`
   (`'zhu-fu'` for the default). A V3 `workbench.yaml` is always written into
   the temp home (every project configured, `defaultProjectId` = first
   fixture) — the admin surface (device pairing, provider/plugin config)
   rejects with "The Host is not configured yet" without it. `skipConfigFile`
   opts out for boot-failure scenarios (e.g. the concurrency spec's
   authority-lease rejection, which must fail during launch).
2. Spawns the built host entry (`packages/workbench/dist/host/host/main.js`,
   the same file `scripts/start.mjs workbench` runs) with
   `WORKBENCH_PROVIDER=mock`, `WORKBENCH_ALLOW_MOCK_PROVIDER=true`,
   `WORKBENCH_ALLOW_BOOTSTRAP=true`, loopback host, **port 0** (ephemeral —
   the real endpoint comes from the fd-3 `ready` frame), `WORKBENCH_ASSETS_ROOT`
   pointed at the built `dist/client`, and `WORKBENCH_CONTROL_FD3=3`.
3. Readiness: waits for the fd-3 `ready` frame
   (`{version:1,type:'ready',endpoint,build,pid,listenerMode,bootstrapRequired}`)
   **and** for `GET /health` to return `{status:'ok'}`. A `fatal` frame, a
   pre-ready child exit, or a timeout rejects with a typed `HostFixtureError`
   whose message includes the Host log tail.
4. Returns the fixture (below). `close()` sends the fd-3 `shutdown` control
   frame (`{version:1,type:'shutdown',requestId,deadlineMs}`), waits for the
   `stopped` ack, closes its end of the control pipe, then falls back to
   bounded SIGTERM → SIGKILL. **The Host child and every temp dir are always
   cleaned up** (unless `keepAlive`).

### Boot errors

`startHostFixture` rejects with a `HostFixtureError` (`code` + message with
host log tail). The codes specs should assert on:

- `HOST_FATAL` — the Host sent a fd-3 `fatal` frame (e.g. the authority-lease
  rejection when a second Host opens the same root — concurrency spec).
- `HOST_EXITED` — the Host child exited before signaling ready.
- `CONTROL_TIMEOUT` / `HEALTH_TIMEOUT` — readiness never completed.
- `BUILD_ARTIFACTS_MISSING` / `FIXTURE_NOT_FOUND` — setup problems.
- `OWNER_SESSION_REQUIRED` / `SCOPE_INVALID` / `INVALID_INPUT` — misuse.

### `HostFixture` surface

| Member | Type | Contract |
|---|---|---|
| `endpoint` | `string` | Base HTTP URL from the ready frame (loopback TCP, ephemeral port). |
| `home` | `string` | Temp `WORKBENCH_HOME`; removed by `close()`. |
| `projectsRoot` | `string` | Temp dir with the copied fixtures; removed by `close()`. |
| `projectRoot` | `string` | First copied project dir (the `WORKBENCH_PROJECT_ROOT`). |
| `projectId` | `string` | Host project id of the first fixture (`basename`). |
| `hostPid` | `number` | PID of the Host child (from the ready frame). |
| `ready` | `HostReadyFrameV1` | The parsed fd-3 ready frame (endpoint/build/pid/…). |
| `closed` | `boolean` | True after `close()` ran. |
| `logs()` | `readonly string[]` | Last ~200 lines of Host stdout+stderr. |
| `fetch(path, init?)` | `Promise<Response>` | Raw fetch against `endpoint`; auto-attaches `x-fabula-session` when a session is set (override by passing your own header). Use for status assertions (e.g. route non-404 / feature-unavailable). |
| `fetchJson<T>(path, init?)` | `Promise<T>` | `fetch` + 2xx check + parsed JSON; throws `HostHttpError` on non-2xx. |
| `bootstrapOwner(password?)` | `Promise<{sessionId,userId}>` | `POST /api/v1/auth/bootstrap`; stores the session for later calls. |
| `login(userId, password)` | `Promise<{sessionId,userId}>` | `POST /api/v1/auth/login`; stores the session for later calls. |
| `pairDevice({scopes?, role?, label?, ttlMs?})` | `Promise<{credential,device,scopes}>` | Issues + claims a **project** device. Default scopes = maintainer grant (`mcp:read,mcp:render,mcp:author,mcp:submit`). Scopes must be covered by one role grant; `role` is derived automatically. Requires a session. |
| `mcpClient({scopes?, credential?, …})` | `Promise<McpTestClient>` | Typed MCP client for `{endpoint}/mcp/projects/{projectId}`, authenticated with a fresh paired device (or a passed-in `credential`). Connected before returning. |
| `readProjectFile(relPath)` | `Promise<string>` | Read a file in `projectRoot` (escape-guarded). |
| `writeProjectFile(relPath, content)` | `Promise<void>` | Write a file in `projectRoot` (escape-guarded; creates parents). |
| `close()` | `Promise<void>` | Control-frame shutdown → fd-3 EOF → bounded SIGTERM → SIGKILL; removes temp dirs. Idempotent. |

### Standard spec skeleton

```ts
import { test, expect } from '@playwright/test';
import { startHostFixture } from './harness/host-fixture.js';

test('…', async () => {
  const fixture = await startHostFixture();
  try {
    await fixture.bootstrapOwner();
    const { credential } = await fixture.pairDevice(); // maintainer scopes
    const mcp = await fixture.mcpClient({ credential });
    try {
      const tools = await mcp.listTools();
      const status = await mcp.call('nova_status', {});
      expect(status.ok).toBe(true);
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
  }
});
```

Always `close()` in a `finally` — never yield an unclosed fixture.

## `McpTestClient` (harness/mcp.ts)

A typed wrapper over the `@modelcontextprotocol/sdk` Streamable-HTTP client,
authenticated with the device credential (`Authorization: Bearer`, device
mode — no session header). The Host endpoint is stateless.

| Member | Contract |
|---|---|
| `connect()` | MCP `initialize` handshake (called by `mcpClient()`). |
| `listTools()` | `Promise<McpToolInfo[]>` — the exact tool set the credential's scopes unlock. |
| `call(name, input?)` | `Promise<McpCallResult>` — `tools/call`; returns `{ok:true, data}` with the parsed tool payload, or `{ok:false, error:{code,message}}` for tool-level failures (never throws for tool errors). |
| `close()` | Tears down the SDK client/transport; idempotent, error-tolerant. |

`McpCallResult.data` is the JSON body the Host wraps in
`content[0].text` — the same payload the in-process tests read via
`callProjectMcpTool(...).body`.

## HTTP surface the specs rely on

- `GET /health` → `{status:'ok', listener, protocol}`.
- `POST /api/v1/auth/bootstrap` `{password (≥12 chars), displayName?}` →
  `{sessionId, userId}`. `POST /api/v1/auth/login` `{userId, password}` →
  `{sessionId, userId}`. Browser routes take `x-fabula-session: <sessionId>`.
- `GET /api/v1/projects/:projectId/capabilities` → `{version:1, projectId,
  features}`. Hidden features (e.g. `agent-chat` in a plain production spawn)
  must have NO reachable route (404 / `FEATURE_UNAVAILABLE`).
- Device pairing (owner session): `POST /api/v1/admin/mcp-devices/issue`
  `{version:1, kind:'project', projectId, role, ttlMs}` → `{pairingCode}`;
  `POST /api/v1/admin/mcp-devices` `{version:1, pairingCode, label, scopes,
  ttlMs}` → `{credential}` (shown once). All admin bodies require
  `version: 1` and reject unknown fields.
- MCP project route: `POST {endpoint}/mcp/projects/{projectId}` with
  `Authorization: Bearer <credential>` — never use `mcpClient()` for raw
  JSON-RPC; use the typed client.

## Known quirks

- **Node 26.5.0 process-exit hang**: the Host keeps a pending `fs.read` on
  its fd-3 control pipe; calling `process.exit()` while that read is pending
  never terminates the process. The fixture works around it by closing its
  own end of the pipe after the `stopped` ack (EOF completes the read and the
  child exits with code 0). Do not "fix" teardown by sending SIGTERM alone —
  the Host ignores SIGTERM after a control-frame shutdown; SIGKILL remains
  the guaranteed final fallback and is safe (durable close already ran).
- **One Host child per fixture instance** — each gets its own temp
  `WORKBENCH_HOME`, project copy, and ephemeral port. Starting two fixtures
  on the same project root is exactly what the concurrency spec uses to test
  authority-lease rejection.
- **Built-in Agent is always disabled** in the spawned production Host
  (`agentReady` is never true outside tests), so `agent-chat` is absent from
  capabilities and has no route. The browser spec should assert the disabled
  state; parity-enabled Agent E2E is out of scope for this harness.
- **Fixtures are copied wholesale** (including any `.nova/` caches), matching
  `scripts/dev.mjs`; stale derived caches are hash-keyed and harmless. Use
  `onProjectCopied` to tweak a copy (e.g. edit `nova.yaml`) before boot.
