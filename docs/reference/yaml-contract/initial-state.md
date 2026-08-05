# World Initial State YAML Contract

**Current source:** `schemas/state-initial.ts`, `schemas/thread.ts`, `schemas/knowledge.ts`, `entity/project-runtime.ts`, and `state/narrative-baseline.ts`.

`definitions/state_initial.yaml` is a required, strict source document. It describes the world before the first authored event. It does not create a synthetic genesis event: canonical compilation materializes declaration-owned narrative state, then applies initial entity facts before replaying authored events.

## Required top-level fields

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `info` | `{ currentEra, politicalSituation }` | yes | Historical and political prose context. |
| `timeAnchors` | `TimeAnchor[]` | no | Named, locatable story-time references. |
| `threads` | `ThreadDeclaration[]` | yes | Initial narrative-thread declarations. |
| `knowledge` | `{ claims, commonGround }` | yes | Initial epistemic ledger and common-ground declarations. |
| `worldFacts` | `{ id, value, description }[]` | yes | Initial concept facts. |

Unknown top-level and nested keys fail strict schema validation.

## Thread declarations

Every `threads[]` item is a `ThreadDeclaration` and must use the required canonical identifiers:

| Field | Required | Notes |
|---|---:|---|
| `threadId` | yes | Nonblank unique identifier, used by event `threadProgress`. |
| `name` | yes | Nonblank author-facing name. |
| `description` | yes | Nonblank author-facing description. |
| `typeId` | yes | Nonblank key in `definitions/thread-types.yaml`. |
| `initialPhase` | no | Initial phase; otherwise the type's first allowed phase is used. |
| `initialBindings` | no | Initial string bindings. |
| `initialGoalStates` | no | Declaration overrides for type stable goals. |
| `initialMilestoneStates` | no | Declaration overrides for type stable milestones. |
| `provenance` | no | Nonblank source/provenance text. |
| `targetRevealChapter` | no | Nonnegative author metadata. |
| `initialProgress` | no | Nonblank author metadata. |
| `structuralFunction` | no | Propp structural-function enum. |

The thread type catalog supplies allowed phases, lifecycle policy, story/discourse domain, and stable goal/milestone defaults. See [Thread YAML Contract](./thread.md).

## Initial knowledge

`knowledge` is required even when no initial epistemic facts exist:

```yaml
knowledge:
  claims: []
  commonGround: []
```

A claim declaration has `subject`, `propositionId`, `assessment`, and `evidence`. A common-ground declaration has `propositionId`, `participants`, `establishedAt`, and optional `establishedBy`. The proposition catalog lives in the required `definitions/propositions.yaml`; see [Knowledge YAML Contract](./knowledge.md).

## Time anchors

`timeAnchors[].at` accepts the locatable authored timestamp forms: a compact nonblank string, `{ at }`, `{ after }`, `{ offset }`, or `{ chapter }`. Anchors cannot use intentional indeterminacy. Anchor IDs must be nonblank and may not conflict with event IDs; resolved anchor coordinates drive story-time graph compilation.

## Valid example

```yaml
info:
  currentEra: Post-imperial countryside
  politicalSituation: Local clan authority remains decisive.

timeAnchors:
  - id: story_origin
    at: day_0
    description: Opening state

threads:
  - threadId: T1
    name: Main conflict
    description: The protagonist confronts the clan's authority.
    typeId: primary
    initialPhase: setup
    targetRevealChapter: 3
    initialProgress: drafted

knowledge:
  claims: []
  commonGround: []

worldFacts:
  - id: clan_authority
    value: The clan governs local ritual participation.
    description: Initial social constraint.
```

## Baseline materialization

`materializeNarrativeBaseline()` is the sole constructor for declaration-owned narrative domains. Before the first event it:

- initializes each declared thread with `status: planned`, run ID `init-<threadId>`, its initial or type-default phase, bindings, and stable/declaration goal and milestone states;
- clones `definitions/propositions.yaml`, materializes initial claims into the epistemic ledger, and materializes initial common ground;
- materializes every declared relationship and rule from their declarations; and
- leaves entity facts to the initial-fact application path.

`worldFacts` become initial concept declarations and initial entity facts. They are baseline inputs, not authored events. Event files then replay on this canonical baseline.

## Diagnostics

The loader reports the first strict-schema failure as `ConfigError` with the logical file path and Zod dot-path. Cross-catalog failures such as an unknown `threads[].typeId` occur during canonical mapping before graph compilation or rendering.
