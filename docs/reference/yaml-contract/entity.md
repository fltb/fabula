# Entity Type & Declaration Catalog Shapes

**Source Zod Schema:** `packages/core/src/schemas/entity-catalog.ts` — `entityTypeRefSchema`, `entityRuntimeStateSchema`, `writePolicySchema`, `requiredAtSchema`, `attributeDefinitionSchema`, `entityTypeDefinitionSchema`, `entityTypeCatalogSchema`, `entityDeclarationSchema`, `entityDeclarationCatalogSchema`
**Runtime types:** `packages/core/src/types/entity-catalog.ts` — `EntityTypeCatalog`, `EntityDeclarationCatalog`, `EntityTypeDefinition`, `EntityDeclaration`, `AttributeDefinition`

> **Not an author contract.** The schemas in `entity-catalog.ts` serialize the compiler's **internal** entity catalogs (STATE-3a). Authors never write `entityTypeDefinition`/`entityDeclaration` YAML files, and `EntityMapper` does not load these shapes from disk. Author-facing entity input lives in the kind-specific definition files under `definitions/`; see [Character](../yaml-format/character.md), [Location](../yaml-format/location.md), [Item](../yaml-format/item.md), [Faction](../yaml-format/faction.md), and [Rule](../yaml-format/rule.md), plus event-level `introduces` entries (pre-registered into the registry before replay — see “Relationship to the compiler”).

## Three-layer model

1. **`EntityTypeCatalog`** — static, versioned schema of entity kinds (NOT entities, NOT part of `WorldState`). The built-in catalog is code: `packages/core/src/entity/default-catalog.ts` (`defaultEntityTypeCatalog`). Because `AttributeDefinition.valueSchema` is a live `z.ZodTypeAny` instance, this catalog is programmatic and cannot round-trip through plain JSON/YAML.
2. **`EntityDeclarationCatalog`** — stable `entityId` + `typeRef` + immutable metadata, an optional runtime input passed to `ReplayEngine`/`applyNarrativeEvent` for lifecycle validation.
3. **`WorldState.entities[entityId]`** — runtime attribute maps: `Record<EntityId, Record<string, unknown>>` (see `types/world.ts`). Each entry holds plain attribute values only (e.g. `lifecycle`, `status`); the `Entity` object with `id`, `kind`, `name`, `definitionFile`, `lifecycle`, `typeRef`, and `state` lives separately in `InMemoryEntityRegistry`, populated from author definitions by `registry.load()` plus replay postconditions.

The schemas below describe these internal catalogs as records. Only `EntityDeclarationCatalog` is genuinely serializable to plain JSON/YAML and back; `EntityTypeCatalog` is programmatic because `AttributeDefinition.valueSchema` is a live Zod schema instance.

## Fields

### EntityTypeCatalog (programmatic)

`attributeDefinitionSchema.valueSchema` requires a live `z.ZodType` instance, so an `EntityTypeCatalog` can only exist in code; it cannot be persisted as plain JSON/YAML and re-parsed. The field table below describes its in-memory record shape.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `types` | `record` | **required** | — | Map of `typeId` → `EntityTypeDefinition` (see below). |
| `version` | `number` | **required** | — | Catalog version, nonnegative integer. |

### EntityTypeDefinition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `typeRef` | `object` | **required** | — | `typeId` (string) and `schemaVersion` (positive integer). |
| `kind` | `enum` | **required** | — | `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"`. |
| `attributes` | `record` | **required** | — | Map of attribute IDs to `AttributeDefinition` (see below). |
| `lifecyclePolicy` | `object` | **required** | — | `allowedTransitions`: array of `[fromState, toState]` tuples over `entityRuntimeState`. |
| `referenceCapabilities` | `object` | **required** | — | `defaultEligibility`: `"identity"`, `"live"`, or `"historical"`. |
| `typedInvariants` | `array` | **required** | — | Array of `{ id, description }`. |

### AttributeDefinition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `attributeId` | `string` | required | — | Attribute name (e.g. `location`, `status`, `health`). |
| `valueSchema` | `ZodType` | required | — | Zod schema instance for valid values. Not expressible as plain YAML — catalogs embed schema metadata programmatically. |
| `requiredAt` | `enum` | required | — | `"introduction"`, `"activation"`, or `"never"`. |
| `writePolicy` | `enum` | required | — | `"immutable"`, `"write_once"`, `"mutable"`, or `"lifecycle_managed"`. |
| `allowedLifecycleStates` | `array` | optional | — | Array of `"active"`, `"inactive"`, `"retired"`. |
| `unsetAllowed` | `boolean` | required | — | Whether the attribute can be unset. |
| `semanticRole` | `string` | optional | — | Semantic annotation (e.g. `"identity"`, `"lifecycle"`, `"location"`). |
| `typedReferenceConstraint` | `object` | optional | — | Constrains value to reference a specific entity kind. Contains `targetKind` (string) and optional `targetTypeId` (string). |

### EntityDeclarationCatalog (serialized)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `declarations` | `record` | **required** | — | Map of `entityId` → `EntityDeclaration` (see below). |
| `version` | `number` | **required** | — | Catalog version, nonnegative integer. |

### EntityDeclaration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `entityId` | `string` | **required** | — | Unique identifier (e.g. `xianglins_wife`). |
| `typeRef` | `object` | **required** | — | `typeId` (string) and `schemaVersion` (positive integer). |
| `immutableMetadata` | `object` | **required** | — | `name` (display name) and `definitionFile` (path to the defining YAML file, project-relative). |
| `provenance` | `object` | optional | — | `source` (e.g. `user`, `compiler`, `migration`) and `hash` (content hash). Either fully present or absent. |

## Closed Enums

- `kind`: `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"` (6 values)
- `requiredAt`: `"introduction"`, `"activation"`, `"never"` (3 values)
- `writePolicy`: `"immutable"`, `"write_once"`, `"mutable"`, `"lifecycle_managed"` (4 values)
- `entityRuntimeState`: `"active"`, `"inactive"`, `"retired"` (3 values)
- `defaultEligibility`: `"identity"`, `"live"`, `"historical"` (3 values)

## Mutual Exclusions

- `entityDeclarationCatalogSchema` is a plain `z.record` — distinct record keys may contain the same `entityId` value; the schema does not cross-check key↔value consistency.
- `provenance` is either fully present (both `source` and `hash`) or absent — partial provenance is rejected.
- `immutableMetadata` is labeled immutable by name, but no compiler consumer mutates or rejects changes to it; treat it as conventional, not enforced.
- Catalog top-level objects are `.strict()`, but the nested `immutableMetadata`, `provenance`, `lifecyclePolicy`, `referenceCapabilities`, and `typedInvariants` objects omit `.strict()` — unknown keys inside them are stripped, not rejected.

## Serialized Shape Example

A serialized `EntityDeclarationCatalog` (compiler-produced — never authored):

```yaml
declarations:
  xianglins_wife:
    entityId: xianglins_wife
    typeRef:
      typeId: character
      schemaVersion: 1
    immutableMetadata:
      name: "祥林嫂"
      definitionFile: definitions/characters/xianglins_wife.yaml
version: 1
```

A serialized `EntityTypeCatalog` entry (compiler-produced — never authored; `valueSchema` is a live Zod instance, so the catalog is programmatic and this JSON cannot be re-parsed by `entityTypeCatalogSchema` — it also omits the required `valueSchema`, so it would not validate):

```json
{
  "types": {
    "location": {
      "typeRef": { "typeId": "location", "schemaVersion": 1 },
      "kind": "location",
      "attributes": {
        "access": { "attributeId": "access", "requiredAt": "never", "writePolicy": "mutable", "unsetAllowed": true, "semanticRole": "lifecycle" }
      },
      "lifecyclePolicy": { "allowedTransitions": [["active", "inactive"], ["active", "retired"], ["inactive", "active"], ["inactive", "retired"]] },
      "referenceCapabilities": { "defaultEligibility": "live" },
      "typedInvariants": []
    }
  },
  "version": 1
}
```

## Relationship to the compiler

- `defaultEntityTypeCatalog` (built-in code) supplies the six kind definitions; it is **not** loaded from author YAML.
- `EntityMapper.loadProject()` returns parsed definition objects (`ProjectData`); it does not construct registry `Entity` objects. `InMemoryEntityRegistry.load()` builds the registry `Entity`s from those definitions (`id`, `kind`, `name`, `definitionFile`, `lifecycle: 'active'`, `typeRef: { typeId: <kind>, schemaVersion: 1 }`, `state`) — neither the mapper nor the registry parses `entityTypeCatalog`/`entityDeclarationCatalog` documents.
- An `EntityDeclarationCatalog` may be supplied programmatically to `ReplayEngine`/`applyNarrativeEvent` to enforce lifecycle transitions and unknown-entity checks during replay.
- `worldFacts` from `state_initial.yaml` are registered as `concept` entities. Event `introduces` entries are registered **before** replay: `initializeProject()` pre-registers each one into the registry and `buildInitialState()` folds their state into the baseline `initialFacts`; replay never dispatches `event.introduces`, so these are baseline registrations, not event-time runtime introductions.

## Source-Map Diagnostic Format

Because these schemas validate internal serialized catalogs rather than authored files, failures surface where the catalog is parsed (the same `readYamlFile` boundary if persisted to disk):

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at <dot-path>: <Zod message>
  path:    <catalog file>:<dot-path>
```

The `<dot-path>` is the Zod issue path joined with `.` (e.g. `declarations.xianglins_wife.typeRef.schemaVersion`) — not a JSON pointer and not a line/column.
