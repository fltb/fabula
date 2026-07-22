# Relationship YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/relationship.ts` — `relationshipDefinitionSchema`, `relationshipRoleDefinitionSchema`, `relationshipTypeDefinitionSchema`, `membershipSchema`, `dimensionWriteSchema`, `dimensionUnsetSchema`, `relationshipTransactionSchema`, `relationshipIdentityTransitionGroupSchema`  
**Fixture files:** `fixtures/zhu-fu/definitions/relationships/*.yaml`, `fixtures/arcane-aftermath/definitions/relationships/*.yaml`

Relationships are first-class entities that model n-ary connections between story entities. Each relationship has a **type** (structural blueprint), a **definition** (concrete instance with initial state), and a **transaction log** (epochs of change). Author-facing YAML lives in `definitions/relationships/`.


## Fields
## RelationshipDefinition Fields (Author-Facing)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique relationship identifier (e.g. `narrator_xianglins_wife`). |
| `type` | `string` | **required** | — | Relationship type identifier (e.g. `witness_subject`, `professional_mentor_asset`). |
| `participants` | `tuple [string, string]` | **required** | — | Exactly two entity IDs that participate in the relationship. |
| `bidirectional` | `boolean` | **required** | — | Whether the relationship is symmetric. |
| `initialState` | `object` | **required** | — | Initial dimension values. See sub-fields below. |
| `initialState.trust` | `number` | required | — | Trust level, integer from -100 to 100. |
| `initialState.emotionalDistance` | `number` | required | — | Emotional closeness, integer from 0 to 100 (0 = closest). |
| `initialState.intensity` | `number` | required | — | Relationship intensity, integer from 0 to 100. |
| `initialState.status` | `string` | required | — | Narrative status label (e.g. `"stranger_encounter"`, `"active"`). |
| `initialState.notes` | `string` | optional | `undefined` | Prose description of the relationship context. |
| `establishedEvent` | `string` | optional | `undefined` | Event ID where the relationship was established (e.g. `E0`). |
| `breakingEvent` | `string` | optional | `undefined` | Event ID where the relationship was broken/ended. |

## RelationshipTypeDefinition Fields (Catalog)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `typeId` | `string` | required | — | Unique type identifier. |
| `label` | `string` | required | — | Human-readable label. |
| `description` | `string` | optional | — | What this relationship type represents. |
| `roles` | `array` | required | — | Array of `RelationshipRoleDefinition`. |
| `continuityImpact` | `enum` | required | — | `"preserve"`, `"new_epoch"`, or `"new_relationship"`. |

### RelationshipRoleDefinition Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `roleId` | `string` | required | — | Unique role identifier within the type. |
| `label` | `string` | required | — | Display label (e.g. `"mentor"`, `"protégé"`). |
| `minCardinality` | `number` | required | — | Minimum number of entities in this role. |
| `maxCardinality` | `number` | required | — | Maximum number of entities in this role. |
| `allowedEntityKinds` | `array` | required | — | Entity kinds allowed in this role (`["character"]`, etc.). |
| `exclusiveGroup` | `string` | optional | — | Mutually exclusive role group label. |

### Membership Fields (Transaction)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `membershipId` | `string` | required | — | Unique membership slot identifier. |
| `entityId` | `string` | required | — | Entity ID occupying this slot. |
| `role` | `string` | optional | — | Role label (from the type definition). |

### Closed Enums

- `relationshipTypeDefinition.continuityImpact`: `"preserve"`, `"new_epoch"`, `"new_relationship"` (3 values)
- `dimensionWrite.scope` / `dimensionUnset.scope`: `"global"`, `"role"`, `"member"`, `"subset"`, `"positional"` (5 values)
- `relationshipTransaction.lifecycleAfter`: `"active"`, `"suspended"`, `"dissolved"` (3 values)
- `initialState.trust`: integer, min -100, max 100
- `initialState.emotionalDistance`: integer, min 0, max 100
- `initialState.intensity`: integer, min 0, max 100

## Mutual Exclusions

- `participants` must contain exactly 2 entity IDs (tuple enforced by Zod).
- `bidirectional: false` requires ordered participants (role semantics).
- `establishedEvent` and `breakingEvent` are independent; a relationship can have both, one, or neither.
- `breakingEvent` without `establishedEvent` is valid (pre-established off-screen relationship).
- `dimensionWrite` and `dimensionUnset` are mutually exclusive in a single transaction — use separate transactions for setting and unsetting dimensions.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/relationships/narrator_xianglins_wife.yaml
id: narrator_xianglins_wife
type: witness_subject
participants:
  - narrator
  - xianglins_wife
bidirectional: false
initialState:
  trust: 0
  emotionalDistance: 80
  intensity: 30
  status: "stranger_encounter"
  notes: "The narrator meets Xianglin's Wife once by the river."
establishedEvent: E0
breakingEvent: E1
```

## Invalid Example

```yaml
# ERROR: trust out of range, only one participant, missing initialState
id: bad_relationship
type: witness_subject
participants:
  - narrator
bidirectional: false
initialState:
  trust: 150      # exceeds max 100
  emotionalDistance: -5  # below min 0
  intensity: 50
  status: "active"
```

**Expected error:**
```
ConfigError at definitions/relationships/bad_relationship.yaml:7:3
  path: /participants
  message: Expected array of length 2, got 1

ConfigError at definitions/relationships/bad_relationship.yaml:10:11
  path: /initialState/trust
  message: Number must be less than or equal to 100

ConfigError at definitions/relationships/bad_relationship.yaml:11:11
  path: /initialState/emotionalDistance
  message: Number must be greater than or equal to 0
```

## Normalized Target

The compiler produces:

- `RelationshipTypeCatalog` — indexed by `typeId`, with fully-resolved role definitions and continuity policies.
- `RelationshipDefinition` instances indexed by `id`, each with:
  - Resolved type reference
  - Participant entity IDs (validated to exist in entity catalog)
  - Initial dimension values with bounded number checks
  - Epoch timeline (established/breaking event references)
- `RelationshipTransaction` log entries for each epoch change event in the story.

## Source-Map Diagnostic Format

```
ConfigError at definitions/relationships/<id>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
