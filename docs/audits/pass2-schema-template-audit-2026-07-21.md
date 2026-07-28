# Pass 2 JSON Schema 模板审计报告

> **时间**: 2026-07-21 18:44 CST
## 1. Schema 嵌套深度

`analysisResultSchema` 最大嵌套 **3 层**：

```
Level 0: { eventId, analysis }
Level 1: analysis: { postconditions, preconditions, pov, inventedDetails,
                     quality, threadProgressAchieved, foreshadowingDeployed,
                     narrativeChecks, appearanceChecks, characterReferences,
                     tenseDetected, conflictAnalysis, ruleChecks, knowledgeChecks }
Level 2: 嵌套对象（postconditions: { covered[], dropped[] }, quality: { proseScore, … }）
Level 3: 数组元素对象（narrativeChecks: [{ entityId, attribute, hint, evidence, matchLevel }]）
```

14 个 analysis 子字段，其中 6 个是数组类型（narrativeChecks, appearanceChecks, characterReferences, inventedDetails, knowledgeChecks, ruleChecks），其余是对象、枚举或字符串数组。

---

## 2. 每个字段对应的 Prompt 来源

### 2.1 Prompt 组装流程

```
aggregator.getAnalysisRequirements()
  → 收集所有 validator 的 schemaExample + instruction + field
  → buildDynamicJsonTemplate(eventId, requirements)
  → JSON.stringify(jsonTemplate) 成为 prompt 中的 "## Instructions" 代码块
  → LLM 按模板输出 JSON
```

### 2.2 字段到 Validator 映射

| 字段 | 来源 Validator | schemaExample（修复前） | 问题 |
|------|---------------|----------------------|------|
| postconditions | causality.ts | `{ covered: [], dropped: [] }` | ✅ |
| preconditions | causality.ts | `{ violated: [{ entityId, attribute, expectedValue, issue }] }` | ✅ |
| pov | pov.ts | `{ consistent: true, leaks: [] }` | ✅ (field=`pov.leaks`, topField=`pov`) |
| inventedDetails | factual-detail.ts | `{ detail, severity }` | ❌ Zod expects **array** |
| quality | quality.ts | `{ proseScore:5, maxScore:10, strengths:[], weaknesses:[], estimatedWordCount:400 }` | ✅ |
| threadProgressAchieved | thread-progress.ts | `['thread ID that the prose advances']` | ✅ |
| foreshadowingDeployed | foreshadowing.ts | `{ foreshadowingDeployed: [...] }` | ❌ 多余的 key 包裹 |
| narrativeChecks | character-state, pacing, pronoun, timeline, voice-drift, discourse-balance | `[{ entityId, attribute, hint, evidence, matchLevel }]` | ✅（特殊处理） |
| appearanceChecks | appearance.ts | `{ entityId, feature, ... }` | ❌ Zod expects **array** |
| characterReferences | alias.ts | `{ entityId, namesUsed }` | ❌ Zod expects **array** |
| tenseDetected | tense-consistency.ts | `{ tenseDetected: 'past' }` | ❌ Zod expects **bare enum string** |
| conflictAnalysis | conflict.ts | `{ primaryType, resolutionAchieved }` | ✅ |
| ruleChecks | world-rule.ts | `[{ ruleId, violated, evidence, severity }]` | ✅ |
| knowledgeChecks | knowledge.ts | `{ entityId, leakedEntity, ... }` | ❌ Zod expects **array** |

---

## 3. 根因：`buildDynamicJsonTemplate` 的作业方式

```ts
// render-analysis.ts:82-98
for (const field of activeFields) {
  const template = JSON.parse(JSON.stringify(req.schemaExample));
  analysis[field] = template;  // ← 把 schemaExample 原样放到 analysis[field]
}
```

所以 `schemaExample` **必须是 Zod schema 在该路径期望的值**，而不是用字段名包裹的嵌套对象。

### 6 个错误实例

| 路径 | Zod 期望 | schemaExample（错误） | 产生的不正确模板 |
|------|---------|---------------------|---------------|
| `analysis.foreshadowingDeployed` | `string[]` | `{ foreshadowingDeployed: […] }` | `{ foreshadowingDeployed: { foreshadowingDeployed: […] } }` |
| `analysis.inventedDetails` | `object[]` | `{ detail, severity }` | `{ inventedDetails: { detail, severity } }`（缺数组包装） |
| `analysis.appearanceChecks` | `object[]` | `{ entityId, … }` | 同上 |
| `analysis.knowledgeChecks` | `object[]` | `{ entityId, … }` | 同上 |
| `analysis.characterReferences` | `object[]` | `{ entityId, … }` | 同上 |
| `analysis.tenseDetected` | `"past"\|"present"\|"mixed"` | `{ tenseDetected: 'past' }` | `{ tenseDetected: { tenseDetected: 'past' } }` |

模型收到这些错误模板后，要么输出错误的嵌套结构（导致 Zod 拒绝），要么凭 prompt engineering 猜测正确结构（不稳定）。

---

## 4. System/User Prompt 检查

- System: `"Output ONLY valid JSON."` ✅ 含 `JSON` 字样
- User: `"Output ONLY valid JSON with this schema:"` ✅ 含 `JSON` + schema 示例
- 符合 DeepSeek JSON Output 要求：prompt 中必须含 `json` 字样
- `response_format: { type: 'json_object' }` 由 `Output.json()` 转发 ✅

---

## 5. 修复内容

6 个 validator 的 `schemaExample` 已修正（并行提交中）：

| 文件 | 修改 |
|------|------|
| `validator/foreshadowing.ts:88` | `{ foreshadowingDeployed: […] }` → `[…]` |
| `validator/factual-detail.ts:127` | `{ detail, severity }` → `[{ detail, severity }]` |
| `validator/appearance.ts:116` | `{ entityId, … }` → `[{ entityId, … }]` |
| `validator/knowledge.ts:97` | `{ entityId, … }` → `[{ entityId, … }]` |
| `validator/alias.ts:110` | `{ entityId, … }` → `[{ entityId, … }]` |
| `validator/tense-consistency.ts:113` | `{ tenseDetected: 'past' }` → `'past'` |
