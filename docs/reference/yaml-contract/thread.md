# Thread YAML Contract

**Current source:** `schemas/state-initial.ts`, `schemas/thread.ts`, `entity/mapper.ts`, `state/narrative-baseline.ts`, and `state/thread-replay.ts`.

## Required source topology

```text
definitions/thread-types.yaml
definitions/state_initial.yaml   # threads[] declarations
chapters/chapter_NN/E*.yaml      # scalar threadProgress[]
```

`thread-types.yaml` is a required strict document:

```yaml
types:
  primary:
    typeId: primary
    description: Long-running plot thread
    allowedPhases: [setup, development, resolution]
    lifecyclePolicy: { reopenPolicy: forbidden }
    timeDomain: story
    stableGoals: [{ goalId: resolution, status: pending }]
    stableMilestones: []
```

Each `state_initial.yaml.threads[]` entry is a `ThreadDeclaration`:

```yaml
threads:
  - threadId: T1
    name: Main plot
    description: The central conflict
    typeId: primary
    initialPhase: setup             # optional
    initialBindings: { protagonist: hero } # optional
    initialGoalStates: []           # optional overrides
    initialMilestoneStates: []      # optional overrides
    targetRevealChapter: 3          # retained author metadata
    initialProgress: drafted        # retained author metadata
```

Map keys in the type catalog must equal `typeId`; declarations must reference a known type. Duplicate declaration, phase, goal, and milestone IDs, invalid initial states, and unknown types fail during canonical mapping with `ConfigError`.

## Event wire and normalized transaction

Normal event YAML remains scalar and source-friendly:

```yaml
threadProgress:
  - thread: T1
    advancement: The hero accepts the quest.
    progressAfter: 25
    progressTotal: 100
```

The mapper is the only normalization boundary. It turns every scalar entry into a `ThreadTransaction` with deterministic `runId`, source event provenance, the declared type's initial phase, and declared goals set to `active` or `achieved`. An unknown thread or duplicate write for one thread in an event fails mapping. Runtime replay consumes only normalized transactions.

## Runtime materialization

`materializeNarrativeBaseline()` creates one `ThreadRuntimeState` for every declaration before the first event. It uses the type's first allowed phase, stable goals/milestones, and declaration overrides; the initial run is `init-<threadId>`. Canonical render boundaries and `compileCanonicalRuntime()` receive this baseline, and `ContextCompiler` receives declarations so it renders the authored thread name and description rather than an ID fallback.

`timeDomain` is explicit catalog metadata. Normal EventFile progress participates in story replay; a separate discourse-domain transaction surface is not authored by EventFile.

## Runtime transaction shape

```ts
interface ThreadTransaction {
  thread: string;
  runId: string;
  status?: 'planned' | 'active' | 'blocked' | 'completed' | 'abandoned' | 'retired';
  phase?: string;
  bindingsAfter?: Record<string, string>;
  goalSet?: Array<{ goalId: string; status: GoalLifecycle }>;
  milestoneSet?: Array<{ milestoneId: string; status: MilestoneLifecycle }>;
  provenance: string;
  advancement?: string;
}
```

Transactions are internal runtime values; do not place this shape in ordinary event YAML. Corpus ellipsis has its own explicit transaction schema.

## Error form

The YAML boundary reports the first strict-schema error as `ConfigError` with the logical path plus Zod dot-path. Cross-catalog declaration errors and invalid scalar-progress normalization also fail before graph compilation or rendering.
