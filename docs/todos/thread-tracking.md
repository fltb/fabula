# thread-tracking: Grey lines multi-point motif tracking

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S2 | [ ] | — | `docs/TODO.md` lines 213-217 |

## Group-level dependencies
None.

## Scope
Replace the `foreshadowing` binary model (seed → fulfillment) with `greyLines` — a multi-point structure where the same motif/image appears across multiple events, accumulating different semantic meaning at each node. Node list grows indefinitely; closure is not required. This replaces the foreshadowing validator (deprecate, not delete) with a new `GreyLineValidator`.

## Sub-plan

### S2: greyLines — multi-point motif tracking

**Scope**: Types → schemas → EventFile extension → Pass 2 integration → validator.

**New files**:
- `packages/core/src/types/grey-line.ts` — `GreyLineNode`, `GreyLine` types
- `packages/core/src/schemas/grey-line.ts` — Zod schemas
- `packages/core/src/validator/grey-line.ts` — `GreyLineValidator`
- `packages/core/tests/validator/grey-line.test.ts` — test suite

**Modified files**:
- `packages/core/src/types/event.ts` — add `greyLines?: GreyLine[]` to `EventFile`
- `packages/core/src/schemas/event.ts` — add `greyLines` to `eventFileSchema`
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export
- `packages/core/src/validator/index.ts` — register `GreyLineValidator`, deprecate `ForeshadowValidator`

**Binding constraints**:
1. Types:
   ```typescript
   export interface GreyLineNode {
     eventId: string;
     semanticAccumulation: string;   // what new meaning this appearance adds
     narrativeOrder: number;
   }
   export interface GreyLine {
     id: string;
     imagery: string;                 // the motif/image (e.g. "花", "镜", "玉")
     nodes: GreyLineNode[];           // appearances across events, growing list
   }
   ```
2. Each event can declare which grey lines it participates in via `greyLines` field, providing its node's `semanticAccumulation`
3. Validator checks:
   - Each node references a valid `eventId` (existing in the project)
   - Imagery text appears in the scene prose (via Pass 2 analysis — add `imageryAppeared: string[]` to Pass 2 result, or reuse `narrativeChecks`)
   - No duplicate nodes for the same event within a grey line
   - Does NOT require closure — nodes can grow indefinitely (this is the key difference from foreshadowing's binary seed→fulfillment model)
4. ForeshadowValidator: deprecated but NOT deleted. `foreshadowing` type/schema remain for backward compatibility. `GreyLineValidator` is the forward path
5. Multi-event tracking: StateManager or a dedicated tracker accumulates `greyLines` across events. The validator reads the accumulated state, not just per-event declarations

**Acceptance**: `npx vitest run packages/core/tests/validator/grey-line.test.ts` passes. At least one zhu-fu or dream-of-red-chamber event uses `greyLines` in its YAML fixture, with nodes spanning at least 2 events, and passes GreyLineValidator.

## Evidence
—
