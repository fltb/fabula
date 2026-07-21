# Stage 1.5 — TODO Index (grouped)

Stage 1.5 eliminates all architecture + engineering TODOs from `docs/TODO.md`
to prepare for Stage 2 academic-grade verification. The 33 original TODOs are
grouped into 8 sub-plans by domain; each sub-plan file tracks per-item status
internally. The group row flips `[ ]` → `[x]` when every item inside the
group file is `[x]` with passing evidence.

## Group sub-plans (8)

| Group | Status | Deps | Sub-plan | Items | Count |
|-------|--------|------|----------|-------|-------|
| state-model | [x] | — | [state-model.md](state-model.md) — 6/6 items done | STATE-1, STATE-2, STATE-3, STATE-4, STATE-5, STATE-6 | 6 |
| dag-replay | [-] | state-model | [dag-replay.md](dag-replay.md) — DAG-0/1/2/3/4 [x], DAG-5 remains (5a/5b/5c) | DAG-0, DAG-1, DAG-2, DAG-3, DAG-4, DAG-5 | 6 |
| graph-discourse-render | [ ] | state-model, dag-replay | [graph-discourse-render.md](graph-discourse-render.md) | GRAPH-1, DISCOURSE-1, RENDER-SURFACE-1 | 3 |
| integration | [ ] | state-model, dag-replay | [integration.md](integration.md) | INTEGRATION-1, INTEGRATION-2 | 2 |
| capability-contract | [ ] | state-model, dag-replay, graph-discourse-render, integration | [capability-contract.md](capability-contract.md) | CAPABILITY-1, YAML-CONTRACT | 2 |
| api-core-validator | [x] | — | [api-core-validator.md](api-core-validator.md) — 7/7 items done | API-1, API-2, API-3, API-4, API-5, AGG-1, CORE-API-1 | 7 |
| cli-storage | [-] | api-core-validator | [cli-storage.md](cli-storage.md) — CLI-5 [x], 3 items remain | CLI-3, CLI-4, CLI-5, STORAGE-2 | 4 |
| documentation | [ ] | graph-discourse-render, capability-contract | [documentation.md](documentation.md) | DOC-1, DOC-2, DOC-3 | 3 |

**Total: 33 TODOs across 8 group sub-plans.**

## Execution waves

Waves define the order in which group sub-plans may be authored and executed.
A group may start when all groups in its Deps column are `[x]`. Within a
group, items have their own internal order documented in the group file.

- **Wave 1 (no group deps):** state-model, api-core-validator
- **Wave 2 (deps on Wave 1):** dag-replay (needs state-model), cli-storage (needs api-core-validator)
- **Wave 3 (deps on Wave 2):** graph-discourse-render, integration (both need state-model + dag-replay)
- **Wave 4 (deps on Wave 3):** capability-contract (needs all architecture groups), documentation partial — DOC-2 needs graph-discourse-render
- **Wave 5 (deps on Wave 4):** documentation — DOC-1 needs capability-contract (YAML-CONTRACT)

Note: DOC-3 inside `documentation` has no deps and may be authored/executed
in Wave 1, but the `documentation` group row only flips to `[x]` when all
three DOC items are `[x]`. The group file documents this internal partial
eligibility.

Stage 1.5 is complete when every group row above is `[x]` (equivalently,
all 33 items across all group files are `[x]`).

## Group sub-plan file template

Each `docs/todos/<group-slug>.md` must follow this shape:

    # <GROUP-SLUG>: <Group Title>

    ## Group Status: [ ] unstarted | [-] in progress | [x] complete

    ## Items in this group

    | Item ID | Status | Internal Deps | Source |
    |---------|--------|---------------|--------|
    | <ID-1> | [ ] | — | `docs/TODO.md` lines <N>-<M> |
    | <ID-2> | [ ] | <ID-1> | `docs/TODO.md` lines <N>-<M> |
    | ... |

    ## Group-level dependencies
    List of group slugs that must be `[x]` before items in this group start.
    If only some items have cross-group deps, list them per item here.
    If none, write "None".

    ## Sub-plan
    The decision-complete execution spec for every item in this group. Same
    shape as a normal OMP plan Approach section: ordered steps, exact files,
    signatures, edge cases. An implementer who never saw the planning
    conversation executes this top-to-bottom with zero design decisions.
    Use one `### <Item ID>: <title>` subsection per item.

    ## Evidence
    Filled when all items in this group are `[x]`. Exact test commands +
    passing output per item, linked from this section.