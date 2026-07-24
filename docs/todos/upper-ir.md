# upper-ir: Idea IR + Story IR (missing upper IR layers)

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S7a | [ ] | — | `docs/TODO.md` lines 285-292; `docs/reference/stage-3/ir-layer-narratology-mapping.md` §1 (lines 26-34) |
| S7b | [ ] | — | `docs/TODO.md` lines 285-292; `docs/reference/stage-3/ir-layer-narratology-mapping.md` §2 (lines 38-48) |

## Group-level dependencies
None — both IR layers are independent. They do not depend on each other.

## Scope
Two upper IR layers that were designed in `PROJECT.md` but never implemented. S7a (Idea IR): Aristotelian Mythos — thematic intent, emotional arc at the whole-work level (not per-scene). S7b (Story IR): Propp 31 functions + Greimas actant model — structural function labels on narrative events. The Thread system is the natural starting point for S7b (threads already track goal-oriented narrative progress; now they carry structural function labels).

## Sub-plan

### S7a: Idea IR — Aristotelian Mythos (thematic intent)

**Scope**: New types + schemas for whole-work thematic intent. Project-level (not per-event). The system currently has `emotionalValence`/`conflictType` per-scene but no overall thematic layer.

**New files**:
- `packages/core/src/types/idea-ir.ts` — `ThematicIntent`, `EmotionalArcDefinition`, `IdeaIR` types
- `packages/core/src/schemas/idea-ir.ts` — Zod schemas
- `packages/core/tests/schema/idea-ir.test.ts` — schema validation tests

**Modified files**:
- `packages/core/src/schemas/project.ts` — add `ideaIR?: IdeaIR` to project schema
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export

**Binding constraints**:
1. Types:
   ```typescript
   export interface ThematicIntent {
     primaryTheme: string;          // e.g. "革命吞噬它的孩子"
     subThemes: string[];
   }
   export interface EmotionalArcDefinition {
     arcType: string;               // e.g. "tragedy", "bildungsroman", "redemption"
     emotionalBeats: { position: string; emotion: string }[];  // per arcPosition
   }
   export interface IdeaIR {
     thematicIntent: ThematicIntent;
     emotionalArc: EmotionalArcDefinition;
     targetAudience?: string;
     coreConflict?: string;
   }
   ```
2. Project-level — declared once per project YAML, not per event
3. `emotionalBeats` map to `arcPosition` values (opening/rising/climax/falling/denouement) — they describe the intended emotional arc across the whole work
4. This is distinct from per-event `emotionalValence` — Idea IR is the intended macro-level arc, while event-level valence is the micro-level execution
5. Optional: projects without Idea IR are valid (backward compat); the type is additive

**Acceptance**: Types exported. Schema validates. At least one fixture project YAML (e.g. dream-of-red-chamber) includes `ideaIR` with `primaryTheme` and `emotionalBeats`. `npx vitest run packages/core/tests/schema/idea-ir.test.ts` passes.

### S7b: Story IR — Propp 31 functions + Greimas actant model

**Scope**: New types for structural function labeling. Thread system extension — threads carry structural function labels. No new event-level types needed; threads already track goal-oriented narrative progress.

**New files**:
- `packages/core/src/types/story-ir.ts` — `StructuralFunction`, `ActantModel`, `StoryArchetype` types
- `packages/core/src/schemas/story-ir.ts` — Zod schemas
- `packages/core/tests/schema/story-ir.test.ts` — schema validation tests

**Modified files**:
- `packages/core/src/types/thread.ts` — add optional `structuralFunction?: StructuralFunction` + `actantModel?: ActantModel` to `ThreadTypeDefinition`
- `packages/core/src/schemas/thread.ts` — add to thread schema
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export

**Binding constraints**:
1. Types:
   ```typescript
   export type StructuralFunction =
     | 'absentation' | 'interdiction' | 'violation' | 'departure'
     | 'first_function_of_donor' | 'hero_reaction' | 'acquisition'
     | 'spatial_translocation' | 'villainy' | 'mediation' | 'beginning_counteraction'
     | 'first_villainy' | 'hero_departure' | 'donor_test' | 'hero_reaction_donor'
     | 'receipt_of_agent' | 'guidance' | 'arrival' | 'unrecognized_arrival'
     | 'unfounded_claims' | 'difficult_task' | 'solution' | 'recognition'
     | 'exposure' | 'punishment' | 'wedding';   // Propp 31 functions (subset, extensible)

   export interface ActantModel {
     subject: string;      // hero
     object: string;       // quest/goal
     sender: string;       // dispatcher
     receiver: string;     // beneficiary
     helper: string;       // ally
     opponent: string;     // villain/obstacle
   }

   export type StoryArchetype = 'hero_journey' | 'tragedy' | 'quest' | 'descent' | 'rebirth' | 'comedy';
   ```
2. Thread extension: `ThreadTypeDefinition` gets optional `structuralFunction` (Propp function label) and optional `actantModel` (Greimas actant role assignment). This is the "thread system is the natural starting point" insight — threads already track goal-oriented narrative progress; labeling them with structural functions is a low-cost first step
3. `StructuralFunction` is extensible (the Propp subset is a starting point, not a closed set)
4. Optional: threads without structural labels are valid (backward compat)

**Acceptance**: Types exported. Schema validates. At least one fixture thread YAML includes `structuralFunction` and/or `actantModel`. `npx vitest run packages/core/tests/schema/story-ir.test.ts` passes.

## Evidence
—
