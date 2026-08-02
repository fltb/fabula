# YAML Contract Reference

**Status:** Current — synchronized with the source-verified baseline at [`docs/current-state.md`](../../current-state.md) (commit `0e46174`); the prior "Wave 4+5 frozen" framing is historical. Statements in this directory describe current runtime behavior; future-policy or design-only material is explicitly marked as such.
**Policy:** This directory contains the YAML wire contracts of the Novalistically compiler, divided into two groups: author-facing contracts (`initial-state`, `relationship`, `knowledge`, `thread`, `rule`, `causal-deps`, `discourse`, `ellipsis-bridge`) describe YAML files authors write under `definitions/`; internal reference documents (`entity`) describe compiler-produced serialization shapes that are **not** accepted project YAML — the one authored exception is `definitions/entity-types.yaml`, a required loader input (see [entity.md](./entity.md)). The compiler reads the author-facing YAML files and produces normalized IR (internal representation). Changes are classified by compatibility; the structured-timestamp extension adds no new YAML version discriminator.

## Version Policy

- Structured authored timestamps are a minor-compatible accepted-form extension: existing compact strings remain valid.
- This extension does not require a new `schemaVersion` field or a migration file. **No authored definition file in this directory exposes a `schemaVersion` field** — the only YAML carrying one is the project config `nova.yaml` (`projectConfigSchema`), where it defaults to `1` and is auto-migrated by `loadProjectConfig()`.
- A breaking validation change requires a documented compatibility decision and migration guidance when applicable.

## Contract Index

| #  | Document | YAML Contract | Source Schema File | Fixture Sources |
|----|----------|---------------|-------------------|-----------------|
| 1  | [initial-state.md](./initial-state.md) | `worldInitialState` — world facts, threads, time anchors (required loader input) | `state-initial.ts` | `zhu-fu/definitions/state_initial.yaml`, `arcane-aftermath/definitions/state_initial.yaml` |
| 2  | [entity.md](./entity.md) | Author-facing `EntityTypeCatalogSource` (`definitions/entity-types.yaml`, required) + internal `EntityTypeCatalog` / `EntityDeclarationCatalog` serialization (compiler-produced) | `entity-catalog.ts` | Author input: required `definitions/entity-types.yaml` + `definitions/{characters,locations,items,factions,rules}/` |
| 3  | [relationship.md](./relationship.md) | n-ary relationship type/epoch/membership/dimension | `relationship.ts` | `zhu-fu/definitions/relationships/*.yaml`, `arcane-aftermath/definitions/relationships/*.yaml` |
| 4  | [knowledge.md](./knowledge.md) | Proposition/claim/information act | `knowledge.ts` | `zhu-fu/definitions/state_initial.yaml` (worldFacts) |
| 5  | [thread.md](./thread.md) | Thread type/run/goal/milestone | `thread.ts` | `zhu-fu/definitions/state_initial.yaml` (threads) |
| 6  | [rule.md](./rule.md) | Rule specification/constraint/exception | `rule.ts` (in-line schema), `primitives.ts` | `zhu-fu/definitions/rules/*.yaml`, `arcane-aftermath/definitions/rules/*.yaml`, `most-dangerous-game/definitions/rules/*.yaml` |
| 7  | [causal-deps.md](./causal-deps.md) | Typed causal dependencies (read resolution, graph edges) | `graph.ts`, `integration.ts` | `fixtures/*/chapters/*/*.yaml` (precondition/postcondition chains) |
| 8  | [discourse.md](./discourse.md) | Discourse scene contract/acts | `discourse.ts` | `zhu-fu/definitions/discourse-ledger.yaml`, `zhu-fu/definitions/narrators/*.yaml`, `zhu-fu/definitions/assertions/*.yaml` |
| 9  | [ellipsis-bridge.md](./ellipsis-bridge.md) | NarrativeEllipsis + DiscourseBridge | `graph.ts`, `integration.ts` | `graph.ts`, `integration.ts` (schema defs) |

## Migration Policy
1. **Adding a new optional field** — minor bump. The compiler accepts YAMLs with or without it.
2. **Adding a new required field** — major bump. All existing YAMLs must be updated before validation passes.
3. **Removing or renaming a field** — major bump. Old YAMLs fail validation with a clear error.
4. **Adding an enum variant** — minor bump if the new value is backward-compatible for comparison logic; otherwise major.
5. **Changing validation rules** (e.g., tightening mutual-exclusion constraints) — major bump.

## Fields

Each contract document in this directory (excluding this index) contains a `## Fields` section with complete field tables, mutually exclusive forms, and closed enums. Refer to individual documents for field-level reference.

## Compiler Guarantees

- **Strict Zod validation** — input YAML passes through its schema's `safeParse()` at `readYamlFile` (`entity/yaml-loader.ts`); the first reported issue becomes a `ConfigError`. Top-level `*.strict()` schemas reject unknown keys, but strictness is not universal: `ruleDefinitionSchema.logicalConsequences` entries and several `entity-catalog.ts` nested objects (`immutableMetadata`, `provenance`, `lifecyclePolicy`, `referenceCapabilities`, `typedInvariants`) are ordinary `z.object` values whose unknown keys are stripped, not rejected. Scope-dependent strictness must be checked per schema.
- **No silent fallback** — placeholder values (`changed`, `resolved`, `updated`, etc.) are rejected **only** in event precondition/postcondition `value` fields (the `PLACEHOLDER_PATTERN` refinement in `schemas/primitives.ts`); other stringly-typed fields (e.g. location `initialState`) accept such strings. Unknown fields and placeholder values surface as `ConfigError`s whose messages contain the YAML file path and a dot-path to the offending node.
- **Normalized IR** — the compiler irons YAML input into the normalized runtime type. Internal fields (`provider`, `output`, `read`, `hash`, `tombstone`) are NEVER required from the author; they are produced by the compiler.

## File Layout

For a project `my-story/`, the compiler discovers YAML files under:

```
my-story/
  nova.yaml                 → ProjectConfig (only file with a schemaVersion; auto-migrated)
  definitions/
    characters/             → CharacterDefinition (yaml-format/character.md)
    locations/              → LocationDefinition (yaml-format/location.md)
    items/                  → ItemDefinition (yaml-format/item.md)
    factions/               → FactionDefinition (yaml-format/faction.md)
    relationships/          → RelationshipDefinition
    rules/                  → RuleDefinition (yaml-format/rule.md)
    narrators/              → NarratorProfile (S6c)
    assertions/             → NarratorAssertion (DISCOURSE-1, optional directory)
    entity-types.yaml       → EntityTypeCatalogSource (required loader input; strict, versionless)
    discourse-ledger.yaml   → PlannedDiscourseLedgerSource (optional; when absent the loader
                             substitutes an empty runtime ledger; hash is compiler-derived)
    state_initial.yaml      → WorldInitialState (required loader input)
  chapters/
    chapter_NN/
      _chapter.yaml         → ChapterMetadata (optional)
      E*.yaml       → Event files (contain preconditions, postconditions, threadProgress, ruleEffects, etc.)
  scenes/                   → rendered scene prose + metadata — Host repository output, never written by Core
    chapter-NN/
      E*.md
      E*.yaml
      E*_render_request.yaml
  .nova/                    → Host-owned runtime artifacts: derived/ (threads, foreshadowing,
                             relationships, rules), responses/ (persisted provider responses)
```

## Source-Map Diagnostics

`readYamlFile` (the single strict YAML boundary in `entity/yaml-loader.ts`) reports the first validation failure as a `ConfigError` (code `CONFIG_INVALID`):

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at logicalConsequences.0.check.type: Invalid enum value. Expected 'state_invariant' | 'transition_constraint' | 'progression', received 'invalid'
  path:    fixtures/zhu-fu/definitions/rules/widow_purity.yaml:logicalConsequences.0.check.type
```

The `path` component is the Zod issue path joined with `.` (a dot-path into the parsed document, e.g. `threads.0.name`, `timeAnchors.0.at`). The file path is preserved as supplied by the caller — `readYamlFile` places the caller's `filePath` verbatim into `ConfigError.context.path` without relativizing it, so an absolute project path yields absolute diagnostic paths. There is no line/column component; `YAML parsing failed` is reported separately when the file is not parseable YAML.
