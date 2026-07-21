# dag-replay: DAG causal edges, replay, and snapshot keying

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| DAG-0 | [ ] | — | `docs/TODO.md` lines 279-292 |
| DAG-1 | [ ] | STATE-3 (in state-model) | `docs/TODO.md` lines 794-804 |
| DAG-2 | [ ] | STATE-3 (in state-model) | `docs/TODO.md` lines 806-818 |
| DAG-3 | [ ] | STATE-3 (in state-model) | `docs/TODO.md` lines 820-832 |
| DAG-4 | [ ] | STATE-3 (in state-model) | `docs/TODO.md` lines 834-842 |
| DAG-5 | [ ] | STATE-3 (in state-model), DAG-2 | `docs/TODO.md` lines 844-887 |

## Group-level dependencies
- **state-model**: STATE-3 must be `[x]` before DAG-1, DAG-2, DAG-3, DAG-4, DAG-5 can be authored/executed.
- DAG-0 has no cross-group deps and may be authored/executed in Wave 1 (before state-model completes). The group row only flips to `[x]` when all 6 items are `[x]`.

## Sub-plan
To be authored when this group's wave is reached. Use one `### DAG-X: <title>` subsection per item, with ordered steps, exact files, signatures, edge cases — same shape as an OMP plan Approach. An implementer who never saw the planning conversation executes this top-to-bottom with zero design decisions.

## Evidence
—