# L2 Benchmark Flow

## Overview

The L2 (post-render validation) benchmark validates the semantic correctness of LLM-generated prose by running post-render validators against pre-generated reference data. It intentionally **decouples reference generation from benchmark execution** to achieve speed, determinism, and cost control.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    TWO-PHASE ARCHITECTURE                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Phase 1: Generate Reference Data (one-time, real LLM)           │
│  ─────────────────────────────────────────────────────────────   │
│                                                                  │
│  generate-reference.mjs                                          │
│    ├── EntityMapper (load fixture YAML)                          │
│    ├── ReplayEngine (build per-event state)                      │
│    ├── RenderPipeline (AiSdkProvider)                            │
│    │   ├── Pass 1: prose generation  (temp 0.8)                 │
│    │   └── Pass 2: analysis JSON    (temp 0.3, seed 42)         │
│    └── Save to reference/data/{eventId}.json                     │
│         ├── prose: string                                        │
│         ├── analysis: AnalysisResult (12 blocks)                 │
│         └── _metadata: generation info                           │
│                                                                  │
│  Phase 2: Run Bench (repeatable, no LLM)                         │
│  ────────────────────────────────────────────────────────────    │
│                                                                  │
│  regression.ts (runRegressionBench → "L2" stage)                 │
│    ├── Load reference/data/*.json                                │
│    ├── Load fixture events + state (via mapper + replay)         │
│    ├── For each reference entry with analysis:                   │
│    │   └── ResultAggregator.validateRender(prose, event,         │
│    │       state, analysis)                                      │
│    └── Collect L2 validation issues                              │
│                                                                  │
│  Tests (LLM-free)                                                │
│  ───────────────────────────────────────────                     │
│                                                                  │
│  Test files use MockPass2Provider with inline entries             │
│  └── No real LLM, no reference files needed                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Why This Separation

### Phase 1: Reference Generation (Real LLM)

- **One-time cost**: Generate once per pipeline change, reuse for many bench runs
- **Full pipeline**: Tests the actual `RenderPipeline` with `AiSdkProvider` — validates that Pass 1 prose + Pass 2 analysis work end-to-end
- **Ground truth capture**: The output (prose + analysis) becomes the reference data itself — no separate oracle needed
- **12-block analysis**: All 18 validators' semantic inputs are captured in the 12-block AnalysisResult JSON

### Phase 2: Bench Execution (No LLM)

- **Fast**: Sub-second L2 stage (microseconds per entry, no network I/O)
- **Deterministic**: Same reference → same issues → same pass/fail. No flaky tests from LLM variance
- **Cost-free**: Zero API calls during CI or local development
- **Reproducible**: Pin a specific reference data set for a given pipeline version
- **Isolated debugging**: If L2 validation fails, the issue is in the validator logic or reference data — not in LLM output variance

## The Reference Data

The render results from Phase 1 **are** the reference data. Each entry contains:

| Field | Source | Purpose |
|---|---|---|
| `prose` | Pass 1 output | Input to post-render validators |
| `analysis` | Pass 2 output | Contains structured analysis consumed by validators (narrativeChecks, appearanceChecks, tenseDetected, conflictAnalysis, etc.) |
| `_metadata` | Generation info | Tracks eventId, cache status, errors |

Reference files are stored in `fixtures/{project}/reference/data/{eventId}.json` per the `MockPass2Entry` format.

## How To Regenerate Reference Data

After pipeline changes that affect Pass 2 output format or validator logic:

```bash
# 1. Remove old reference data
rm -rf fixtures/zhu-fu/reference/data/

# 2. Ensure .env has valid API key
#    NOVALISTICALLY_AI_API_KEY=sk-...

# 3. Regenerate (takes ~2-5 minutes depending on event count)
node packages/bench/scripts/generate-reference.mjs zhu-fu

# 4. Update snapshots or expected values if validators changed
npx vitest run --exclude '**/e2e.test.ts'
```

**When to regenerate:**

| Change | Regenerate? | Reason |
|---|---|---|
| New validator added | ✅ Yes | Need new analysis fields |
| Pass 2 analysis blocks changed | ✅ Yes | Format/field changes |
| Model/provider changed | ✅ Yes | Different prose style |
| Validator logic changed | ⚠️ Maybe | Existing reference may still be valid |
| Typo fix in fixture YAML | ⚠️ Maybe | Only if it changes state/replay |
| Bench infrastructure change | ❌ No | Reference data unchanged |

## How Tests Use L2 (No LLM)

Unit and integration tests use `MockPass2Provider` with **inline entries** constructed via helper functions:

```ts
import { MockPass2Provider } from '@novalistically/core';
import { makeAnalysisResult } from '...test-helpers';

const entry = makeAnalysisResult('E1', {
  narrativeChecks: [{ entityId: 'xianglins_wife', ... }],
});

const provider = new MockPass2Provider({
  entries: { E1: entry },
});
```

This approach is:

- **Fully self-contained**: No filesystem or reference data dependencies
- **Explicit**: Each test declares exactly what analysis data it expects
- **Fast**: Microsecond initialization, zero I/O
- **Deterministic**: Same run every time, no network dependency

The `MockPass2Provider` also supports a `referenceDir` option for loading reference files from disk when needed (e.g., in integration tests), but the default test pattern uses inline entries.

## Comparison: Old Approach vs. Current

| Aspect | Old (regex-based) | Current (Pass 2 analysis) |
|---|---|---|
| Validation strategy | Regex scan prose output | Consume structured AnalysisResult JSON |
| Determinism | Flaky (prose varies) | Deterministic (analysis structure fixed) |
| LLM required | Every test run | One-time generation only |
| Validator complexity | Simple string matching | Full semantic checks (12 analysis blocks) |
| Test speed | Slow (LLM calls) | Fast (no LLM) |
| Cost | Per-run API costs | Zero after generation |
| Pass 2 unavailability | Fallback to regex | Hard error |
