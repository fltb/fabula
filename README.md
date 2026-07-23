# Novalis

> Narrative engineering: structured YAML → Event Sourcing state → two-pass LLM → assembled novel.
>
> 让 LLM 负责创造，让系统负责稳定。

Novalis is a novel-writing engine that treats fiction as an engineering object. You define characters, world rules, and events in YAML; the engine maintains state via event sourcing, compiles minimal context for each scene, renders prose through a two-pass LLM pipeline, validates output against 18+ structured validators, and assembles the final novel.

## Core Concepts

- **Novel IR** — a multi-layer intermediate representation (Idea → Story → Scene → Event → World State → Text), analogous to LLVM IR for programming languages.
- **Story / Discourse separation** — *Story* (what happened, causal DAG) vs *Discourse* (how it's told, render order). Like React's Virtual DOM vs Render.
- **Event Sourcing + Snapshots** — every narrative event is an immutable record; state is derived by replay. Supports branching, rollback, and DAG-based causal ordering.
- **Two-pass rendering** — Pass 1 generates prose (temp 0.8); Pass 2 produces structured analysis JSON (temp 0.3, seed 42) for post-render validation.
- **Layered validation** — deterministic facts checked via `compareFact()`; semantic dimensions checked via Pass 2 analysis; author intent carried through `narrativeChecklist` prompt passthrough.

## Architecture

```
YAML Definitions
    ↓
EntityMapper → EntityRegistry
    ↓
StateManager (Event Sourcing + Snapshots + DAG causal edges)
    ↓
ContextCompiler (5-layer priority, 8-dim relevance scoring)
    ↓
RenderPipeline (Pass 1: prose → Pass 2: structured analysis)
    ↓
PostRenderValidation (18+ validators consuming Pass 2 analysis)
    ↓
Assembler → output/novel.md
```

## Quick Start

```bash
npm install
npm run build        # tsc -b (types) + esbuild (JS bundle)
npm test             # vitest run (all packages)
npm run bench        # bench: functional + performance
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
```

Exclude e2e (needs live LLM proxy):
```bash
npx vitest run --exclude '**/e2e.test.ts'
```

## Monorepo Layout

| Package | Role | Key Dependencies |
|---------|------|-------------------|
| `packages/core` | Engine: types, state, validators, pipeline | yaml, zod, better-sqlite3 |
| `packages/cli` | CLI + MCP server | commander, core |
| `packages/bench` | Benchmarks + regression suite | tinybench, core |

Build order: `core → cli` (and `bench` if needed).

## Fixtures

| Fixture | Description |
|---------|-------------|
| `fixtures/zhu-fu/` | 祝福 (Lu Xun) — 7 events, Chinese, full reference data |
| `fixtures/dream-of-red-chamber/` | 红楼梦 — 12 sampled events, 40 characters, 8 locations |
| `fixtures/most-dangerous-game/` | 6 scenes, 3 chapters, branch point |
| `fixtures/arcane-aftermath/` | 2 events, test project |
| `fixtures/zhu-fu-variants/` | Error injection + extreme damage variants |

## Documentation

- [Document index](docs/README.md)
- [Architecture](docs/archive/PROJECT.md) — original system design
- [Stage-2 audit](docs/audits/stage-2-corpus-audit.md) — capability boundary analysis
- [Active TODO](docs/TODO.md) — current work surface

## Status

Stage 2 partial acceptance. Core engine (~28K lines) implements Event Sourcing, 18+ validators, two-pass rendering, context compiler, and assembler. Upper IR layers (Idea/Story/Scene) and Discovery Layer are designed but not yet built. See `docs/TODO.md` for the active work surface.

## License

MIT
