# Novalistically — AGENTS.md

## What This Is

Narrative engineering system: structured YAML source → immutable source snapshot → graph/state compilation → Pass 1 prose → Pass 2 structured analysis → validators → assembled novel. Quality is controlled at the **output level**: Pass 2 produces structured self-analysis JSON, validators consume Pass 2 analysis (not regex prose scanning) for semantic checks, and `compareFact()` handles deterministic checks.

## Status

Current source-verified baseline: `docs/current-state.md` (authoritative; current source wins over dated plans and design docs). Document index: `docs/INDEX.md`. `docs/README.md` is kept as a compatibility entry that points to both. This file is current working guidance, not a dated design record.

## Boundary

Five workspace packages, not a derivable linear chain:

- **`@novalistically/core`** — pure narrative semantics: immutable source-snapshot analysis, entity/graph/state computation, context, render orchestration, validation, assembly intent. Depends only on `yaml` and `zod`. It does not hold project directories, Git, SQLite, credentials, or browser transports, and it does not write `scenes/`, `.nova/`, or derived files.
- **`@novalistically/node-host`** — Node adapters: filesystem source loader/writer, execution/state/cache/report repositories, AI SDK provider, plugin runtime. It is the filesystem boundary for CLI and Bench.
- **`@novalistically/bench`** — regression, variant, and performance benchmarks running through Core and Node Host. Never a Core dependency.
- **`@novalistically/cli`** — `commander` CLI and Host-bound MCP entry. Loads source snapshots at the Host boundary and injects runtime services; never brings filesystem/Git behavior back into Core.
- **`@novalistically/workbench`** — private native Host + browser client. Host owns local auth, Yjs, SQLite worker, credentials, ProjectSession, and controlled Git authoring; the browser consumes secret-free DTOs.

Core input is `ProjectSourceSnapshotV1` plus injected semantic ports; source hashes represent content, not Git history. Only Node Host and Workbench Host own files and authoring Git; Workbench commits only an explicit `AuthoringManifest` and never includes `.nova/**`, caches, responses, journals, Yjs, SQLite, output, or derived artifacts.

## Source Snapshot Topology

Standard Host loader path contract:

```text
nova.yaml
definitions/state_initial.yaml
definitions/entity-types.yaml
[optional] discourse-ledger.yaml
chapters/chapter_NN/[optional] _chapter.yaml
chapters/chapter_NN/E*.yaml
```

`state_initial.yaml` and `entity-types.yaml` are required loader inputs; discourse ledger and chapter metadata are optional. Event files are strict `EventFile` (`beats` with at least one non-empty entry); wire `Fact` and runtime `Fact` are different representations normalized by the mapper.

## Validators and Pass 2

- 28 built-in validators are registered in the default set; `GreyLineValidator` is exported but **opt-in**, not a default registration.
- Pass 2 static content schema has **20 fields** (14 required + 6 optional in the standalone schema). The `AnalysisResult` envelope is `eventId` / `protocol` / `observations` / `analysis`; parsing validates protocol, active fields, observations/payload pairing, and evidence.
- Pass 2 has no regex fallback. Feedback retries feed Zod errors back to the LLM; when attempts are exhausted the scene records an error and enters the review/release decision path.
- `compareFact()` is the single comparison entry (`'match' | 'mismatch' | 'deferred'`). `Fact.value` is optional; `Fact.narrativeHint` facts are consumed by Pass 2 and not written to WorldState.

## Commands

```bash
npm run build            # clean outputs + tsc -b types + esbuild JS bundles
npm test                 # vitest run + Workbench Host/Client suites
npm run typecheck        # tsc -b across all five packages
npm run typecheck:dead-code
npm run bundle-check
npm run lint             # biome check
npm run bench            # @novalistically/bench
```

For current test totals, lint diagnostics, and verified command results, read `docs/current-state.md`. Node is pinned `>=26.5.0 <27`; scripts run through `fnm`.

Run a single test: `npx vitest run packages/core/tests/validator/`. The core E2E suite (`packages/core/tests/e2e.test.ts`) runs through `MockProvider` and makes no network calls; it is included in the root `npm test`. Live-LLM runs are a separate command: `npm run smoke:stage1:live` (bench Stage-1 real-provider smoke, requires `NOVALISTICALLY_AI_API_KEY`).

## CLI

Host-bound commands: `project init`, `validate`, `status`, `entity`, `graph`, `source`, `render`, `revise`, and `render-tree`. The CLI does not read `.env` automatically. Workbench launch commands and environment configuration are documented in the root README; `start:listener` is the bare smoke listener, while `start:workbench` is the composed entry.

## Workbench startup

- `WORKBENCH_MODE=workbench` is the composed authenticated Workbench; missing/unknown mode fails closed. `WORKBENCH_MODE=listener` is a loopback health/status smoke process only.
- `packages/workbench/scripts/dev.mjs` runs the composed Host plus Vite proxy/HMR; `scripts/start.mjs workbench` runs the production Host, and `scripts/start.mjs listener` is the smoke entry.
- Node launchers load dotenv from `WORKBENCH_ENV_FILE`, then the working-directory `.env`, then the monorepo-root `.env`; existing shell variables are never overridden. Production requires explicit project root, SQLite path, built asset root, and `NOVALISTICALLY_AI_API_KEY`; the dev script (`dev.mjs`) alone defaults an unset project root to `fixtures/zhu-fu`, the provider to mock, and loopback bootstrap to enabled — production (`start.mjs workbench`) forces `WORKBENCH_DEV=false` and never applies those defaults. An explicitly set but invalid `WORKBENCH_PROJECT_ROOT` is a hard error in both modes.
- Static SPA fallback is restricted to unknown browser GET paths. `/api/**`, `/health`, `/status`, `/mcp`, and `/yjs` must never receive `index.html`.

## Agent prompts and durable memory

- `agents/` holds role-specific prompt contracts, not implementation authority. Core never reads these paths: runtime Pass 1 templates arrive as `pass1` text through `PromptTemplateCatalog`. `PromptAssembler` parses `## System Prompt` and `## Instructions`, emits a fixed system message, and injects only parsed `## Instructions` into the Pass 1 user prompt; keep operational constraints under `## Instructions`. `agents/scribe/prompt.md` is the prose-only reference contract; it must never emit analysis, state mutations, metadata, or release decisions.
- Put durable repository invariants, package boundaries, source topology, and command rules here. Put verified but time-sensitive implementation status in `docs/current-state.md`.
- Do not copy volatile test totals, work-in-progress status, or historical design claims into prompt files. Revisit affected prompt contracts whenever a rendering or prompt boundary changes.
- `packages/core/src/agent/` and `packages/workbench/src/host/agent/` are implementation directories, not prompt-reference directories.

## Docs

- `docs/current-state.md` — source-verified baseline (authoritative).
- `docs/INDEX.md` — document index.
- `docs/README.md` — compatibility entry pointing to current-state/INDEX.
- `docs/architecture.md`, `docs/reference/` — current reference pages.
- `docs/archive/` — historical records; keep their dates and evidence, link to current-state, do not rewrite them.

## Fixtures

Per-project YAML projects live in `fixtures/` (e.g. `zhu-fu` 祝福, `dream-of-red-chamber`, `most-dangerous-game`, `arcane-aftermath`, `zhu-fu-variants`, `game-dialogue-tree`, `workbench-authoring`). Do not reuse old stage/corpus event counts as current state; see `docs/current-state.md`.

## Gotchas

- `.env` is gitignored; `.env.example` has the template. The CLI does not auto-load `.env`.
- `allowImportingTsExtensions` is set — source imports use `.ts`; esbuild handles bundling.
- When adding types/schemas, export from `types/index.ts` and `schemas/index.ts` barrels.
- Rebuild (`npm run build`) before exercising CLI/dist consumers.
- `Fact.value` is optional — check for `undefined` before comparing; use `compareFact()`.
- `Fact.narrativeHint` facts are not written to WorldState (skipped in replay).
- Mock providers (`MockProvider`, `MockPass2Provider`) are test fixtures, not live-LLM evidence.
- Do not promote design-only or unverified capabilities as runtime guarantees.
