# YAML Contract Reference

**Status:** Frozen — Wave 4+5 normalized runtime contracts  
**Policy:** All YAML contracts in this directory define the author-facing YAML surface for the Novalistically compiler. The compiler reads these YAML files and produces normalized IR (internal representation). No field, enum value, or structure in these contracts may be changed without a version bump.

## Version Policy

- Each contract schema has an implicit `schemaVersion` field.
- Version bumps are minor (compatible addition) or major (breaking change).
- The compiler validates every input YAML against the **current** schema version.
- Migrations are documented in `docs/migrations/`.

## Contract Index

| #  | Document | YAML Contract | Source Schema File | Fixture Sources |
|----|----------|---------------|-------------------|-----------------|
| 1  | [initial-state.md](./initial-state.md) | `worldInitialState` — world facts, threads, time anchors | `state-initial.ts` | `zhu-fu/definitions/state_initial.yaml`, `arcane-aftermath/definitions/state_initial.yaml` |
| 2  | [entity.md](./entity.md) | Entity type/declaration/introduction/lifecycle | `entity-catalog.ts` | `zhu-fu/definitions/characters/*.yaml` |
| 3  | [relationship.md](./relationship.md) | n-ary relationship type/epoch/membership/dimension | `relationship.ts` | `zhu-fu/definitions/relationships/*.yaml`, `arcane-aftermath/definitions/relationships/*.yaml` |
| 4  | [knowledge.md](./knowledge.md) | Proposition/claim/information act | `knowledge.ts` | `zhu-fu/definitions/state_initial.yaml` (worldFacts) |
| 5  | [thread.md](./thread.md) | Thread type/run/goal/milestone | `thread.ts` | `zhu-fu/definitions/state_initial.yaml` (threads) |
| 6  | [rule.md](./rule.md) | Rule specification/constraint/exception | `rule.ts` (in-line schema), `primitives.ts` | `zhu-fu/definitions/rules/*.yaml`, `arcane-aftermath/definitions/rules/*.yaml`, `most-dangerous-game/definitions/rules/*.yaml` |
| 7  | [causal-deps.md](./causal-deps.md) | Typed causal dependencies (read resolution, graph edges) | `graph.ts`, `integration.ts` | `fixtures/*/chapters/*/*.yaml` (precondition/postcondition chains) |
| 8  | [discourse.md](./discourse.md) | Discourse scene contract/acts | `discourse.ts` | `discourse.ts` (schema examples) |
| 9  | [ellipsis-bridge.md](./ellipsis-bridge.md) | NarrativeEllipsis + DiscourseBridge | `graph.ts`, `integration.ts` | `graph.ts`, `integration.ts` (schema defs) |
| 10 | [initial-state.md](./initial-state.md) | See row 1 | — | — |

## Migration Policy
1. **Adding a new optional field** — minor bump. The compiler accepts YAMLs with or without it.
2. **Adding a new required field** — major bump. All existing YAMLs must be updated before validation passes.
3. **Removing or renaming a field** — major bump. Old YAMLs fail validation with a clear error.
4. **Adding an enum variant** — minor bump if the new value is backward-compatible for comparison logic; otherwise major.
5. **Changing validation rules** (e.g., tightening mutual-exclusion constraints) — major bump.

## Fields

Each contract document in this directory (excluding this index) contains a `## Fields` section with complete field tables, mutually exclusive forms, and closed enums. Refer to individual documents for field-level reference.

## Compiler Guarantees

- **Strict Zod validation** — every input YAML passes through its schema's `.parse()` with `.strict()` mode active. Unknown keys cause immediate `ConfigError`.
- **No silent fallback** — unknown fields, placeholder values (`changed`, `resolved`, `updated`, etc.), and stringly-typed alternatives are all rejected with diagnostic error messages containing the YAML file path and JSON pointer to the offending node.
- **Normalized IR** — the compiler irons YAML input into the normalized runtime type. Internal fields (`provider`, `output`, `read`, `hash`, `tombstone`) are NEVER required from the author; they are produced by the compiler.

## File Layout

For a project `my-story/`, the compiler discovers YAML files under:

```
my-story/
  definitions/
    characters/     → Entity declarations (character, location, item, concept)
    relationships/  → Relationship definitions
    rules/          → Rule definitions
    state_initial.yaml  → WorldInitialState
  chapters/
    chapter_NN/
      _chapter.yaml
      E*.yaml       → Event files (contain preconditions, postconditions, threadProgress, etc.)
  scenes/
    chapter-NN/
      E*.yaml       → Scene presentation / discourse files
```

## Source-Map Diagnostics

Every validation error includes:

```
ConfigError at fixtures/zhu-fu/definitions/rules/widow_purity.yaml:12:8
  path: /logicalConsequences/0/check/filter
  message: Invalid filter expression — expected entity.field operator value
```

The `path` component is a YAML JSON pointer. The file path is project-relative.
