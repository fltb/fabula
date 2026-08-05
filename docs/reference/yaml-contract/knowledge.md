# Knowledge / Proposition YAML Contract

**Current source:** `schemas/knowledge.ts`, `schemas/event.ts`, `entity/mapper.ts`, `state/narrative-baseline.ts`, `state/knowledge-replay.ts`, and `state/event-application.ts`.

## Required source topology

```text
definitions/propositions.yaml
definitions/state_initial.yaml   # knowledge claims and common ground
chapters/chapter_NN/E*.yaml      # knowledgeTransactions
```

`propositions.yaml` is a required strict catalog. Keys equal proposition IDs and its dependency graph must be acyclic.

```yaml
version: 1
propositions:
  p_hero_location:
    kind: grounded
    id: p_hero_location
    entityId: hero
    attribute: location
    value: citadel
    factId: hero.location
dependencyGraph:
  p_hero_location: []
```

Initial knowledge belongs in `state_initial.yaml`:

```yaml
knowledge:
  claims:
    - subject: hero
      propositionId: p_hero_location
      assessment: { type: settled, grade: know, polarity: affirmative }
      evidence:
        - source: direct_experience
          provenance: [system:initial]
          acquiredAt: day_0
  commonGround:
    - propositionId: p_hero_location
      participants: [hero, guide]
      establishedAt: day_0
```

## Event effects

Event files can write explicit knowledge transactions:

```yaml
knowledgeTransactions:
  - type: information_act
    actType: testimony
    actor: guide
    recipients: [hero]
    contentPropositions: [p_hero_location]
    timestamp: day_1
  - type: claim_write
    subject: hero
    propositionId: p_hero_location
    assessment: { type: settled, grade: know, polarity: affirmative }
    evidence:
      - source: testimony
        provider: guide
        provenance: [E1]
        acquiredAt: day_1
```

The mapper parses authored timestamps once and stamps information acts with the event ID. `applyNarrativeEvent()` validates proposition references, writes claims through `applyClaimTransaction`, appends acts through `recordInformationAct`, and records common ground. Unknown propositions and duplicate claim-cell writes fail closed.

## Runtime materialization

`materializeNarrativeBaseline()` clones the proposition catalog and constructs the indexed `EpistemicLedger` plus common-ground records before any event replay. The canonical state boundary is therefore the input to `KnowledgeValidator`, relevance scoring, and the POV knowledge projection.

`Fact` writes remain entity-state writes. They do not implicitly invent propositions or claims; model epistemic state with the explicit catalog and transactions above.

## Runtime model

- `PropositionCatalog`: immutable version-1 catalog of grounded, epistemic, act, or intensional propositions.
- `EpistemicLedger`: claims keyed by `${subject}:${propositionId}`, subject/proposition indexes, and ordered information-act log.
- `CommonGroundRecord`: explicit proposition, participants, timestamp, and establishing event.

`evaluate()` provides deterministic three-valued proposition evaluation. Intensional propositions intentionally have no world-truth evaluation.
