# Novalistically — AGENTS.md

## What This Is

Narrative engineering system: structured YAML definitions → Event Sourcing state → 11 Validators → Context Compiler → LLM prose generation → PostRenderValidation → assembled novel. Quality is controlled at the **output level** (validateRender on prose) not the input level (YAML is assumed valid after schema check).

## Commands

```bash
npm run build            # tsc -b (types) + esbuild (JS bundle)
npm test                 # vitest run (all packages)
npm run bench            # @novalistically/bench functional + perf
npm run typecheck        # tsc --noEmit
npm run lint             # biome check
```

Exclude e2e (needs LLM): `npx vitest run --exclude '**/e2e.test.ts'`
Run single test: `npx vitest run packages/core/tests/validator/`

## Monorepo Layout

| Package | Role | Entry | Dependencies |
|---|---|---|---|
| `packages/core` | Engine (all types, state, validators, pipeline) | `src/index.ts` → dist/ | yaml, zod, better-sqlite3 |
| `packages/cli` | CLI + MCP server | `src/index.ts`, `src/mcp-server.ts` | commander, @novalistically/core |
| `packages/bench` | Tinybench benchmarks (calls core) | `src/index.ts` | tinybench, @novalistically/core |

Build order always: `core → cli` (and bench if needed). Types via `tsc -b`, JS via esbuild.

## Architecture (Three-Layer)

```
Discovery (YAML loader) → Core Engine → Review (validators)
```

**Core Engine pipeline:** EntityMapper → StateManager (Event Sourcing + Snapshots) → ContextCompiler (5-layer priority, 8-dim scoring) → RenderPipeline (two-pass LLM + cache + parallelism) → Assembler

**RenderPipeline outputs:**
- `scenes/{eventId}.md` — prose
- `scenes/{eventId}.yaml` — metadata (prose_source, edit_history, model_used, word_count)
- `scenes/{eventId}_render_request.yaml` — context sent to LLM
- `.nova/responses/{eventId}.json` — full raw LLM response
- `.nova/derived/{threads,foreshadowing,relationships,rules}.yaml`
- `.nova/render-cache/` — hash-chain cache (invalidated when any prior event or def changes)

## Key Design Decisions

1. **Validators check OUTPUT, not input.** The 11 validators + PostRenderValidator run `validateRender(prose, event, state)` on LLM output. The old `validate(event, context)` checks YAML input only for schema issues.
2. **Two-pass rendering.** Pass 1: pure prose via `buildProsePrompt`. Pass 2: prose+context back to LLM for structured analysis via `buildAnalysisPrompt`.
3. **Cache is a hash chain.** Event N's cache key = SHA256(defs hash + event_1_hash + ... + event_N_hash). Any change to any prior event or definition invalidates all downstream caches.
4. **Scene granularity.** A scene = continuous time + single location + consistent cast + one dramatic unit (beat). Target 300-800 words per scene. Don't give the LLM single beats — merge 2-3 beats per scene.
5. **Event Sourcing + Snapshot.** StateManager stores every event; snapshots at `snapshot_interval` (configurable). Replay from nearest snapshot.
6. **Concurrency pool.** RenderPipeline uses bounded parallelism (default 5) for scene rendering.

## Fixtures

- `fixtures/most-dangerous-game/` — 6 scenes (merged from 13 beats), 3 chapters, branch point at E2
- `fixtures/arcane-aftermath/` — test project with 13 YAML files
- `fixtures/benchmark-novel/` — used by @novalistically/bench

## What's Built

✅ Types (40+ interfaces), Zod schemas, EntityMapper, StateManager, Cache
✅ ContextCompiler (8 dimensions, 5 priority layers), Assembler
✅ 11 Validators + PostRenderValidator (all with validateRender) + ResultAggregator
✅ RenderPipeline (two-pass, parallel, cache, maxTokens=10000)
✅ CLI (init, validate, status, assemble, render, diff, commit, entity, bench)
✅ MCP Server (7 tools + generateNextActions + generateGuidance)
✅ Plugin system (ValidatorRegistry, conflict resolution, swear-filter example)
✅ Branch system (BranchPath, BranchSet, replay filter)
✅ Review system (pending/resolve/escalate/wontfix lifecycle)
✅ ISS (6 dimensions + anti-pattern detection + strict mode)
✅ LlmProvider interface (Mock, OpencodeGo, OpencodeZen)
✅ Knowledge/Relationship first-class entity types
✅ Prompt reference templates (docs/prompts/pass1-prose-reference.md)
✅ E2E integration test, AI provider tests, all unit tests (490+)

## What's Pending (PROJECT.md gaps)

| Priority | Gap | Notes |
|---|---|---|
| P1 | Event `narration_time` field | Non-linear narrative support |
| P1 | Plugin runtime conflict resolution | Priority system + arbitration |
| P2 | Branch points YAML format | `branches/branch_points.yaml` |
| P2 | `PROJECT_STATUS.md` auto-generation | From ISS + render + validation |
| P2 | Reverse validation pipeline | Degraded scene repair |
| P2 | Circuit breaker | 3-round writer→validator escalation |

## Testing Quirks

- LLM tests (`**/e2e.test.ts`) depend on running `opencode-go` proxy at `http://127.0.0.1:25793` and a valid API key in `.env`; skip these on CI
- Entity tests load YAML files from `fixtures/` directories — must have valid paths when running from root
- Integration tests assume fixture files exist (not generated)
- Bench tests run tinybench in-process (may be slow with 1000-event N)
- Some tests parse prose output — content-sensitive tests should use the MockProvider, not live LLM

## Gotchas

- `.env` is gitignored; `.env.example` has the template. The opencode-go key is `ocg-6f87c1b4-38c9158a` (hardcoded fallback in render scripts).
- `allowImportingTsExtensions` is set — imports use `.ts` in source, esbuild handles bundling.
- Storage abstraction (`FsStorage`, `MemoryStorage`) wraps all file I/O — don't use `fs` directly in core modules.
- `better-sqlite3` is a core dependency but not yet used — SQLite integration is for index/database queries.
- esbuild bundles each package independently; the `external` list avoids bundling node:* and workspace deps.
- When adding new types/schemas, export from `types/index.ts` and `schemas/index.ts` barrels.
- Always rebuild `packages/core/dist/` before running CLI or render scripts (`node build.mjs` in package dir).
- The `snip` wrapper is a shell helper in the shell tool output — not part of the project.
