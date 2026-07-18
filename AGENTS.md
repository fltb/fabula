# Novalistically — AGENTS.md

## What This Is

Narrative engineering system: structured YAML definitions → Event Sourcing state → extended Pass 2 analysis (12 blocks) → 18 Validators → Context Compiler → LLM prose → PostRenderValidation → assembled novel. Quality is controlled at the **output level**: Pass 2 produces structured self-analysis JSON, validators consume Pass 2 analysis (not regex prose scanning) for semantic checks, and `compareFact()` handles deterministic checks.

### Status (2026-07-17)

P0 active: bench-rewrite project. Full specification at `docs/bench-rewrite-full.md` (~1300 lines). Design index at `docs/bench-rewrite-design.md`. Document index at `docs/README.md`.

**Key recent design decisions (captured in bench-rewrite spec):**
- Pass 2 AnalysisResult extended to 12 blocks (5 new: narrativeChecks, appearanceChecks, characterReferences, tenseDetected, conflictAnalysis)
- `Fact.value` is now optional; `narrativeHint` added for semantic attributes consumed by Pass 2, not deterministic comparison
- `compareFact()` is the single unified comparison function — all validators use it
- DAG causal edges drive StateManager replay (topological sort), not narrativeOrder
- Pass 2 uses temperature 0.3, seed 42, retry-with-feedback (Zod errors → LLM correction)
- Placeholder values (`changed`, `resolved`, `updated`, etc.) rejected at Zod schema level
- Pass 2 unavailable = hard error (not a regex fallback)
- 7 new validators being added (Pacing, TenseConsistency, DiscourseBalance, Alias, Pronoun, Appearance, Conflict) — all consume Pass 2 analysis
- 13 new computational fields being added to types

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
| `packages/bench` | Benchmarks (calls core) — being rewritten per bench-rewrite spec | `src/index.ts` | tinybench, @novalistically/core |

Build order always: `core → cli` (and bench if needed). Types via `tsc -b`, JS via esbuild.

## Architecture

```
Discovery (YAML loader) → Core Engine → Review (validators)
```

**Core Engine pipeline:** EntityMapper → StateManager (Event Sourcing + Snapshots + DAG causal edges) → ContextCompiler (5-layer priority, 8-dim scoring) → RenderPipeline (two-pass LLM + cache + parallelism) → Assembler

**Pass 2 analysis JSON (12 blocks):**
- Existing: postconditions, preconditions, pov, inventedDetails, quality, threadProgressAchieved, foreshadowingDeployed
- New: narrativeChecks (matchLevel: exact/similar/absent/contradicted), appearanceChecks (same), characterReferences (namesUsed[] only — no pronounCount/dialogueLines), tenseDetected, conflictAnalysis
- Three-tier output: L1 json_schema (OpenAI/Anthropic) → L2 json_object (DeepSeek) → L3 prompt only
- Retry: Zod validation errors fed back to LLM for correction (Instructor pattern, not blind retry)
- Dev-only repeated output verification: run twice at temp 0.3 + seed 42, compare JSON

**RenderPipeline outputs:**
- `scenes/{eventId}.md` — prose
- `scenes/{eventId}.yaml` — metadata
- `scenes/{eventId}_render_request.yaml` — context sent to LLM
- `.nova/responses/{eventId}.json` — full raw LLM response
- `.nova/derived/{threads,foreshadowing,relationships,rules}.yaml`
- `.nova/render-cache/` — hash-chain cache

## Key Design Decisions

1. **Validators check OUTPUT, not input.** 18 validators run on LLM output. Deterministic facts use `compareFact()`; semantic facts use Pass 2 analysis (narrativeChecks, appearanceChecks). No regex prose scanning for new validators.
2. **Two-pass rendering.** Pass 1: pure prose (temp 0.8). Pass 2: structured analysis JSON (temp 0.3, seed 42).
3. **Fact dual representation.** `value?` for deterministic comparison (boolean, enum, simple string). `narrativeHint?` for semantic attributes — fed to Pass 2, not written to WorldState. Both mutually exclusive per Zod.
4. **compareFact() is the single comparison entry.** Returns `'match' | 'mismatch' | 'deferred'`. All validators use it. No ad-hoc comparison strategies.
5. **DAG causal edges for time model.** StateManager replays via topological sort on causal edges (postcondition→precondition matches), not narrativeOrder. narrativeOrder is Assembler-only (discourse order).
6. **Cache is a hash chain.** Event N's cache key = SHA256(defs hash + event_1_hash + ... + event_N_hash). Any change to any prior event or definition invalidates all downstream caches.
7. **Scene granularity.** A scene = continuous time + single location + consistent cast + one dramatic unit (merge 2-3 beats). System default 400 words (overridable per-project, per-scene).
8. **Event Sourcing + Snapshot.** StateManager stores every event; snapshots at `snapshot_interval`. Replay from nearest snapshot.
9. **Concurrency pool.** RenderPipeline uses bounded parallelism (default 5).
10. **Pass 2 = hard requirement.** Pass 2 unavailability is a hard error — no regex fallback. Mock provider in tests → mark `skip: 'no_pass2'`.

## Docs

| File | Purpose |
|---|---|
| `docs/README.md` | Document index |
| `docs/bench-rewrite-design.md` | Current bench rewrite design overview |
| `docs/bench-rewrite-full.md` | Full spec (~1300 lines) — implementation reference |
| `docs/PROJECT.md` | ⚠️ Historical — original system design|
| `docs/IMPLEMENTATION.md` | ⚠️ Historical — old development roadmap |
| `docs/prompts/pass1-prose-reference.md` | Pass 1 prompt template reference |

## Fixtures

- `fixtures/most-dangerous-game/` — 6 scenes, 3 chapters, branch point at E2 (English)
- `fixtures/arcane-aftermath/` — test project with 13 YAML files (Chinese, 2 events)
- `fixtures/zhu-fu/` — 祝福 regression test (coming in bench-rewrite P1)
- `fixtures/zhu-fu-variants/` — variant tests: branch, error injection, extreme damage (P1)

## Active Implementation (bench-rewrite)

See `docs/bench-rewrite-full.md` for the full 10-phase plan (~10500 lines + ~50 YAML).

**First three phases (P0-tier1/2/3):**
- 13 new computational fields (types + schemas + mapper)
- Scene definition lock + C1-C4 fixes
- Genre bug fix (assembler.ts:62 hardcoded 'fantasy')
- Placeholder value removal (Zod rejection)
- Fact dual representation + compareFact()
- narrationTime full implementation
- role→importance activation (RelevanceEngine)
- DAG causal edges + StateManager topological sort
- Pass 2 AnalysisResult extension (12 blocks total)

## Testing Quirks

- LLM tests (`**/e2e.test.ts`) depend on running `opencode-go` proxy at `http://127.0.0.1:25793` and a valid API key in `.env`; skip these on CI
- Entity tests load YAML files from `fixtures/` directories — must have valid paths when running from root
- Integration tests assume fixture files exist (not generated)
- Bench tests run tinybench in-process (may be slow with 1000-event N)
- Some tests parse prose output — content-sensitive tests should use the MockProvider, not live LLM
- Pass 2 is a hard requirement; Mock provider does NOT support Pass 2 analysis → tests needing Pass 2 must be marked `skip: 'no_pass2'`

## Gotchas

- `.env` is gitignored; `.env.example` has the template.
- `allowImportingTsExtensions` is set — imports use `.ts` in source, esbuild handles bundling.
- Storage abstraction (`FsStorage`, `MemoryStorage`) wraps all file I/O — don't use `fs` directly in core modules.
- `better-sqlite3` is a core dependency but not yet used.
- esbuild bundles each package independently; the `external` list avoids bundling node:* and workspace deps.
- When adding new types/schemas, export from `types/index.ts` and `schemas/index.ts` barrels.
- Always rebuild `packages/core/dist/` before running CLI or `node build.mjs` in package dir.
- The `snip` wrapper is a shell tool output helper — not part of the project.
- `Fact.value` is now `value?` — must check for `undefined` before comparison. Use `compareFact()`.
- `Fact.narrativeHint` facts are NOT written to WorldState — skipped in replay.ts.
- Placeholder values like `"changed"`, `"resolved"` are rejected by Zod schema — do not use them in YAML.
- genre is currently hardcoded to 'fantasy' in `assembler.ts:62` — fix in P0d.
- `narrationTime` is declared in `NarrativeEvent` but NOT in `EventFile`/schema/mapper — being fixed in P0c.
- TimelineValidator creates empty `timeAnchors` Map — all RelativeTimestamp resolve to 0. Being fixed in P0b.
