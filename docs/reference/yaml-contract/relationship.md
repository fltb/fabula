# Relationship YAML Contract

**Current source:** `schemas/relationship.ts`, `entity/mapper.ts`, `state/narrative-baseline.ts`, `state/relationship-replay.ts`, and `state/event-application.ts`.

## Required source topology

```text
definitions/relationship-types.yaml
definitions/relationships/<relationshipId>.yaml
```

The type catalog is required and strict. Every key equals `typeId` and describes the permitted roles plus its continuity policy.

```yaml
types:
  mentor:
    typeId: mentor
    label: Mentor relationship
    roles:
      - roleId: mentor
        label: Mentor
        minCardinality: 1
        maxCardinality: 1
        allowedEntityKinds: [character]
      - roleId: student
        label: Student
        minCardinality: 1
        maxCardinality: 1
        allowedEntityKinds: [character]
    continuityImpact: new_epoch
```

A declaration file has the same ID as its filename:

```yaml
relationshipId: rel_mentor_student
typeId: mentor
initialEpoch:
  epochId: rel_mentor_student:epoch-1
  lifecycle: active
  memberships:
    - { membershipId: mentor-1, entityId: mentor, role: mentor }
    - { membershipId: student-1, entityId: student, role: student }
  dimensions:
    - { dimensionId: trust, scope: global, value: 40 }
```

Mapper preflight rejects file/ID mismatches, unknown types or entities, invalid role cardinality/kind, duplicate memberships, invalid scoped dimensions, and invalid declaration metadata.

## Event effects

Event YAML uses the canonical discriminated union directly:

```yaml
relationshipEffects:
  - type: relationship_transaction
    effectId: E1:mentor-trust
    relationshipId: rel_mentor_student
    epochId: rel_mentor_student:epoch-1
    membershipAfter:
      - { membershipId: mentor-1, entityId: mentor, role: mentor }
      - { membershipId: student-1, entityId: student, role: student }
    dimensionSet:
      - { dimensionId: trust, scope: global, value: 65 }
```

There is no binary `RelationshipChange` wire form or mapper conversion. A transaction updates a declared relationship with a complete membership replacement and scoped dimension writes/unsets. Direct lifecycle transitions are `active ↔ suspended`, `active → dissolved`, and `suspended → dissolved`.

A direct `dissolved → active` with the identical membership set is a retrospective restatement: the epoch remains terminal. A changed membership set is rejected. A genuine re-establishment is an `identity_transition` group that atomically closes declared epochs and creates a new epoch only for a `continuityImpact: new_epoch` type. Group validation occurs on a cloned map, so a failed closure, target, or carry map leaves state untouched.

## Runtime materialization and context

`materializeNarrativeBaseline()` creates every declared `RelationshipRuntimeState` before the first event, retaining type ID, epoch lifecycle, memberships, and scoped dimensions. Canonical replay receives the same declaration/type context and never synthesizes a `default` relationship type.

Context projection exposes the active epoch's lifecycle and dimension values for participating scenes. It does not cast runtime relationship state to the retired binary relationship shape.
