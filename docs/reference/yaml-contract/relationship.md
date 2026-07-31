# Relationship YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/relationship.ts` — `relationshipDefinitionSchema`, `relationshipRoleDefinitionSchema`, `relationshipTypeDefinitionSchema`, `membershipSchema`, `dimensionWriteSchema`, `dimensionUnsetSchema`, `relationshipTransactionSchema`, `identityTransitionCarryEntrySchema`, `relationshipIdentityTransitionGroupSchema`
**Replay enforcement:** `packages/core/src/state/relationship-replay.ts` (`applyRelationshipTransaction`)
**Fixture files:** `fixtures/zhu-fu/definitions/relationships/*.yaml`, `fixtures/arcane-aftermath/definitions/relationships/*.yaml`

Relationships are first-class entities that model n-ary connections between story entities. Each relationship has a **type** (structural blueprint), a **definition** (concrete instance with initial state), and a **transaction log** (epochs of change). Author-facing YAML lives in `definitions/relationships/`; events advance relationships through `relationshipEffects` (legacy binary `RelationshipChange` entries, converted to `RelationshipTransaction` at load).


## Fields
## RelationshipDefinition Fields (Author-Facing)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique relationship identifier (e.g. `narrator_xianglins_wife`). |
| `type` | `string` | **required** | — | Relationship type identifier (e.g. `witness_subject`, `professional_mentor_asset`). |
| `participants` | `tuple [string, string]` | **required** | — | Exactly two entity IDs that participate in the relationship (tuple enforced by Zod). |
| `bidirectional` | `boolean` | **required** | — | Whether the relationship is symmetric. |
| `initialState` | `object` | **required** | — | Initial dimension values. See sub-fields below. |
| `initialState.trust` | `number` | required | — | Trust level, bounded -100 to 100. |
| `initialState.emotionalDistance` | `number` | required | — | Emotional closeness, bounded 0 to 100 (0 = closest). |
| `initialState.intensity` | `number` | required | — | Relationship intensity, bounded 0 to 100. |
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
| `minCardinality` | `number` | required | — | Minimum number of entities in this role (nonnegative integer). |
| `maxCardinality` | `number` | required | — | Maximum number of entities in this role (integer ≥ 1). |
| `allowedEntityKinds` | `array` | required | — | Entity kinds allowed in this role (`["character"]`, etc.). |
| `exclusiveGroup` | `string` | optional | — | Mutually exclusive role group label. |

### Membership Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `membershipId` | `string` | required | — | Unique membership slot identifier. |
| `entityId` | `string` | required | — | Entity ID occupying this slot. |
| `role` | `string` | optional | — | Role label (from the type definition). |

### DimensionWrite Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `dimensionId` | `string` | required | — | Dimension being written. |
| `scope` | `enum` | required | — | `"global"`, `"role"`, `"member"`, `"subset"`, `"positional"`. |
| `value` | `unknown` | required | — | The dimension value. |
| `roleId` | `string` | optional | — | Role-scoped target. |
| `memberId` | `string` | optional | — | Member-scoped target. |
| `position` | `string` | optional | — | Positional target. |

`DimensionUnset` has the same fields minus `value`: `dimensionId`, `scope`, and the optional `roleId`/`memberId`/`position` scope selectors.

### RelationshipTransaction Fields (Event / Runtime)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `effectId` | `string` | required | — | Unique effect/transaction ID (e.g. `<eventId>_rel_<index>`). |
| `relationshipId` | `string` | required | — | Relationship being advanced. |
| `epochId` | `string` | optional | — | Target epoch; omitted for first establishment, required for subsequent writes. |
| `lifecycleAfter` | `enum` | optional | — | `"active"`, `"suspended"`, `"dissolved"`. |
| `membershipAfter` | `array` | required | — | Complete membership set after this transaction (full replacement). |
| `dimensionSet` | `array` | optional | — | Array of `DimensionWrite`. |
| `dimensionUnset` | `array` | optional | — | Array of `DimensionUnset`. |
| `provenance` | `string` | optional | — | Source trace (e.g. `compat:RelationshipChange:<effect>`). |

### IdentityTransitionCarryEntry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromDimensionId` | `string` | required | Source dimension. |
| `toDimensionId` | `string` | required | Target dimension. |
| `fromScope` | `enum` | required | Source scope. |
| `toScope` | `enum` | required | Target scope. |

`RelationshipIdentityTransitionGroup` is a **schema-only IR shape**: it declares `oldEpochClosures`, `newTransactions`, and an optional `carryMap` (`relationshipIdentityTransitionGroupSchema` / `RelationshipIdentityTransitionGroup`), but no replay code consumes it. `applyRelationshipTransaction` accepts a single `RelationshipTransaction` per call and there is no group dispatcher, so the group is a wire/type-level blueprint for a future atomic identity transition, not executable replay behavior.

## Closed Enums / IDs

- `relationshipTypeDefinition.continuityImpact`: `"preserve"`, `"new_epoch"`, `"new_relationship"` (3 values)
- `dimensionWrite.scope` / `dimensionUnset.scope`: `"global"`, `"role"`, `"member"`, `"subset"`, `"positional"` (5 values)
- `relationshipTransaction.lifecycleAfter`: `"active"`, `"suspended"`, `"dissolved"` (3 values)
- `initialState.trust`: number, min -100, max 100
- `initialState.emotionalDistance`: number, min 0, max 100
- `initialState.intensity`: number, min 0, max 100
- `minCardinality`: integer ≥ 0; `maxCardinality`: integer ≥ 1

## Mutual Exclusions & Enforcement

Schema-level:

- `participants` must contain exactly 2 entity IDs (tuple enforced by Zod).
- `establishedEvent` and `breakingEvent` are independent; a relationship can have both, one, or neither. `breakingEvent` without `establishedEvent` is valid (pre-established off-screen relationship).
- All relationship schemas are `.strict()`: unknown keys are rejected.

Replay-level (`applyRelationshipTransaction`, applied to `WorldState.relationships` when an event's `relationshipEffects` are replayed):

- A first establishment transaction providing neither `epochId` nor `lifecycleAfter` is a `ConfigError` (defaults `epochId ?? "<relId>_epoch_1"` / `lifecycleAfter ?? "active"` apply when one is provided).
- Duplicate `membershipId` within a transaction is a `ConfigError`.
- `membershipAfter` is a full replacement, not a merge.
- Epoch lifecycle transitions are validated: `active ↔ suspended`, `active → dissolved`, `suspended → dissolved`. `dissolved` is terminal.
- On an **existing** relationship/epoch, `dimensionUnset` of a dimension that does not exist in the epoch is a `ConfigError` (unset is applied before writes in the same transaction; `dimensionSet` and `dimensionUnset` may coexist). On first establishment the function applies `dimensionSet`, stores the relationship, and returns before reaching the unset loop — first-establishment `dimensionUnset` entries are currently ignored.

Event-level legacy form: event YAML `relationshipEffects` entries use the binary `RelationshipChange` shape (`participants: [string, string]`, `effect: establish | change | dissolve | reinforce | complicate`, `direction`, optional `newState: { type, intensity }`). The mapper converts each entry at load via `convertRelationshipChange` into a `RelationshipTransaction` with `relationshipId` `rel_<p1>_<p2>` (participants sorted), `epochId` `epoch_<p1>_<p2>_1`, memberships with `role: "member"`, `dimensionSet` for `direction`/`type`/`intensity`, `lifecycleAfter: "dissolved"` when `effect: dissolve`, and `provenance: "compat:RelationshipChange:<effect>"`.

## Valid Example

```yaml
# Structure of fixtures/zhu-fu/definitions/relationships/narrator_xianglins_wife.yaml
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
# ERROR: trust out of range, only one participant
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

**Expected error (standard loader — first issue only):**
```
error.message:      YAML schema validation failed at participants: Array must contain at least 2 element(s)
error.context.path: definitions/relationships/bad_relationship.yaml:participants
```

The thrown `ConfigError` has exactly these two properties: `message` holds the issue text, and the file-qualified location lives in `error.context.path` (the project-relative file path suffixed with the dot-joined Zod path). No second `path:` line is rendered.

## Normalized Target

- `RelationshipDefinition` instances are loaded into `ProjectData.relationships` (validated by `relationshipDefinitionSchema`). Participant IDs are stored as authored; there is no cross-validation against the entity catalog at load time.
- At runtime, each relationship advanced by an event's `relationshipEffects` lives in `WorldState.relationships` as a `RelationshipRuntimeState`: `relationshipId`, `typeId`, an `epochs` map (`EpochRuntimeState` with `lifecycle`, `memberships`, `dimensions`), and `activeEpochId` (unset while dissolved or between epochs).
- Context assembly derives `RelationshipContext` from the active epoch's memberships for events that include one of the participants.

## Source-Map Diagnostic Format

`readYamlFile` reports only the **first** validation issue, as two separate properties on the `ConfigError`:

- `error.message` — `YAML schema validation failed at <dot-joined path | <root>>: <Zod message>`
- `error.context.path` — the project-relative file path, suffixed with the dot-joined Zod path when the issue is not at the root

Zod issue paths are joined with dots (`participants.0.id`), not JSON Pointer syntax; a root-level issue reports `<root>` in the message and stores only the file path in `error.context.path`. Replay-time enforcement failures surface as `ConfigError` with phase `replay` and the offending `effectId`/relationship ID.
