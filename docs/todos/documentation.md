# documentation: Author-facing documentation for YAML formats, event facts, configuration

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| DOC-3 | [ ] | — | `docs/TODO.md` lines 1248-1259 — configuration.md missing 6 nova.yaml fields |
| DOC-2 | [ ] | STATE-1 [x], GRAPH-1 [x] | `docs/TODO.md` lines 1227-1246 — event.md missing Fact dual representation docs |
| DOC-1 | [ ] | YAML-CONTRACT (in capability-contract) | `docs/TODO.md` lines 1217-1225 — location/item/faction/branch YAML format docs |

## Group-level dependencies
- DOC-3: no deps → parallel with Wave 4
- DOC-2: STATE-1 [x] ✅, GRAPH-1 [x] ✅
- DOC-1: YAML-CONTRACT [x] ← serial after YAML-CONTRACT

## Sub-plan

### DOC-3: configuration.md — add 6 missing nova.yaml fields

**Scope**: `docs/getting-started/configuration.md` lists 6 of 12 `projectConfigSchema` fields. Add the missing 6: `defaultLanguage`, `genre`, `synopsis`, `validatorOverrides`, `circuitBreaker`, `reviewExpiry`. Each with type, description, and example.

**Target file**: `docs/getting-started/configuration.md`

**Fields to add**:
| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `defaultLanguage` | string | Default language for prose generation | `zh-CN`, `en` |
| `genre` | string | Genre tag used by render pipeline | `literary`, `fantasy` |
| `synopsis` | string | Project synopsis for context | `"A story about..."` |
| `validatorOverrides` | object | Per-validator configuration overrides | `{ pacing: { strict: false } }` |
| `circuitBreaker` | object | Retry circuit breaker config | `{ maxFailures: 5, timeoutMs: 60000 }` |
| `reviewExpiry` | string | Auto-resolve review comments after duration | `72h`, `7d` |

Read the existing table format in configuration.md and match it. Add the 6 rows to the existing field table.

**Acceptance**: `grep -c "defaultLanguage\|genre\|synopsis\|validatorOverrides\|circuitBreaker\|reviewExpiry" docs/getting-started/configuration.md` ≥ 6.

### DOC-2: event.md — document Fact dual representation

**Scope**: `docs/reference/yaml-format/event.md` only describes old Fact shape. Update to reflect STATE-1/GRAPH-1: presence-aware transactions, operators (10), set/unset/narrativeHint forms, mutually exclusive rules, placeholder rejection.

**Target file**: `docs/reference/yaml-format/event.md`

**Sections to add/update**:
1. **Operator table** (precondition only): `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `exists`, `not_exists` — each with brief description and example
2. **Fact forms** (mutually exclusive):
   - Form 1: `set` (default) — `value` required, writes canonicalized value
   - Form 2: `unset` — `operation: unset`, deletes attribute
   - Form 3: narrativeHint — `narrativeHint` present, `value` absent, Pass 2 only, never writes WorldState
3. **Placeholder rejection**: `changed`, `resolved`, `updated` are rejected by Zod schema
4. **narrativeHint field**: semantic attribute consumed by Pass 2, not stored in WorldState
5. **Preconditions**: `exists`/`not_exists` forbid `value`; comparison operators require `value`; missing state + `neq` → fails

Read the existing event.md to understand its structure. Add/update sections at the appropriate location (after existing Fact description, before event structure section).

**Acceptance**: `grep -c "exists\|not_exists\|unset\|narrativeHint\|placeholder" docs/reference/yaml-format/event.md` ≥ 10.

### DOC-1: location/item/faction/branch YAML format docs

**Scope**: Create 4 YAML format documentation files from schema registry: `location.md`, `item.md`, `faction.md`, `branch.md`. Each covers Entity type/declaration/introduction/retirement/reference-policy/migration.

**Target files** (existing or new):
- `docs/reference/yaml-format/location.md` — location entity type, attributes, lifecycle
- `docs/reference/yaml-format/item.md` — item entity type, condition/ownership/consumption
- `docs/reference/yaml-format/faction.md` — faction entity type, membership
- `docs/reference/yaml-format/branch.md` — BranchSet, BranchPath, decisions

**Each document MUST include**:
- Field table (from Zod schema)
- Valid YAML example (from fixtures if available)
- Invalid YAML example with expected error
- Normalized IR mention (what the compiler produces)
- Source-map diagnostic reference

**Reference existing format docs** for structure: `docs/reference/yaml-format/character.md`, `event.md`, `rule.md`.

**Acceptance**: All 4 files exist. `grep -c "## Fields" docs/reference/yaml-format/location.md docs/reference/yaml-format/item.md docs/reference/yaml-format/faction.md docs/reference/yaml-format/branch.md` ≥ 4.

## Evidence
—
