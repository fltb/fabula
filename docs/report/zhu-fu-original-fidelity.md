# 《祝福》YAML 保真扩展与原文直接 Diff 评分

**时间**: 2026-07-27 15:04 CST  
**状态**: 已采用“expanded”配置；真实 LLM 全链路 7/7 release。  
**目标**: 让 `fixtures/zhu-fu` 的生成文本更贴近 `reference/original.txt`，并以可复跑、保序的字符级 diff 指标直接评分。

---

## 结论

采用后的配置在一次无缓存真实运行中，全文汉字序列 LCS-F1 从 **25.2% 提升到 29.9%（+4.8pp）**；场景宏平均从 **23.2% 提升到 30.7%（+7.6pp）**；二元组 F1 从 **33.3% 提升到 38.2%（+4.9pp）**。

提升不是逐场景一致的：E0、E1 分别下降 8.2pp、1.3pp；E2、E6 分别提升 26.9pp、25.1pp。结论只说明这一次真实输出的整体字序接近度提高，**不把单次未设 seed 的 Pass 1 运行解释为统计显著的质量结论**。

## 实现

### YAML：原文锚点和长度约束

`E0`–`E6` 均新增 `authorNotes`：禁止补写原文没有的事件、心理结论或现代化解释；要求优先保留 `sourceContext` 原句的语序、对白、停顿与留白。

`sourceContext` 中原先仅作事实记录、不会进入 Pass 1 的关键片段，已改为 `STYLE` 锚点；每个场景补充了原文的关键对白、动作链或叙述留白。`targetWordCount` 也按各自原文段的汉字量重新设定：

| Event | 原文汉字 | 最终目标长度 | 新增/强化锚点 |
|---|---:|---:|---|
| E0 | 1,713 | 1,700 | 河边外貌、魂灵三问、“说不清”自辩 |
| E1 | 817 | 820 | “老了”、四叔“谬种”、菜油灯下的冷抒情 |
| E2 | 548 | 550 | 初到鲁家、年终劳动、卫老婆子转述与四叔皱眉 |
| E3 | 1,501 | 1,500 | 白篷船、卫老婆子的“完事了”、撞香案 |
| E4 | 1,847 | 1,850 | 阿毛独白、尸体细节、再到鲁镇的外貌衰变 |
| E5 | 1,082 | 1,100 | “不干不净”、两次“你放着罢”、捐门槛、炮烙反应 |
| E6 | 327 | 330 | “那我可不知道”的叙述留白、爆竹与雪花收束 |

这些字段走现有 Pass 1 接线：`sourceContext` 的 `STYLE` entries 由 `RenderPipeline` 传入 `PromptAssembler`，`authorNotes` 由编译场景规格直传提示词。没有引入第二套 prompt 路径。

### 直接 diff 评分与真实运行捕获

新增：

- `scripts/zhu-fu-fidelity-report.mjs`：从 `reference/original.txt` 用固定、连续的起止锚点切出 E0–E6 原文段；输出 Markdown 与 JSON 评分。主指标是保序汉字 LCS-F1：`2 × LCS / (生成汉字数 + 原文汉字数)`；二元组 F1 仅作局部措辞重合的辅助指标。
- `scripts/zhu-fu-live-fidelity-run.mjs`：对临时、无 `.nova/scenes/output` 的 fixture 副本调用 `renderNovel(eventId: all)`。它保留每个 Pass 1 prose，即使 Pass 2/release gate 拒绝，因而评分能区分“文本偏离”与“管线拒绝”，但不会把被拒绝内容伪装成小说成品。
- `packages/core/tests/zhu-fu-fidelity-report.test.ts`：以逐段完全等同原文的候选，断言 7 场景与全文 LCS-F1、二元组 F1 均为 100%，并验证 Markdown/JSON 成对输出。

## 真实 LLM 评分

运行方式均为 `deepseek-v4-flash`、真实 AI SDK、`renderNovel(eventId: all)`、隔离临时副本、无运行缓存。Pass 1 温度为 0.8 且无 seed，因此下表是可追溯的单次样本，不是多次均值。

| 运行 | 配置 | Release | 宏平均 LCS-F1 | 全文 LCS-F1 | 全文二元组 F1 | 采用 |
|---|---|---:|---:|---:|---:|---|
| baseline | 改动前 YAML | 7/7 | 23.2% | 25.2% | 33.3% | 否 |
| expanded | 完整原文锚点 + 最终长度配置 | 7/7 | 30.7% | 29.9% | 38.2% | **是** |
| calibrated | 仅将 E0/E1 长度降至 1200/580 的校准尝试 | **6/7**；E6 Pass 2 parse/provider error 被 gate 拒绝 | 27.8% | 25.5% | 34.9% | 否 |

`calibrated` 捕获保留 E6 prose 供测量，但 `run.json` 明确记录其 `released: 6`、`rejected: ["E6"]`，故不是可交付成品，也没有被采用。最终 YAML 已恢复为已通过 7/7 的 `expanded` 长度配置。

### 场景级：expanded 相对 baseline

| Event | baseline LCS-F1 | expanded LCS-F1 | 变化 |
|---|---:|---:|---:|
| E0 | 52.0% | 43.8% | -8.2pp |
| E1 | 20.3% | 19.1% | -1.3pp |
| E2 | 14.3% | 41.3% | +26.9pp |
| E3 | 15.4% | 19.4% | +4.0pp |
| E4 | 25.5% | 30.1% | +4.7pp |
| E5 | 19.0% | 20.7% | +1.7pp |
| E6 | 15.7% | 40.7% | +25.1pp |

风险：E0/E1 的单场景回退仍需后续多样本测量后再调参；本次没有靠重复同一失败运行“挑分”。校准运行是针对已观测长度偏差的唯一一次修改后实验，既整体退化又未完整 release，因此被保留为反证而非最终配置。

## 证据与验证

| 检查 | 结果 |
|---|---|
| 最终 `zhu-fu` YAML 校验 | `Validated 7 events; Errors: 0; Warnings: 0` |
| diff scorer 回归测试 | `packages/core/tests/zhu-fu-fidelity-report.test.ts`：1 file / 1 test passed |
| TypeScript | `npm run typecheck` 通过 |
| 非 e2e 套件 | `npx vitest run --exclude '**/e2e.test.ts'`：123 files / 2,007 tests passed |
| 最终配置真实全链路 | expanded 捕获：7/7 released，`errors: []` |
| 已知 lint 限制 | Biome 2.5.4 与 2.3.8 均在现有根 `biome.json` 的 `organizeImports`、`files.ignore` 配置解析失败；未改动该仓库级配置，故未能得到 Biome 文件级结论。 |

真实运行产物位于本地忽略目录：

- baseline：`fixtures/zhu-fu/.nova/fidelity-runs/2026-07-27T06-44-03-681Z-baseline/`
- 采用的 expanded：`fixtures/zhu-fu/.nova/fidelity-runs/2026-07-27T06-50-25-050Z-expanded/`
- 被拒绝的 calibrated：`fixtures/zhu-fu/.nova/fidelity-runs/2026-07-27T06-58-31-279Z-calibrated/`

其中 adopted run 的 `novel.md` 是 7/7 release 后的完整装配成品；每次运行的 `fidelity.md`/`fidelity.json` 均可复核表中数字。
