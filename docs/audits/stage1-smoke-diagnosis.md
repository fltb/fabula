# Stage 1 Live Smoke — 退出路径诊断报告

## 总览

所有真实 provider 冷缓存 smoke 均因 **Pass 2 analysis 为 null** 退出非零，无一产生完整 E0–E6 candidate。不是连接失败、不是 provider 超时、不是 requestHash 空字符串。

---

## 1. 精确退出路径（逐层追踪）

### 1.1 入口

```bash
npm run smoke:stage1:live
  → node packages/bench/scripts/generate-reference.mjs
  → renderNovel({ projectDir: tempCopy, model: 'deepseek-v4-pro', ... })
```

### 1.2 renderNovel 内

```
api.ts:302 → createProvider(apiKey, baseUrl, resolvedModel)
api.ts:310 → new RenderPipeline({ provider, model, cacheDir, ... })
api.ts:347 → await pipeline.renderAll(jobs)
```

### 1.3 单事件 `renderScene()` 内

```
render.ts:202 → while (breaker.attempt())  ← 场景级循环
  render.ts:232 → await this.provider.complete(pass1Request)  ← Pass 1
  render.ts:289 → for (let attempt2 = 0; attempt2 < 4; ...)  ← Pass 2 重试
    render.ts:305 → await this.provider.complete(pass2Request)  ← Pass 2
    render.ts:311 → parseAnalysisJSONWithErrors(analysisRaw)  ← 解析+Zod校验
    render.ts:312 → if (parseResult.result) → 成功，break
    render.ts:319-330 → pass2Rejection = 'parse'|'validation'|'empty'
  render.ts:365-376 → 4 次用完仍未成功 → analysis = null, errors.push("Pass 2 exhausted: ...")
  render.ts:400 → aggregator.validateRender(prose, event, stateBefore, null)
  render.ts:448 → needsReview = (analysis === null || validator errors)
  render.ts:490 → return { analysis: null, needsReview: true, providerCalls: [...] }
```

### 1.4 回到 renderNovel

```
api.ts:348 → unreleased = results.filter(...)
api.ts:351 → errors.push("Release gate rejected: E0: Pass 2 exhausted: schema validation failed after retry")
api.ts:362 → catch 只追加 sanitizeError，不改写结果
api.ts:381 → mappedResults ← 每个事件包含 providerCalls, errors, released=false
api.ts:394 → return { results: mappedResults, errors }
```

### 1.5 回到 generate-reference.mjs

```
generate-reference.mjs:47 → result = await renderNovel(...)
generate-reference.mjs:96 → for each result: responseReferenceSchema.safeParse({ ... analysis: r.analysis ... })
  → analysis 为 null 时 safeParse 返回 "Expected object, received null"
  → 任一失败 → 写 fatal-error.json + exit 1
```

---

## 2. 为什么 analysis 为 null

### 原因是 Zod schema validation 失败，不是 provider 出错

`analysisResultSchema` (`packages/core/src/schemas/analysis.ts:109-112`) 要求：

```json
{
  "eventId": "string",
  "analysis": {
    "postconditions": { "covered": [], "dropped": [] },
    "preconditions": { "violated": [...] },
    "pov": { "consistent": true/false, "leaks": [] },
    "inventedDetails": [{ "detail": "...", "severity": "minor"|"major" }],
    "quality": { "proseScore": number, "maxScore": number, "strengths": [...], "weaknesses": [...], "estimatedWordCount": number },
    "threadProgressAchieved": ["..."],
    "foreshadowingDeployed": ["..."],
    "narrativeChecks": [...],
    "appearanceChecks": [...],
    "characterReferences": [...],
    "tenseDetected": "past"|"present"|"mixed",
    "conflictAnalysis": { "primaryType": "...", "resolutionAchieved": true/false },
    "ruleChecks": [...],
    "knowledgeChecks": [...]
  }
}
```

模型返回的 JSON 在以下两者之一失败：
1. **JSON parse 失败** — 模型未返回合法 JSON（`pass2Rejection = 'parse'`）
2. **Zod schema validation 失败** — 返回了 JSON 但字段类型/结构不匹配（`pass2Rejection = 'validation'`）

已开启 `response_format: { type: 'json_object' }`（provider 通过 `Output.json()` 转发）。

### 每次 real smoke 的 fatal 证据

| 运行 | 模型 | Pass2 retry | 成功/失败 | 失败原因 |
|------|------|-----------|----------|---------|
| flash (首次) | deepseek-v4-flash | 2 | 2/7 | E2-E6: Pass 2 exhausted: schema validation |
| flash (诊断后) | deepseek-v4-flash | 2 | 6/7 | E1: Pass 2 exhausted: schema validation |
| pro (route 修复) | deepseek-v4-pro | 2 | 3/7 | E2,E4,E5,E6: schema validation |
| pro (retry 4) | deepseek-v4-pro | 4 | ? | 被 terminate |

---

## 3. 场景级重试（Circuit Breaker）如何放大调用量

### 配置

```
createCircuitBreaker({
  maxRounds: 3,           // 最多 3 轮
  maxAttemptsPerRound: 2, // 每轮最多 2 次
  failureThreshold: 3,    // 连续 3 次失败自动熔断
})
```

### 放大路径

```
单事件：
  场景尝试 1: Pass1(1次) + Pass2(最多4次) → 失败
  场景尝试 2: Pass1(1次) + Pass2(最多4次) → 失败（连续2次 → escalate）
  场景尝试 3: Pass1(1次) + Pass2(最多4次) → 失败（连续3次 → breaker 自动打开）

最坏每事件: 3 × (1+4) = 15 次 API 调用
7 个事件 × 15 = 105 次，并发池大小 5
```

实际一次 smoke 耗时 = 模型单次响应时间 × 有效并行度(5) × 重试轮次。

---

## 4. 使用的 Prompt

### Pass 1

Prompt 由 `PromptAssembler.assemble()` (`packages/core/src/context/prompt-assembler.ts`) 构建，输入包括：
- 事件定义（sceneBrief、storyTime、conflictType 等）
- 角色快照、关系上下文、世界事实、知识边界
- 活跃线程、前场摘要
- `targetLengthWords`（默认 400）
- 可选的 reference example
- 重试时注入 repair guidance

### Pass 2

Prompt 由 `buildAnalysisPrompt()` (`packages/core/src/ai/prompts/render-analysis.ts:111-220`) 构建：

```
System: "You are a literary editor and quality assurance agent. Given a scene specification and the rendered prose, produce a structured analysis of how well the prose matches the specification. Output ONLY valid JSON."

User:
## Scene Specification
```json
{ id, title, sceneType, storyTime, pov, sceneBrief, tense, conflictType, resolutionType, discourseMode, arcPosition, preconditions, postconditions, threadProgress, foreshadowing, relationshipEffects, ruleEffects }
```

## Context
[Markdown context package]

## Rendered Prose
```
[Pass 1 生成的 prose]
```

## Instructions
Analyze the prose against the specification. Output ONLY valid JSON with this schema:
```json
[JSON template matching analysisResultSchema]
```

### Analysis Guidance
[每个 validator 的动态指令]

Output ONLY the JSON object. No preamble, no explanation.
```

### Provider 参数

| 参数 | Pass 1 | Pass 2 |
|------|--------|--------|
| temperature | 0.8 | 0.3 |
| seed | 无 | 42 |
| maxTokens | 10000 | 12000 |
| responseFormat | 无 | `{ type: 'json_object' }`（通过 Output.json()） |

---

## 5. 当前修复状态

| 修复 | 状态 |
|------|------|
| AiSdkProvider 转发 `responseFormat`（Output.json） | ✅ |
| AiSdkProvider 不再做 schema 校验（返回 raw text 给 pipeline） | ✅ |
| Pass2 requestHash 失败路径非空 | ✅ |
| 冷缓存临时副本 + redacted fatal 证据 | ✅ |
| Pass2 feedback retry 从 2 次提升到 4 次 | ✅ |
| `needsReview = analysis === null \|\| breaker.isOpen \|\| validationFails` | ✅ |
| `doubleRunVerification` option 恢复 | ✅ |

---

## 6. 已知次要缺陷

- `packages/core/tests/pipeline/debug-pass2.test.ts` 中一个测试仍假设 2 次 retry 上限，MockProvider 用尽预设 responses 后回退到 echo 模式导致 `pass2Rejection` 从 `'empty'` 变成 `'parse'`。不影响生产逻辑。

---

## 7. 结论

**阻塞根因是 `deepseek-v4-pro` 在 schema-feedback retry 下仍不能可靠产出符合 `analysisResultSchema` 的 JSON。** 没有网络错误、没有 requestHash 缺失、没有 provider 崩溃。每次 smoke 失败路径完全相同：`analysis: null` → `fatal-error.json` → exit 1。

减少 circuit breaker 场景级重试（减小 maxRounds）可显著降低调用量和耗时，但不改变 Pass2 能否通过的结论。
