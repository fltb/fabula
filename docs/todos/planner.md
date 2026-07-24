# planner: Forward event generation layer

## Group Status: [x] complete (design assumption invalid for current system — see correction)

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S8 | [x] | — | `docs/TODO.md` lines 294-315; `docs/reference/stage-3/planner-layer-analysis.md` §5 (lines 267-353), §6 (lines 356-426) |

## Group-level dependencies
None — Planner is a self-contained new subsystem.

> **2026-07-24 设计修正**: S8 的原始设计假设（"前向事件生成——WorldState → Planner → 候选事件"）与当前系统架构不兼容。本系统的 Novel IR 输入是已完成的小说——事件全部已发生，YAML 建模的是"发生了什么"而非"下一步该写什么"。Planner 是面向生成式写作工具的设计，不是面向已完成小说的结构化建模系统。如未来需要，正确方向是独立的 **YAML 编辑器模块**——读已有小说原文，LLM 辅助人工写成稳定的 YAML（precondition 不遗漏、thread 不丢失、Fact 不对冲）。现有代码（NarrativeGoal + ActionDefinition 类型、validatePreconditions、suggestEvents、18 个测试）保留作为参考实现。
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
