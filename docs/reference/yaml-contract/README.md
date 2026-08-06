# YAML Contract Reference

**Status:** Current — synchronized with the source-verified baseline at [`docs/current-state.md`](../../current-state.md) (2026-08-06, commit `6c174a2`); the prior "Wave 4+5 frozen" framing is historical. Statements in this directory describe current runtime behavior; future-policy or design-only material is explicitly marked as such.
**Policy:** This directory contains the YAML wire contracts of the Novalistically compiler, divided into two groups: author-facing contracts (`initial-state`, `relationship`, `knowledge`, `thread`, `rule`, `causal-deps`, `discourse`, `ellipsis-bridge`) describe YAML files authors write under `definitions/`; internal reference documents (`entity`) describe compiler-produced serialization shapes that are **not** accepted project YAML — the one authored exception is `definitions/entity-types.yaml`, a required loader input (see [entity.md](./entity.md)). The compiler reads the author-facing YAML files and produces normalized IR (internal representation). Changes are classified by compatibility; the structured-timestamp extension adds no new YAML version discriminator.

## Version Policy

- Structured authored timestamps are a minor-compatible accepted-form extension: existing compact strings remain valid.
- This extension does not require a new `schemaVersion` field or a migration file. **No authored definition file in this directory exposes a `schemaVersion` field** — the only YAML carrying one is the project config `nova.yaml` (`projectConfigSchema`), where it defaults to `1` and is auto-migrated by `loadProjectConfig()`.
- A breaking validation change requires a documented compatibility decision and migration guidance when applicable.

## Project Config (`nova.yaml`) — 2026-08-06 additions

`nova.yaml` is `projectConfigSchema` (strict, `packages/core/src/schemas/project.ts`). This delivery adds/confirms these top-level keys:

- `releasePolicy?: { warnings, openBlockingReviews }` — strict object (`releasePolicySchema`): `warnings` is `'accept-and-record' | 'require-waiver'`, **default `'accept-and-record'`** when the key is absent (a warning-only candidate is ACCEPTED and its reasons + warning fingerprints are recorded on the decision); under `require-waiver` a warning-only candidate stays `pending_waiver` until a maintainer decision resolves the gate (`nova_release_gate_decide` → Core `resolveReleaseGate`, which re-runs the SOLE release evaluator with zero provider calls). Legacy projects without the key get the canonical default — the policy is NEVER inferred from historical `pending_waiver` records. `openBlockingReviews` is a fixed literal `'block'` for now.
- `snapshotInterval?: number` — default 10 (`DEFAULT_CONFIG`): how many events between canonical-world snapshots (consumed by the Workbench `CanonicalStateProjectionService`).
- `plugins?: { enabled: boolean }` — plugin master switch (still only `enabled`).

### EventFile `extensions` block (plugin namespace)

`eventFileSchema` structurally accepts `extensions` (a JSON-safe object keyed by plugin name; read-only source data that NEVER enters WorldState). The second, identity-aware gate is `PluginExtensionSchemaRegistrar` (`@novalistically/core` root export):

- an `extensions` key whose plugin is not enabled (unknown or disabled) is a **SOURCE ERROR** (`SOURCE_EXTENSION_NAMESPACE_UNKNOWN`) — it flips `passed` and never reaches render or state;
- when the enabled plugin declares an extension schema, the payload must satisfy it; absent a declared schema, structural JSON is accepted;
- accepted-layer and working-layer validation paths (`analyzeSource` / `extensionDiagnosticsForSnapshot`) share identical namespace semantics.

## Host Configuration (`workbench.yaml`, V3) — 2026-08-06

`workbench.yaml` is the Host's single secret-free configuration source of truth (revision-CAS configuration service). The V3 contract (`WorkbenchConfigurationV3`, `packages/workbench-protocol/src/configuration.ts`) adds:

- per-project `providerProfile: string` (V3 replaces the single `provider` with a per-profile `providers` map) plus an explicit `trustedPlugins: WorkbenchTrustedPluginConfigurationV3[]` — each entry carries `name` / `version` / `moduleHash` / `required`; `moduleHash` is the SHA-256 identity `activateNodePlugins` verifies against the plugin's `index.js`;
- host-wide `operationLimits: WorkbenchOperationLimitsV3` — `maxQueuedPerProject` (default 64), `maxConcurrentRendersPerProject` (fixed `1`), `maxConcurrentRendersPerHost` (default 2);
- `agent: WorkbenchAgentConfigurationV3` — `enabled` (default `false`), `maxTurns` (default 16), `maxToolCalls` (default 64); the `agent-chat` capability additionally requires the model port's `supportsToolCalls` and the parity flag;
- V1/V2 remain readable migration inputs and are normalized to V3 by `normalizeWorkbenchConfiguration` (legacy projects bind `providerProfile: 'default'`, no trusted plugins, fixed operation/agent defaults).

## Contract Index

| #  | Document | YAML Contract | Source Schema File | Fixture Sources |
|----|----------|---------------|-------------------|-----------------|
| 1  | [initial-state.md](./initial-state.md) | `worldInitialState` — facts, thread declarations, initial knowledge and anchors (required) | `state-initial.ts` | `zhu-fu/definitions/state_initial.yaml`, `arcane-aftermath/definitions/state_initial.yaml` |
| 2  | [entity.md](./entity.md) | `EntityTypeCatalogSource` (`definitions/entity-types.yaml`, required) | `entity-catalog.ts` | `fixtures/*/definitions/entity-types.yaml` |
| 3  | [relationship.md](./relationship.md) | relationship type catalog, declarations, transactions and identity groups | `relationship.ts` | `definitions/relationship-types.yaml`, `definitions/relationships/*.yaml` |
| 4  | [knowledge.md](./knowledge.md) | proposition catalog, initial claims/common ground and event knowledge transactions | `knowledge.ts` | `definitions/propositions.yaml`, `state_initial.yaml`, event YAML |
| 5  | [thread.md](./thread.md) | thread type catalog, declarations and normalized transactions | `thread.ts` | `definitions/thread-types.yaml`, `state_initial.yaml` |
| 6  | [rule.md](./rule.md) | rule type catalog, declarations, specifications and transactions | `rule.ts` | `definitions/rule-types.yaml`, `definitions/rules/*.yaml` |
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

- **Strict Zod validation** — input YAML passes through its schema's `safeParse()` at `readYamlFile` (`entity/yaml-loader.ts`); top-level canonical source documents, including rule and relationship catalogs/declarations, use strict schemas and reject unknown keys. Some nested `entity-catalog.ts` objects (`immutableMetadata`, `provenance`, `lifecyclePolicy`, `referenceCapabilities`, `typedInvariants`) remain ordinary `z.object` values whose unknown keys are stripped; check the owning schema for nested strictness.
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
    relationships/          → RelationshipDeclaration
    rules/                  → RuleDeclaration
    narrators/              → NarratorProfile (optional directory)
    assertions/             → NarratorAssertion (optional directory)
    entity-types.yaml       → EntityTypeCatalogSource (required)
    thread-types.yaml       → ThreadTypeCatalog (required)
    propositions.yaml       → PropositionCatalog (required)
    relationship-types.yaml → RelationshipTypeCatalog (required)
    rule-types.yaml         → RuleTypeCatalog (required)
    discourse-ledger.yaml   → PlannedDiscourseLedgerSource (optional; absent → empty compiled ledger)
    state_initial.yaml      → WorldInitialState (required)
  chapters/
    chapter_NN/
      _chapter.yaml         → ChapterMetadata (optional)
      E*.yaml       → Event files (contain preconditions, postconditions, threadProgress, ruleEffects, extensions — see above)
  scenes/                   → rendered scene prose + metadata — Host repository output, never written by Core
    chapter-NN/
      E*.md
      E*.yaml
      E*_render_request.yaml
  .nova/                    → Host-owned runtime artifacts: derived/ (threads, foreshadowing,
                             relationships, rules), responses/ (persisted provider responses)
```

## Source-Map Diagnostics

`readYamlFile` (the strict YAML boundary in `entity/yaml-loader.ts`) reports the first validation failure as a `ConfigError` (code `CONFIG_INVALID`):

```text
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at types.constraint.typeId:
    Rule type map key "constraint" must match internal typeId "other"
  path:    definitions/rule-types.yaml:types.constraint.typeId
```

The `path` component is the Zod issue path joined with `.` (a dot-path into the parsed document, e.g. `threads.0.threadId`, `timeAnchors.0.at`). The file path is preserved as supplied by the caller — `readYamlFile` places the caller's `filePath` verbatim into `ConfigError.context.path` without relativizing it, so an absolute project path yields absolute diagnostic paths. There is no line/column component; `YAML parsing failed` is reported separately when the file is not parseable YAML.
