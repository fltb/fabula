# Annotation Guidelines

**Version:** 1.0
**Date:** 2026-07-22
**Status:** Frozen before scoring

**Source files:**
- `packages/bench/src/annotation-sampler.ts` — Sample selection protocol
- `packages/bench/src/annotation-stats.ts` — Statistical analysis
- `packages/core/src/validator/*.ts` — 20 validators with defined severity levels
- `packages/core/src/types/validator.ts` — ValidationIssue, Validator types
- `packages/core/src/state/capability-manifest.ts` — Capability manifest with S/C/X status

**Related documents:**
- `docs/TODO.md` L77-102 — Acceptance criteria for human evaluation
- `docs/reference/validators.md` — Complete validator reference
- `docs/reference/bench.md` — Benchmark and metric definitions

This document defines the annotation guidelines for human evaluation of Novalistically-generated narrative prose. It is frozen before any scoring begins, in accordance with TODO.md L79. Every annotation produced during the evaluation rounds must follow these guidelines; any deviation must be recorded in the annotation provenance metadata.

---

## 1. Problem-Level Annotation

Each validator issue detected during L1 (pre-render) or L2 (post-render) validation is annotated on two independent ordinal scales: **severity** and **repair priority**. These are separate judgments and are recorded as separate fields per issue.

### 1.1 Severity Scale

Severity measures the **impact on narrative coherence, consistency, or reader comprehension** caused by the issue.

| Level | Label | Meaning |
|-------|-------|---------|
| 4 | `blocker` | Issue that makes the rendered prose fundamentally incoherent, contradictory, or unreadable |
| 3 | `high` | Issue that substantially degrades narrative quality or creates notable contradictions |
| 2 | `medium` | Issue that is noticeable but does not prevent understanding or flow |
| 1 | `low` | Minor imperfection, stylistic quirk, or edge case with minimal reader impact |

#### 1.1.1 Blocker — Definition and Examples

**Definition:** The issue renders the scene or passage incomprehensible, internally contradictory on a core fact, or violates an invariant that breaks the causal chain. A reader encountering this would be confused or forced to re-read extensively.

**Examples:**
- A dead character appears and speaks without any resurrection event or explanation (CharacterStateValidator error-level violation).
- The POV character refers to knowledge they explicitly cannot have (KnowledgeValidator error — e.g., a first-person narrator in 1920 describes a 1930 event).
- prose states "A kills B" in a scene where the causal model asserts B kills A.
- Two contradictory statements about the same core fact in adjacent paragraphs (e.g., "She was wearing a red dress. Her blue dress fluttered in the wind.").
- A placeholder value such as `changed` or `resolved` is rendered literally in the prose.

**Decision rules:**
- Blockers ALWAYS correspond to validator errors (never warnings or infos).
- If the issue breaks the causal chain irrecoverably, it is a blocker.
- If the issue requires the reader to guess what actually happened, it is a blocker.
- If reasonable readers could disagree on what happened, it is NOT a blocker (downgrade to high or medium).

**Boundary cases:**
- A single wrong date ("June 32nd") in an otherwise correct timeline → `high` (not blocker, reader can infer) unless the date is plot-critical.
- A character's name misspelling that changes meaning ("Mary" vs "Merry") → `medium` unless the misspelling causes identity confusion with another character.

#### 1.1.2 High — Definition and Examples

**Definition:** A clear, noticeable defect that degrades the reading experience. The reader notices something wrong but can still understand what was intended.

**Examples:**
- Timeline inconsistency where a character is in two places on the same day without travel time accounted for (TimelineValidator error).
- Voice drift: a character uses vocabulary or speech patterns inconsistent with their established voice (VoiceDriftDetector warning or error).
- Pronoun gender mismatch for a known character (PronounValidator warning).
- A foreshadowed reveal that never happens (ForeshadowingValidator error).
- Invented detail that contradicts established world rules (FactualDetailValidator error for major contradictions).

**Decision rules:**
- High severity issues are noticeable to a typical reader without close analysis.
- The passage remains comprehensible but the flaw is clearly identifiable.
- Multiple `medium` issues in the same scene MAY be elevated to `high` if their combined effect is greater than the sum of individual impacts.

**Boundary cases:**
- An invented detail that adds plausible new information without contradicting canon → `low` or `medium` (not high).
- A scene pacing that feels rushed but is still coherent → `medium` (not high).

#### 1.1.3 Medium — Definition and Examples

**Definition:** A detectable but non-disruptive issue. The reader may notice it but it does not meaningfully harm comprehension or narrative flow.

**Examples:**
- An alias used that is not in the character's registered aliases (AliasValidator warning).
- A discourse balance exceeding the 80% threshold for a single mode (DiscourseBalanceValidator info).
- A thread progress declared but not clearly achieved in prose (ThreadProgressValidator warning).
- Conflict resolution type mismatch where the stated type does not match the prose (ConflictValidator info).
- A minor invented detail that does not contradict established facts (FactualDetailValidator warning).

**Decision rules:**
- Medium issues are those that a quality-sensitive reader would spot but a casual reader would likely miss.
- Most warnings from validators default to `medium` unless the specific instance has higher impact.
- If the issue requires knowledge of the internal narrative model to detect, it is likely `medium` or below.

**Boundary cases:**
- A quality score below threshold with a vague weakness list (QualityValidator warning) → `medium`.
- A knowledge leak of a trivial, non-plot fact → `medium` (not high).

#### 1.1.4 Low — Definition and Examples

**Definition:** A minor imperfection or stylistic issue. The passage is fully functional and the issue is unlikely to be noticed except on close inspection.

**Examples:**
- A single pronoun inconsistency in a complex scene with many characters where context disambiguates (PronounValidator info).
- A very minor pacing deviation within acceptable bounds (PacingValidator info).
- A subtle redundancy in prose description.
- A scene setting described with slightly inconsistent sensory detail (e.g., "cold wind" followed by "warm breeze" in paragraphs separated by substantial intervening text).
- An info-level validator note that identifies a potential edge case not triggered in this instance.

**Decision rules:**
- Low issues are those that an annotator would only flag after careful re-reading.
- Info-level validator outputs default to `low` unless elevated by specific context.
- If multiple low issues cluster in one passage, consider whether their combined effect merits `medium`.

**Boundary cases:**
- A positive quality signal flagged as a false positive (e.g., LLM reports a problem that does not exist) → `low` (annotation notes the discrepancy, but the issue is informational).
- A formatting inconsistency in punctuation (Chinese vs English quotation marks mixed) → `low`.

#### 1.1.5 Cannot Determine Handling

When an annotator cannot confidently assign a severity level, the following rules apply:

1. **Missing context:** If the issue involves a character, event, or relationship not yet established in the narrative up to that point, annotate as `medium` and add a provenance note: `severity: uncertain — insufficient context`.
2. **Ambiguous prose:** If the prose is genuinely ambiguous (two equally plausible readings), annotate the more severe reading but add a provenance note: `severity: ambiguous — pessimistic reading assigned`.
3. **Tool error:** If the annotation tool (sampler display, validator output) malfunctions or presents corrupted data, mark the issue as `cannot_determine` with provenance note `tool_error: <description>`. This issue is excluded from reliability analysis but counted in the annotation record.
4. **Language proficiency limit:** If the annotator cannot assess the issue due to language limitations (the document specifies Chinese-only annotation per TODO L102; if English samples are inadvertently included, skip and mark `not_applicable`).
5. **Intervention threshold:** If >10% of issues in a single annotation session are marked `cannot_determine`, the session must be reviewed for systemic ambiguity in the guidelines or annotation tooling before proceeding.

### 1.2 Repair Priority Scale

Repair priority measures the **urgency of fixing the issue before the narrative is considered publication-ready**. This is independent of severity: a low-severity issue might have high repair priority if it is easy to fix and visibly harms quality, while a high-severity issue might have low repair priority if fixing it would require restructuring the entire causal model.

| Level | Label | Meaning |
|-------|-------|---------|
| 4 | `blocker` | Must fix before the narrative can be used or evaluated further |
| 3 | `high` | Should fix before the next evaluation or release |
| 2 | `medium` | Nice to fix; scheduled but non-critical |
| 1 | `low` | Optional; fix only if other changes touch the same area |

#### 1.2.1 Blocker Repair Priority

**Definition:** The issue prevents the scene from being included in any deliverable. No workaround exists.

**Examples:**
- A scene rendered with prose that contradicts the causal model on a core plot point.
- Missing or empty prose for a required narrative event.
- A validation error that blocks assembly (e.g., DagCycleError that prevents topological sort).
- A literal placeholder value (`changed`, `resolved`) present in published prose.

**Decision rules:**
- Blocker repair = the issue must be resolved before the current scene can be used for any purpose.
- If the issue requires a source text YAML change, it is at least `high` repair priority (may be `blocker` if it blocks assembly).

#### 1.2.2 High Repair Priority

**Definition:** The issue should be resolved before the next benchmarking run or publication round.

**Examples:**
- A character voice drift that is noticeable but does not break comprehension.
- A timeline inconsistency of a non-critical plot point.
- An invented detail that contradicts established world rules (error level).
- A knowledge leak of a minor plot point.

**Decision rules:**
- High repair priority issues are expected to be addressed in the next iteration.
- If the issue would cause a regression in any measured metric (CED, F1), it is at least `high` repair priority.

#### 1.2.3 Medium Repair Priority

**Definition:** The issue should be tracked and fixed when convenient, but does not block progress.

**Examples:**
- Minor alias inconsistencies (character name variants not registered).
- Discourse balance warnings (single mode near 80% threshold but not exceeding).
- Thread progress not fully achieved in prose (warnings).
- Invented details that are plausible and non-contradictory.

**Decision rules:**
- Medium repair issues are those that improve quality but do not affect metric scores meaningfully.
- If fixing the issue would require disproportionate effort relative to the quality gain, it may remain `medium` even if severity is `high`.

#### 1.2.4 Low Repair Priority

**Definition:** The issue is cosmetic or theoretical. Fixing is optional.

**Examples:**
- A minor pronoun inconsistency where context disambiguates.
- Very subtle pacing deviations.
- Redundant descriptive phrases.
- Verifier info notes about unused potential edge cases.

**Decision rules:**
- Low repair issues are typically `info`-level validator outputs.
- If no reader would notice, the repair priority is `low`.

#### 1.2.5 Relationship Between Severity and Repair Priority

Severity and repair priority are independent dimensions. Annotators must assign both independently. Common patterns:

| Severity | Repair Priority | Interpretation |
|----------|----------------|----------------|
| blocker | blocker | Critical failure requiring immediate fix |
| high | high | Notable defect that should be fixed soon |
| high | medium | Serious issue that is expensive/hard to fix |
| medium | high | Easy fix for noticeable quality improvement |
| low | low | Cosmetic, deferrable |

The annotation tool records both values separately. No automatic derivation from one to the other is permitted.

---

## 2. Scene-Level Quality Annotation

Each selected scene (rendered prose passage for a single `NarrativeEvent`) receives a **holistic quality rating** on a 4-level ordinal scale, plus an optional **justification**.

### 2.1 Quality Scale

| Level | Label | Meaning |
|-------|-------|---------|
| 4 | `excellent` | Flawless or near-flawless; publication-ready prose with strong narrative flow |
| 3 | `good` | Solid prose with minor issues; readable and coherent but with room for improvement |
| 2 | `acceptable` | Functional but clearly flawed; the narrative intent is communicated but quality is below bar |
| 1 | `poor` | Significant problems; the scene fails to communicate the intended narrative effectively |

### 2.2 Excellent — Definition and Examples

**Definition:** The prose is engaging, coherent, and consistent with the narrative model. A reader would not notice any issues. The scene achieves its narrative purpose (as defined by the event's sceneBrief, preconditions, and postconditions) with style and fluency.

**Positive examples:**
- Prose that accurately reflects all deterministic preconditions and postconditions.
- Character voice is consistent with established definitions.
- POV perspective is maintained throughout.
- Temporal flow is logical and consistent.
- Dialogue attribution is clear and natural.
- The scene's emotional tone matches the event's sceneType and pacing arc position.

**Decision rules:**
- Excellent scenes have ZERO blocker or high severity issues.
- An excellent scene may have 0-1 low severity issues.
- The prose must demonstrably satisfy the event's narrative intent (sceneBrief + causal model).
- The scene must work as standalone prose (a reader unfamiliar with the causal model can follow it).

### 2.3 Good — Definition and Examples

**Definition:** Competent prose that delivers the narrative intent. Some minor or moderate issues exist but do not prevent comprehension or enjoyment.

**Positive examples:**
- Prose that correctly implements the causal model with minor stylistic imperfections.
- Mostly consistent character voice with one or two slight deviations.
- Clear narrative flow but some sentences could be more elegant.
- All necessary information is present; no gaps in the reader's understanding.

**Negative examples:**
- A scene with 2-3 medium-severity issues but no high or blocker issues.
- Minor pacing issues (e.g., a scene that feels slightly rushed or slightly padded).
- One instance of voice drift that is not severe.

**Decision rules:**
- Good scenes have NO blocker or high severity issues.
- A good scene may have up to 3 medium issues or up to 5 low issues.
- If the scene's quality score from the LLM evaluation (QualityValidator) is below threshold, the scene CANNOT be rated `excellent` (may be `good` if the weakness list is minor).

### 2.4 Acceptable — Definition and Examples

**Definition:** The scene communicates its narrative purpose but with clear, noticeable flaws. A reader would understand what happened but would also notice problems.

**Positive examples:**
- The causal model is correctly reflected in prose, but prose quality is mediocre.
- All key events from the event definition appear in prose, but pacing or coherence suffers.
- The scene is functional: a reader could summarize what happened correctly.

**Negative examples:**
- A scene with 1 high-severity issue (but no blocker issues).
- Multiple medium issues that collectively degrade readability.
- A scene where the prose quality score is significantly below threshold.
- A scene where character voice is inconsistent but still identifiable.

**Decision rules:**
- Acceptable scenes may have 1 high-severity issue but NO blocker issues.
- If the scene has 2+ high issues, it must be rated `poor`.
- If the scene's prose quality score (QualityValidator) is below threshold AND the weakness list identifies major problems, the scene is at most `acceptable`.

### 2.5 Poor — Definition and Examples

**Definition:** The scene fails to communicate its narrative intent effectively. A reader would be confused, misled, or unable to follow the narrative.

**Positive examples (i.e., correctly identified as poor):**
- A scene with contradictory core facts (blocker severity).
- Missing or garbled prose that omits required narrative content.
- Severe voice drift to the point of character misidentification.
- Timeline or causality violations that make the scene's events impossible.

**Negative examples (i.e., incorrectly rated poor):**
- A scene with many minor issues that collectively harm quality but are individually low/medium (should be `acceptable` unless a blocker is present).

**Decision rules:**
- Poor scenes have at least one blocker issue or 2+ high issues.
- If the prose is completely unreadable or empty, it is `poor` regardless of issue count.
- If the scene fails to satisfy the event's causal postconditions in prose, it is at most `poor`.

### 2.6 Boundary Cases and Decision Rules for Scene Quality

| Ambiguity | Resolution |
|-----------|-----------|
| Scene has 0 issues but prose is dull/flat | `good` (not excellent) — excellent requires stylistic quality, not merely error-free. Note in justification: "style below excellent bar." |
| Scene has 1 blocker issue but is otherwise excellent | `poor` (blocker present). However, if the blocker is in a single sentence and the rest is perfect, add justification noting the isolated nature. |
| Scene quality varies substantially across paragraphs | Rate based on overall effect, weighted by narrative importance (early paragraphs more impactful than middle). |
| Scene has 0 issues but fails to match sceneBrief intent | `acceptable` or `poor` depending on severity of the gap. Annotate with justification describing the intent gap. |
| Scene is excellent in Chinese translation but was rendered from English source | Rate the Chinese prose as rendered. Do not adjust for translation quality from source material. |
| Cannot determine due to tool/display issue | Mark as `cannot_determine` with provenance note. Exclude from reliability analysis. |

### 2.7 Justification Requirement

Every scene-level annotation MUST include a free-text justification field. At minimum:

- If rating is `excellent` or `good`: mention the strongest aspect (e.g., "strong character voice", "accurate causal reflection").
- If rating is `acceptable`: mention what prevented a higher rating (e.g., "pacing felt rushed", "one unresolved contradiction").
- If rating is `poor`: identify the specific blocker or major issues.
- If the rating diverges from the aggregate of issue-level severity annotations, explain why (e.g., "despite only medium issues, combined effect degrades quality significantly").

---

## 3. Annotation Process

### 3.1 Annotation Format and Fields

Each annotation is recorded as a structured JSON object. The schema is defined in `packages/bench/src/annotation-stats.ts` and listed here for reference.

#### 3.1.1 Problem-Level Annotation Record

```json
{
  "annotationId": "prob_001",
  "round": 1,
  "sessionId": "session_20260722_A",
  "tool": "severity",
  "sampleId": "sample_event_001_issue_003",
  "eventId": "E3",
  "validator": "pronoun",
  "category": "pronoun_gender_mismatch",
  "severity": "high",
  "repairPriority": "medium",
  "provenance": {
    "annotator": "user",
    "timestamp": "2026-07-22T14:30:00Z",
    "notes": "Pronoun mismatch for Xianglin's Wife; context disambiguates",
    "uncertainty": null
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `annotationId` | string | yes | Unique identifier for this annotation record |
| `round` | integer | yes | 1 (first annotation) or 2 (re-annotation) |
| `sessionId` | string | yes | Identifier for the annotation session |
| `tool` | string | yes | One of: `"severity"`, `"repair_priority"`, `"scene_quality"` |
| `sampleId` | string | yes | Links to the sampled issue or scene |
| `eventId` | string | yes | The narrative event ID |
| `validator` | string | yes | Validator that produced the issue |
| `category` | string | yes | Issue category from the validator |
| `severity` | string | yes | `"blocker"` \| `"high"` \| `"medium"` \| `"low"` — only for problem-level |
| `repairPriority` | string | yes | `"blocker"` \| `"high"` \| `"medium"` \| `"low"` — only for problem-level |
| `provenance` | object | yes | Annotation metadata (see below) |

**Provenance sub-fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `annotator` | string | yes | `"user"` for human annotation |
| `timestamp` | string | yes | ISO 8601 UTC timestamp |
| `notes` | string | no | Free-text notes about this annotation |
| `uncertainty` | string | no | `null` if confident, or describe uncertainty reason per 1.1.5 |

#### 3.1.2 Scene-Level Annotation Record

```json
{
  "annotationId": "scene_001",
  "round": 1,
  "sessionId": "session_20260722_A",
  "tool": "scene_quality",
  "sampleId": "sample_scene_001",
  "eventId": "E3",
  "qualityRating": "good",
  "justification": "Solid prose with accurate causal reflection. One instance of minor pacing issue (scene feels slightly rushed in the middle).",
  "cCapabilityNotes": [
    {
      "capabilityId": "narrator_consistency",
      "status": "C",
      "note": "Narrator maintains first-person perspective consistently, indicating C-level narrator capability is functioning."
    }
  ],
  "provenance": {
    "annotator": "user",
    "timestamp": "2026-07-22T15:00:00Z",
    "notes": null,
    "uncertainty": null
  }
}
```

**Additional fields for scene-level:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `qualityRating` | string | yes | `"excellent"` \| `"good"` \| `"acceptable"` \| `"poor"` |
| `justification` | string | yes | Free-text justification for the rating |
| `cCapabilityNotes` | array | no | C capability observations (see Section 4) |

### 3.2 What to Annotate Per Issue

For each sampled validator issue, the annotator completes **both** severity and repair priority scales. The annotation tool presents:

1. The original prose text (with the problematic passage highlighted if possible).
2. The validator name and category that flagged the issue.
3. The raw validator output (severity assigned by the validator, contextual info).
4. Input fields for severity (4-level ordinal) and repair priority (4-level ordinal).
5. Optional free-text notes field.

The annotator evaluates the ACTUAL prose, not the validator's severity assignment. The tool records both the validator-assigned severity and the human-assigned severity for comparison.

### 3.3 What to Annotate Per Scene

For each sampled scene, the annotator completes:

1. **Quality rating** (4-level ordinal per Section 2).
2. **Justification** (free-text, required).
3. **C capability awareness notes** (optional, see Section 4).

The annotation tool presents:
1. The full rendered prose for the event.
2. The event's sceneBrief, preconditions, and postconditions (for context).
3. The aggregated list of validator issues found in this scene (for reference).
4. Input fields for quality rating, justification, and capability notes.

### 3.4 Annotation Sessions

Two annotation rounds are conducted, separated by 7-14 days:

**Round 1 (initial):**
- Annotate all sampled issues and scenes.
- Record timestamp, session ID, any immediate observations about tooling or guideline clarity.
- After completion, seal the annotation file (write-only, no re-reading until Round 2).

**Round 2 (re-annotation):**
- Same samples, but presented in randomized order.
- First-round scores are hidden from the annotator.
- After completion, the two rounds are linked by `sampleId` for reliability analysis.

**Re-test sample size:** `min(N, max(50, ceil(0.20 * N)))` where `N` is the stable sample size per annotation tool.
- If `N < 50`, mark results as **exploratory** (per TODO L80).
- Re-test samples are randomly selected within each severity level, stratified by validator and scene type.

### 3.5 Session Hygiene

- Each session is recorded with a unique `sessionId` (format: `session_YYYYMMDD_<letter>`).
- No more than 200 annotations per session to prevent fatigue.
- Sessions must be spaced by at least 2 hours to prevent order effects.
- If an annotation session is interrupted, incomplete records are marked `session_incomplete: true` and excluded from reliability analysis but included in descriptive statistics.
- The annotator must note any external interruptions, tool malfunctions, or guideline ambiguities encountered during the session.

---

## 4. C Capability Awareness

The Novalistically capability manifest (`CapabilityManifest` in `packages/core/src/state/capability-manifest.ts`) distinguishes three capability statuses:
- **S (Supported):** Deterministic, production implementation, independent reference interpreter, property tests, fixtures, evidence artifacts.
- **C (Capable):** Structural/contract expressible but evaluation depends on prose quality, Pass 2 analysis, or human detection — measurement, not guarantee.
- **X (Unsupported):** Not claimed, not tested, may reject at compile time.

Annotators MUST be aware of the S/C distinction when evaluating prose, because it affects what constitutes a "violation" vs "expected behavior."

### 4.1 Semantic Capabilities (C-level)

These capabilities are structurally defined in the YAML schema but their correct prose realization depends on the LLM's Pass 2 analysis and rendering:

| Capability | C Status | What to watch for |
|-----------|----------|-------------------|
| Narrator consistency | C | First-person POV maintained throughout scene; narrator voice does not accidentally switch to omniscient |
| Discourse balance | C | Mix of narration/dialogue/description modes stays within acceptable bounds |
| Character voice | C | Character dialogue and internal monologue matches their established voice definition |
| Knowledge boundaries | C | POV character does not reveal information they should not know |
| Emotional arc | C | Scene emotional tone matches the event's pacing arc position |
| Conflict resolution | C | Resolved conflict type matches the derived `ConflictType` |
| Thread progress | C | Declared thread progress is actually realized in prose |
| Foreshadowing fulfillment | C | Foreshadowed elements are addressed in later prose |
| World rule adherence | C | Prose does not violate declared world rules |

### 4.2 Disclosure Capabilities (C-level)

These involve what information is revealed to the reader and when:

| Capability | C Status | What to watch for |
|-----------|----------|-------------------|
| Information ordering | C | Information disclosed in prose follows the intended narrative order |
| Dramatic irony | C | Reader has appropriate knowledge advantage/disadvantage vs characters |
| Mystery maintenance | C | Key mystery elements are not accidentally revealed too early |

### 4.3 Narrator Capabilities (C-level)

These affect how the narrator presents the story:

| Capability | C Status | What to watch for |
|-----------|----------|-------------------|
| Temporal framing | C | Narration time (past/present/future) matches event definition |
| Narrative distance | C | Prose maintains consistent narrative distance (close/distant) |
| Unreliable narration | C | If marked as unreliable, prose shows appropriate signs of unreliability |

### 4.4 Annotation Rules for C Capabilities

1. **When an issue involves a C capability, note it in the annotation.** Use the `cCapabilityNotes` array on scene-level annotations; for problem-level, add notes in the `provenance.notes` field.

2. **Do NOT penalize S-level failures of C capabilities.** If a C capability is structurally declared but the prose fails to realize it, this is a **prose quality issue** (captured by severity/quality scales), not a system failure. The system is "capable" of it but does not guarantee it.

3. **Do penalize S-level capabilities that fail.** If an S-level capability (e.g., deterministic precondition validation, schema rejection, causal ordering) produces incorrect output, that is a system bug and should be flagged as such. Most S-level capabilities will not appear in annotation samples because they are validated deterministically before rendering.

4. **Annotation training:** Before beginning annotation, the annotator should review:
   - The capability manifest for the project being annotated.
   - Which capabilities are S vs C vs X.
   - The validator list (Section 1 of validators.md) to understand which checks are deterministic (S) vs prose-dependent (C).

5. **If uncertain about a capability status**, consult `CapabilityRegistry` in `packages/core/src/state/capability-manifest.ts` or the project's capability manifest YAML. Do not guess.

### 4.5 Recording C Capability Notes

For scene-level annotations, the `cCapabilityNotes` field is an optional array:

```json
{
  "capabilityId": "<capability_id_from_manifest>",
  "status": "C",
  "note": "Free-text observation about how this C capability was realized or violated in the prose."
}
```

These notes are used to generate qualitative insights alongside quantitative metrics. They are NOT used for threshold-based pass/fail decisions per TODO L101 and L1064 (C cannot serve as absolute quality/logic guarantee).

---

## 5. Annotation Tooling Reference

### 5.1 Sample Selection

Samples are selected via stratified random sampling by `packages/bench/src/annotation-sampler.ts`:

- **Problem-level samples:** ≥120 issues, stratified by validator, severity level, and scene type.
- **Scene-level samples:** ≥50 scenes, stratified by scene type and quality distribution.
- **Re-annotation samples:** `min(N, max(50, ceil(0.20 * N)))` per tool.

### 5.2 Statistical Analysis

All annotation data is analyzed by `packages/bench/src/annotation-stats.ts`:

- **Inter-rater reliability:** Quadratic weighted Cohen's kappa with 95% CI (cluster bootstrap by project/scene).
- **Agreement metrics:** Exact agreement, within-one-category agreement, grade distribution, transition matrix.
- **Test-retest reliability:** Spearman rho with midrank tie handling.
- **All reliability metrics reported separately for severity, repair priority, and scene quality tools.**

### 5.3 Data Format

Annotation data is stored as newline-delimited JSON (`.ndjson`) in `fixtures/annotation/`:

- `round-1.ndjson` — Round 1 annotations
- `round-2.ndjson` — Round 2 annotations (re-test sample only)
- `manifest.json` — Sample manifest linking sample IDs to event IDs, validator outputs, and prose passages

---

## Appendix A: Quick Reference Card

### Severity Levels

| Level | Impact | Reader Noticeability | Typical Validator Level |
|-------|--------|---------------------|------------------------|
| blocker | Fundamental contradiction | Forces re-read | error |
| high | Notable degradation | Noticeable without effort | error |
| medium | Minor defect | Noticeable on re-read | warning |
| low | Cosmetic | Only on close inspection | info |

### Repair Priority Levels

| Level | Urgency | Action |
|-------|---------|--------|
| blocker | Immediate | Fix before any use |
| high | Soon | Fix before next evaluation |
| medium | Scheduled | Fix when convenient |
| low | Optional | Fix opportunistically |

### Scene Quality Levels

| Level | Issue Count | Readability | Narrative Intent |
|-------|-------------|-------------|-----------------|
| excellent | 0-1 low | Flawless | Fully achieved |
| good | ≤3 medium, 0 high | Smooth | Achieved |
| acceptable | ≤1 high, 0 blocker | Functional | Communicated |
| poor | ≥1 blocker or ≥2 high | Confused | Failed |

### C Capability Awareness Checklist

Before each annotation session, review:
- [ ] Which capabilities are C vs S for this project?
- [ ] Does this issue involve a C capability?
- [ ] If yes, note it in `cCapabilityNotes` or `provenance.notes`.
- [ ] Does this issue involve an S capability failure? (Flag as potential system bug.)
- [ ] Is the issue resolvable by improving prompt/template (C) or requires code fix (S)?

---

## Appendix B: Annotation Session Log Template

Each annotation session produces a session log file stored alongside the annotation data:

```json
{
  "sessionId": "session_20260722_A",
  "annotator": "user",
  "date": "2026-07-22",
  "startTime": "2026-07-22T14:00:00Z",
  "endTime": "2026-07-22T16:30:00Z",
  "annotationsCount": 85,
  "interruptions": [],
  "toolIssues": [],
  "guidelineAmbiguities": [],
  "fatigueNotes": null,
  "sessionComplete": true
}
```

---

*This document is frozen as of 2026-07-22. No changes may be made after scoring begins. Any necessary clarifications discovered during annotation must be recorded in the session log and flagged for the next version (post-evaluation).*
