# E2E tests

This directory holds the step-10 E2E harness and specs:

- `harness/host-fixture.ts` — boots the built composed Workbench Host as a
  child process (temp `WORKBENCH_HOME`, copied `fixtures/zhu-fu`, mock
  provider, loopback bootstrap, built client assets), waits for the fd-3
  `ready` frame + `/health`, and tears down via the control-frame shutdown.
- `harness/mcp.ts` — typed MCP Streamable-HTTP client over the
  `@modelcontextprotocol/sdk`, authenticated with an owner-paired device
  credential.
- `harness/host-fixture.spec.ts` — the harness's own self-test.
- `harness/README.md` — the **API contract** for the sibling specs
  (`host-http`, `mcp-chain`, `browser`, concurrency, plugin/snapshot).

`npm run test:e2e` in this package runs Playwright with `workers: 1`; the
fixture is spec-local, so there is no shared `webServer` and no fixed port.
Requires the built host + client assets (`npm run build` in
`packages/workbench`).
