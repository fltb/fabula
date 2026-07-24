# planner: Forward event generation layer

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S8 | [ ] | — | `docs/TODO.md` lines 294-315; `docs/reference/stage-3/planner-layer-analysis.md` §5 (lines 267-353), §6 (lines 356-426) |

## Group-level dependencies
None — Planner is a self-contained new subsystem.

## Scope
A forward event generation layer that consumes WorldState + goals + arc position → produces candidate events. Currently all events are hand-written YAML; this is the "every event needs external input" bottleneck. Three modes: manual (precondition validation), suggest (system proposes candidates, author selects), auto (system generates event chains — research-grade, deferred). The first implementation covers manual + suggest modes with deterministic rules (no LLM required for suggest); auto mode is deferred.

**Critical distinction**: `PlannerMode` in `render/surface-planner.ts` is a SURFACE rendering grouping strategy, NOT narrative event planning. This planner is a new subsystem that does not conflict with or replace surface planning.

## Sub-plan

### S8: Planner — forward event generation

**Scope**: Types → schemas → planner pipeline (manual + suggest modes). Auto mode deferred to research-grade.

**New files**:
- `packages/core/src/types/planner.ts` — `NarrativePlannerMode`, `NarrativeGoal`, `ActionDefinition` types
- `packages/core/src/schemas/planner.ts` — Zod schemas
- `packages/core/src/state/narrative-planner.ts` — planner pipeline implementation
- `packages/core/tests/state/narrative-planner.test.ts` — test suite

**Modified files**:
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export

**Binding constraints**:
1. Types:
   ```typescript
   export type NarrativePlannerMode = 'manual' | 'suggest' | 'auto';

   export interface NarrativeGoal {
     goalId: string;
     threadId: string;
     description: string;
     type: 'achieve' | 'maintain' | 'avoid' | 'resolve';
     priority: number;
     preconditions?: Fact[];
     successCondition: {
       entity: string;
       attribute: string;
       operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'exists';
       value: unknown;
     };
     suggestedEvents?: string[];
   }

   export interface ActionDefinition {
     actionId: string;
     name: string;
     description: string;
     preconditions: Precondition[];
     effects: Effect[];
     narrativeTags: string[];
     typicalDuration: number;
     typicalArcPositions: string[];
     conflictTypes?: string[];
     resolutionTypes?: string[];
     relatedThreadTypes?: string[];
   }
   ```
2. **Manual mode**: Author writes event YAML → system validates preconditions against current WorldState → warning if unsatisfied. This is precondition validation, not generation
3. **Suggest mode** (deterministic rules, no LLM):
   - Query active goals: `thread.goalStates[goalId] === 'active'`
   - For each active goal, find `ActionDefinition` entries whose preconditions match current WorldState
   - Rank candidates by: arcPosition match + thread priority + storyTime continuity
   - Return top-K candidate events (event brief + preconditions + expected postconditions + thread advancement)
   - LLM for sceneBrief generation is a later enhancement, not in first version
4. **Auto mode**: Research-grade — NOT in initial scope. Marked deferred
5. Consumes: WorldState (`types/world.ts`), ThreadRuntimeState (`types/thread.ts`), arcPosition (on NarrativeEvent), RuleRuntimeState (`types/rule.ts`)
6. Does NOT consume: `PlannerMode` in `render-surface.ts` (that's surface grouping, confirmed by planner doc §2)
7. `NarrativeGoal` is distinct from thread's `GoalLifecycle` — it adds `successCondition` (verifiable WorldState predicate) and `priority` (multi-goal decision)
8. `ActionDefinition` is a new catalog type — the action space definition that tells the planner what events are possible

**Acceptance**: `npx vitest run packages/core/tests/state/narrative-planner.test.ts` passes. Manual mode: given an event YAML with unsatisfied preconditions, produces warning. Suggest mode: given WorldState + active goals, produces ranked candidate events. All tests use deterministic rules (no LLM dependency).

## Evidence
—
