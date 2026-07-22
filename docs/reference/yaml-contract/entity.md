# Entity YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/entity-catalog.ts` — `entityTypeDefinitionSchema`, `entityDeclarationSchema`, `entityTypeCatalogSchema`, `entityDeclarationCatalogSchema`  
**Fixture files:** `fixtures/zhu-fu/definitions/characters/*.yaml`, `fixtures/zhu-fu/definitions/locations/*.yaml`, `fixtures/most-dangerous-game/definitions/characters/*.yaml`

Entities are the core ontological building blocks. Each entity has a **type** definition (schema for the entity kind) and a **declaration** (a specific instance). In author-facing YAML, characters, locations, items, concepts, factions, and rules are all entities.


## Fields
## Entity Type Definition

Entity types live in a catalog (compiler-produced). Author-facing YAML files declare **entity instances** that conform to a type.

### EntityDeclaration Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `entityId` | `string` | **required** | — | Unique identifier (e.g. `xianglins_wife`, `fourth_master_lu_house`). |
| `typeRef` | `object` | **required** | — | Reference to the entity type. Contains `typeId` (string) and `schemaVersion` (positive integer). |
| `typeRef.typeId` | `string` | required | — | Type identifier matching a key in the type catalog (e.g. `character`, `location`). |
| `typeRef.schemaVersion` | `number` | required | — | Positive integer. Must match the type definition's version. |
| `immutableMetadata` | `object` | **required** | — | Metadata set once at creation and never changed. Contains `name` (string) and `definitionFile` (string). |
| `immutableMetadata.name` | `string` | required | — | Display name in the story's language. |
| `immutableMetadata.definitionFile` | `string` | required | — | Path to the defining YAML file, relative to project root. |
| `provenance` | `object` | optional | — | Source tracking. Contains `source` (string) and `hash` (string). |
| `provenance.source` | `string` | optional | — | Source of the entity (e.g. `user`, `compiler`, `migration`). |
| `provenance.hash` | `string` | optional | — | Content hash for change detection. |

### Entity Type Definition Fields (Catalog)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `typeRef` | `object` | required | — | As above. |
| `kind` | `enum` | required | — | `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"`. |
| `attributes` | `record` | required | — | Map of attribute IDs to `AttributeDefinition` (see below). |
| `lifecyclePolicy` | `object` | required | — | `allowedTransitions`: array of `[fromState, toState]` tuples. |
| `referenceCapabilities` | `object` | required | — | `defaultEligibility`: `"identity"`, `"live"`, or `"historical"`. |
| `typedInvariants` | `array` | required | — | Array of `{ id, description }`. |

### AttributeDefinition Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `attributeId` | `string` | required | — | Attribute name (e.g. `location`, `status`, `health`). |
| `valueSchema` | `ZodType` | required | — | Zod schema for valid values. |
| `requiredAt` | `enum` | required | — | `"introduction"`, `"activation"`, or `"never"`. |
| `writePolicy` | `enum` | required | — | `"immutable"`, `"write_once"`, `"mutable"`, or `"lifecycle_managed"`. |
| `allowedLifecycleStates` | `array` | optional | — | Array of `"active"`, `"inactive"`, `"retired"`. |
| `unsetAllowed` | `boolean` | required | — | Whether the attribute can be unset. |
| `semanticRole` | `string` | optional | — | Semantic annotation (e.g. `"identity"`, `"position"`). |
| `typedReferenceConstraint` | `object` | optional | — | Constrains value to reference a specific entity kind. Contains `targetKind` and optional `targetTypeId`. |

### Closed Enums

- `kind`: `"character"`, `"location"`, `"item"`, `"concept"`, `"faction"`, `"rule"` (6 values)
- `requiredAt`: `"introduction"`, `"activation"`, `"never"` (3 values)
- `writePolicy`: `"immutable"`, `"write_once"`, `"mutable"`, `"lifecycle_managed"` (4 values)
- `entityRuntimeState`: `"active"`, `"inactive"`, `"retired"` (3 values)
- `defaultEligibility`: `"identity"`, `"live"`, `"historical"` (3 values)

## Mutual Exclusions

- `entityId` must be unique across the entire declaration catalog.
- `provenance` is either fully present (both `source` and `hash`) or absent — partial provenance is rejected.
- `immutableMetadata` fields are set once; the compiler rejects update attempts.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/characters/xianglins_wife.yaml
entityId: xianglins_wife
typeRef:
  typeId: character
  schemaVersion: 1
immutableMetadata:
  name: "Xianglin's Wife"
  definitionFile: definitions/characters/xianglins_wife.yaml
```

## Invalid Example

```yaml
# ERROR: invalid kind, partial provenance, negative schemaVersion
entityId: xianglins_wife
typeRef:
  typeId: character
  schemaVersion: -1
kind: "protagonist"  # not in enum
immutableMetadata:
  name: "Xianglin's Wife"
  # missing required 'definitionFile'
provenance:
  source: "user"
  # missing required 'hash'
```

**Expected error:**
```
ConfigError at definitions/characters/xianglins_wife.yaml:4:3
  path: /typeRef/schemaVersion
  message: Expected positive integer, got -1

ConfigError at definitions/characters/xianglins_wife.yaml:6:3
  path: /kind
  message: Invalid enum value 'protagonist'. Expected one of 'character', 'location', 'item', 'concept', 'faction', 'rule'

ConfigError at definitions/characters/xianglins_wife.yaml:8:3
  path: /immutableMetadata/definitionFile
  message: Required

ConfigError at definitions/characters/xianglins_wife.yaml:11:5
  path: /provenance/hash
  message: Required
```

## Normalized Target

The compiler produces:

- `EntityTypeCatalog` — a versioned record of all registered entity types, each with fully-resolved attribute definitions and lifecycle policies.
- `EntityDeclarationCatalog` — a versioned record of all declared entity instances, each with its resolved type reference, metadata, and optional provenance.
- Entities are indexed by `entityId` for O(1) lookup.
- The compiler resolves `typeRef` against the type catalog at normalization time; a missing type reference is a fatal error.

## Source-Map Diagnostic Format

```
ConfigError at definitions/characters/<id>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
