# cli-storage: CLI command paths and storage abstraction audit

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| CLI-5 | [x] | — | `docs/TODO.md` lines 1304-1312 — removed unused InMemoryEntityRegistry import + registry creation in review command; build + cli tests green |
| STORAGE-2 | [ ] | — | `docs/TODO.md` lines 1235-1256 |
| CLI-4 | [ ] | API-1 (in api-core-validator) | `docs/TODO.md` lines 1282-1290 |
| CLI-3 | [ ] | API-2 (in api-core-validator) | `docs/TODO.md` lines 1272-1280 |

## Group-level dependencies
- **api-core-validator**: API-1 must be `[x]` before CLI-4; API-2 must be `[x]` before CLI-3.
- CLI-5 and STORAGE-2 have no cross-group deps and may be authored/executed in Wave 1 (before api-core-validator completes). The group row only flips to `[x]` when all 4 items are `[x]`.

## Sub-plan
To be authored when this group's wave is reached. Use one `### <ID>: <title>` subsection per item, with ordered steps, exact files, signatures, edge cases — same shape as an OMP plan Approach. An implementer who never saw the planning conversation executes this top-to-bottom with zero design decisions.

## Evidence
—