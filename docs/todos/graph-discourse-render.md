# graph-discourse-render: Typed causal graph, discourse model, and render surface

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| GRAPH-1 | [ ] | STATE-1, STATE-3 (in state-model), DAG-2 (in dag-replay) | `docs/TODO.md` lines 975-986 |
| DISCOURSE-1 | [ ] | GRAPH-1 | `docs/TODO.md` lines 988-999 |
| RENDER-SURFACE-1 | [ ] | DISCOURSE-1 | `docs/TODO.md` lines 1001-1010 |

## Group-level dependencies
- **state-model**: STATE-1 + STATE-3 must be `[x]` before GRAPH-1.
- **dag-replay**: DAG-2 must be `[x]` before GRAPH-1.
- DISCOURSE-1 needs GRAPH-1; RENDER-SURFACE-1 needs DISCOURSE-1. All internal.

## Sub-plan
To be authored when this group's wave is reached. Use one `### <ID>: <title>` subsection per item, with ordered steps, exact files, signatures, edge cases — same shape as an OMP plan Approach. An implementer who never saw the planning conversation executes this top-to-bottom with zero design decisions.

## Evidence
—