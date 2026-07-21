# integration: Cross-domain resolution, merge, and reference eligibility

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| INTEGRATION-2 | [ ] | STATE-3 (in state-model) | `docs/TODO.md` lines 926-932 |
| INTEGRATION-1 | [ ] | STATE-1..6 (in state-model), DAG-1..5 (in dag-replay) | `docs/TODO.md` lines 1012-1020 |

## Group-level dependencies
- **state-model**: STATE-3 for INTEGRATION-2; STATE-1..6 for INTEGRATION-1.
- **dag-replay**: DAG-1..5 for INTEGRATION-1.
- INTEGRATION-2 may be authored/executed once state-model's STATE-3 is `[x]`. INTEGRATION-1 needs both state-model and dag-replay fully `[x]`.

## Sub-plan
To be authored when this group's wave is reached. Use one `### INTEGRATION-X: <title>` subsection per item, with ordered steps, exact files, signatures, edge cases — same shape as an OMP plan Approach. An implementer who never saw the planning conversation executes this top-to-bottom with zero design decisions.

## Evidence
—