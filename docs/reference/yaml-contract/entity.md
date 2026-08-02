# Entity Type & Declaration Catalog Shapes

**Source Zod Schema:** `packages/core/src/schemas/entity-catalog.ts` — `entityTypeRefSchema`, `entityRuntimeStateSchema`, `writePolicySchema`, `requiredAtSchema`, `attributeDefinitionSchema`, `entityTypeDefinitionSchema`, `entityTypeCatalogSchema`, `entityDeclarationSchema`, `entityDeclarationCatalogSchema`
**Runtime types:** `packages/core/src/types/entity-catalog.ts` — `EntityTypeCatalog`, `EntityDeclarationCatalog`, `EntityTypeDefinition`, `EntityDeclaration`, `AttributeDefinition`

> **Not an author contract — with one exception.** The schemas in `entity-catalog.ts` serialize the compiler's **internal** entity catalogs (STATE-3a). Authors never write `entityTypeDefinition`/`entityDeclaration` YAML files, and `EntityMapper` does not load those shapes from disk. The one authored exception is `definitions/entity-types.yaml`, a **required** loader input validated by `entityTypeCatalogSourceSchema` — a strict, versionless source shape (no `version`/`schemaVersion`, no live Zod schemas) that `compileEntityTypeCatalog()` turns into the runtime catalog. Author-facing entity input otherwise lives in the kind-specific definition files under `definitions/`; see [Character](../yaml-format/character.md), [Location](../yaml-format/location.md), [Item](../yaml-format/item.md), [Faction](../yaml-format/faction.md), and [Rule](../yaml-format/rule.md), plus event-level `introduces` entries (see “Relationship to the compiler”).

## Three-layer model

1. **`EntityTypeCatalog`** — static, versioned schema of entity kinds (NOT entities, NOT part of `WorldState`). There is no built-in default catalog: the required author file `definitions/entity-types.yaml` (validated by `entityTypeCatalogSourceSchema`) is compiled per call by `compileEntityTypeCatalog()` (`entity/entity-catalog-compiler.ts`) into a fresh runtime catalog. Because `RuntimeAttributeDefinition.valueSchema` is a live `z.ZodTypeAny` instance built fresh per compile, this catalog is programmatic and cannot round-trip through plain JSON/YAML.
2. **`EntityDeclarationCatalog`** — stable `entityId` + `typeRef` + immutable metadata + `introduction` source, derived by `buildDeclarationCatalog()` (`entity/project-runtime.ts`) from author definitions, `state_initial.yaml` world facts, and event-level `introduces` entries; threaded through `EntityCatalogContext` for lifecycle and write validation.
3. **`WorldState.entities[entityId]`** — runtime attribute maps: `Record<EntityId, Record<string, unknown>>` (see `types/world.ts`). Each entry holds plain attribute values only (e.g. `lifecycle`, `status`); the `Entity` object with `id`, `kind`, `name`, `definitionFile`, `lifecycle`, `typeRef`, and `state` lives separately in `InMemoryEntityRegistry`, populated from author definitions by `registry.load()`, by `registry.register()` for definition-less introduced entities (`loadCanonicalProject()`), plus replay postconditions.

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
| `valueType` | `enum` | required | — | `"string"`, `"number"`, `"boolean"`, `"string_list"`, `"string_map"` (5 values). |
| `valueSchema` | `ZodType` | required | — | Zod schema instance for valid values, rebuilt per compile from `valueType`. Not expressible as plain YAML — the runtime catalog embeds schema metadata programmatically. |
| `requiredAt` | `enum` | required | — | `"introduction"`, `"activation"`, or `"never"`. |
| `writePolicy` | `enum` | type/source only | — | `"immutable"`, `"write_once"`, `"mutable"`, or `"lifecycle_managed"`. Present on the TypeScript `AttributeDefinition` type and in the authored source schema, but **absent from `attributeDefinitionSchema`** (the serialization schema carries a live `valueSchema` instead); the runtime catalog keeps both `writePolicy` and `valueSchema`. |
| `unsetAllowed` | `boolean` | required | — | Whether the attribute can be unset. |
| `semanticRole` | `string` | optional | — | Semantic annotation (e.g. `"identity"`, `"lifecycle"`, `"location"`). |
| `typedReferenceConstraint` | `object` | optional | — | Constrains value to reference a specific entity kind. Contains `targetKind` (string) and optional `targetTypeId` (string). |

### Author-facing catalog source (`definitions/entity-types.yaml`, required)

The one author-authored catalog shape. `EntityMapper.loadProject()` reads `definitions/entity-types.yaml` through `entityTypeCatalogSourceSchema` — a **required** input (a missing file is a `ConfigError`), strictly `.strict()` at every level, and **versionless**: no `version` or `schemaVersion` field, no migration or dual-read negotiation. `compileEntityTypeCatalog()` (`entity/entity-catalog-compiler.ts`) compiles it per call into a fresh runtime `EntityTypeCatalog`, enforcing compile-time invariants: the record key must equal each declared `typeId`; each attribute record key must equal its declared `attributeId`; and `typedInvariants` must be **empty** — invariant descriptions are not executable rules.

Top-level fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `types` | `record` | **required** | Map of `typeId` → `EntityTypeDefinitionSource`. |

`EntityTypeDefinitionSource` (`typeId` replaces the runtime `typeRef`; no `schemaVersion`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `typeId` | `string` | **required** | Declared type ID; must equal the record key. |
| `kind` | `enum` | **required** | `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"`. |
| `attributes` | `record` | **required** | Map of attribute IDs to `AttributeDefinitionSource`. |
| `lifecyclePolicy` | `object` | **required** | `allowedTransitions`: array of `[fromState, toState]` tuples over `entityRuntimeState`. |
| `referenceCapabilities` | `object` | **required** | `defaultEligibility`: `"identity"`, `"live"`, or `"historical"`. |
| `typedInvariants` | `array` | **required** | Must be empty (`[]`) — non-empty arrays are rejected at compile. |

`AttributeDefinitionSource` is the authored spelling of `AttributeDefinition` (no live `valueSchema`; `valueType` selects the value domain):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `attributeId` | `string` | required | Must equal the record key. |
| `valueType` | `enum` | required | `"string"`, `"number"`, `"boolean"`, `"string_list"`, `"string_map"`. |
| `requiredAt` | `enum` | required | `"introduction"`, `"activation"`, or `"never"`. |
| `writePolicy` | `enum` | required | `"immutable"`, `"write_once"`, `"mutable"`, or `"lifecycle_managed"`. |
| `allowedLifecycleStates` | `array` | optional | Array of `"active"`, `"inactive"`, `"retired"`. |
| `unsetAllowed` | `boolean` | required | Whether the attribute can be unset. |
| `semanticRole` | `string` | optional | Semantic annotation (e.g. `"identity"`, `"lifecycle"`, `"location"`). |
| `typedReferenceConstraint` | `object` | optional | Constrains value to reference a specific entity kind. Contains `targetKind` (string) and optional `targetTypeId` (string). |

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
| `introduction` | `object` | **required** | — | Activation source: `{ type: "initial" }` (baseline entity) or `{ type: "event", eventId }` (activated by an event-level `introduces` entry on `eventId`). |
| `immutableMetadata` | `object` | **required** | — | `name` (display name) and `definitionFile` (path to the defining YAML file, project-relative). |
| `provenance` | `object` | optional | — | `source` (e.g. `user`, `compiler`, `migration`) and `hash` (content hash). Either fully present or absent. |

## Closed Enums

- `kind`: `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"` (6 values)
- `requiredAt`: `"introduction"`, `"activation"`, `"never"` (3 values)
- `writePolicy`: `"immutable"`, `"write_once"`, `"mutable"`, `"lifecycle_managed"` (4 values)
- `valueType`: `"string"`, `"number"`, `"boolean"`, `"string_list"`, `"string_map"` (5 values)
- `entityRuntimeState`: `"active"`, `"inactive"`, `"retired"` (3 values)
- `defaultEligibility`: `"identity"`, `"live"`, `"historical"` (3 values)

## Mutual Exclusions

- `entityDeclarationCatalogSchema` is a plain `z.record` — distinct record keys may contain the same `entityId` value; the schema does not cross-check key↔value consistency.
- `provenance` is either fully present (both `source` and `hash`) or absent — partial provenance is rejected.
- `immutableMetadata` is labeled immutable by name, but no compiler consumer mutates or rejects changes to it; treat it as conventional, not enforced.
- Catalog top-level objects are `.strict()`, but the nested `immutableMetadata`, `provenance`, `lifecyclePolicy`, `referenceCapabilities`, and `typedInvariants` objects omit `.strict()` — unknown keys inside them are stripped, not rejected.
- `entityTypeCatalogSourceSchema` is `.strict()` at every level and versionless — authored `definitions/entity-types.yaml` carries no `version`/`schemaVersion`. `compileEntityTypeCatalog()` enforces record-key ↔ declared-`typeId` equality, attribute-key ↔ declared-`attributeId` equality, and rejects non-empty `typedInvariants` (ConfigError).
- `EntityDeclaration.introduction` is required and discriminated: exactly `{ type: "initial" }` or `{ type: "event", eventId }` — no other forms.

## Serialized Shape Example

A serialized `EntityDeclarationCatalog` (compiler-produced — never authored):

```yaml
declarations:
  xianglins_wife:
    entityId: xianglins_wife
    typeRef:
      typeId: character
      schemaVersion: 1
    introduction:
      type: initial
    immutableMetadata:
      name: "祥林嫂"
      definitionFile: definitions/characters/xianglins_wife.yaml
version: 1
```

A serialized `EntityTypeCatalog` entry (compiler-produced — never authored; `valueSchema` is a live Zod instance, so the catalog is programmatic and this JSON cannot be re-parsed by `entityTypeCatalogSchema` — `valueSchema` is shown symbolically and would be required by the schema; the serialization schema also carries no `writePolicy`, which exists on the TypeScript type and in the authored source schema only):

```json
{
  "types": {
    "location": {
      "typeRef": { "typeId": "location", "schemaVersion": 1 },
      "kind": "location",
      "attributes": {
        "access": { "attributeId": "access", "valueType": "string", "valueSchema": "<z.ZodString>", "requiredAt": "never", "unsetAllowed": true, "semanticRole": "lifecycle" }
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

- `EntityMapper.loadProject()` requires `definitions/entity-types.yaml` and returns parsed definition objects (`ProjectData`), including `entityTypeCatalogSource`. There is no built-in default catalog: `loadCanonicalProject()` (`entity/project-runtime.ts`) compiles the source per call via `compileEntityTypeCatalog()` into the runtime `EntityTypeCatalog` (fresh Zod `valueSchema` instances every call) and derives the `EntityDeclarationCatalog` via `buildDeclarationCatalog()` (author definitions + `state_initial.yaml` world facts + event `introduces`).
- `EntityMapper.loadProject()` returns parsed definition objects (`ProjectData`); it does not construct registry `Entity` objects. `InMemoryEntityRegistry.load()` builds the registry `Entity`s from those definitions (`id`, `kind`, `name`, `definitionFile`, `lifecycle: 'active'`, `typeRef: { typeId: <kind>, schemaVersion: 1 }`, `state`) — neither the mapper nor the registry parses `entityTypeCatalog`/`entityDeclarationCatalog` documents (the runtime catalog is compiled, not parsed).
- `buildDeclarationCatalog()` assigns `introduction: { type: 'initial' }` to definition- and worldFact-backed entities and `{ type: 'event', eventId }` to event-introduced entities. The resulting `EntityCatalogContext` (declaration catalog + compiled type catalog) is threaded through replay, story-boundary compilation, and every catalog write path — no optional fallback.
- `worldFacts` from `state_initial.yaml` are registered as `concept` entities for the editorial-render registry baseline. The compiler projection returned by `compileProject()` exposes only detached normalized data and a read-only `EntityLookup`; it does not pre-register event `introduces` entries or expose registry/runtime internals.

## Source-Map Diagnostic Format

Because these schemas validate internal serialized catalogs rather than authored files, failures surface where the catalog is parsed (the same `readYamlFile` boundary if persisted to disk):

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at <dot-path>: <Zod message>
  path:    <catalog file>:<dot-path>
```

The `<dot-path>` is the Zod issue path joined with `.` (e.g. `declarations.xianglins_wife.typeRef.schemaVersion`) — not a JSON pointer and not a line/column.
