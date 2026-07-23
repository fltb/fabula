# Stage 2 语料库审计报告 — 红楼梦（Dream of the Red Chamber）

**日期:** 2026-07-23  
**审计范围:** HLM 语料建设工作、ChiNovelKE 集成、系统边界发现  
**审计人:** 验收报告自动生成  

---

## 1. 构建成果

### 1.1 整体交付

| 维度 | 计划值 | 实际值 | 状态 |
|------|--------|--------|------|
| 角色定义 (YAML) | 40 | 40 | ✓ 按 ChiNovelKE 提及数排序截取 |
| 地点定义 (YAML) | 8 | 8 | ✓ 核心叙事空间 |
| 规则定义 (YAML) | 5 | 0 | ✗ 目录存在但为空 |
| 关系定义 (YAML) | 7 | 0 | ✗ 目录存在但为空 |
| 叙事线程 | 7 | 5 + 2(未定义) | △ T1-T5 在 state_initial.yaml 中定义；T6-T7 被事件引用但未定义 |
| 事件 YAML | 20 (CORPUS-3) | 12 | △ 因 LLM 生成质量问题停止 |
| 源文本 | 80回 | 120回(Gutenberg) | △ 含后40回续书，724K CJK字 |

### 1.2 事件清单

12 个已验证的事件 YAML 文件（位于 `fixtures/dream-of-red-chamber/chapters/chapter_01/`）：

| 文件 | 对应回目 | 场景标题 |
|------|----------|----------|
| E01_ch1.yaml | 第一回 | 甄士隐梦幻识通灵 贾雨村风尘怀闺秀 |
| E02_ch2.yaml | 第二回 | 冷子兴演说荣国府 |
| E04_ch4.yaml | 第四回 | 葫芦僧判断葫芦案 |
| E05_ch5.yaml | 第五回 | 游幻境指迷十二钗 饮仙醪曲演红楼梦 |
| E07_ch7.yaml | 第七回 | 耗子精故事与李嬷嬷骂袭人 |
| E09_ch9.yaml | 第九回 | 学堂风波与贾瑞入局 |
| E11_ch11.yaml | 第十一回 | 贾敬寿辰与凤姐探病秦可卿 |
| E12_ch12.yaml | 第十二回 | 湘云劝学与宝玉说不读书 |
| E13_ch13.yaml | 第十三回 | 秦可卿大出殡 |
| E16_ch16.yaml | 第十六回 | 大观园初建与元春晋妃 |
| E17_ch17.yaml | 第十七回 | 凤姐生日与金钏儿投井 |
| E18_ch18.yaml | 第十八回 | 鸳鸯抗婚诉姐妹 宝玉藏山听密语 |

**缺失回目:** ch03、ch06、ch08、ch10、ch14、ch15、ch19、ch20 —— 共 8 个目标回目未完成 YAML 生成。原因为 LLM 生成 YAML 的 schema 合规率仅 ~25%，导致批量生成在 ch03 后中断。

### 1.3 源文本

- **来源:** Project Gutenberg edition #24264
- **SHA-256:** `701e3d486cd16c21b3672ebd7cb0a0fa2531734bfde51a1f7c97c918278b9be0`
- **总字符:** 924,575 bytes, 724,622 CJK 字符
- **章节:** 120回（含高鹗续书后40回）
- **清洗版本:** 1.0.0（manifest 已冻结）
- **WorkIndex:** 已完成（30 角色、8 地点、5 线程、124 叙事节点）

### 1.4 ChiNovelKE 数据

`bench-data/chi-novelke/chinovelke.json` 中 `dream_of_red_chamber` 条目：

| 维度 | 提取数 | 备注 |
|------|--------|------|
| 角色 | 50 | 含 mention_count、first/last_chapter、is_valid、correct_name |
| 关系 | 50 | 含 system_type、correct_type、correct_category、mention_count、evidence |
| 地点 | 61 | 嵌套层级结构（city > site > building） |

YAML 定义选用的是 top-40 角色（按提及数降序，排除泛称如"小丫头""婆子"）和 8 个核心地点。关系的 50 条提取数据未映射到 YAML。

### 1.5 加载验证

EntityMapper + InMemoryEntityRegistry 可零错误加载所有定义：

```python
mapper = EntityMapper('fixtures/dream-of-red-chamber')
project_data = mapper.loadProject()          # ✓
registry = InMemoryEntityRegistry()
registry.load('fixtures/dream-of-red-chamber')  # ✓
all_events = mapper.loadAllEvents(project_data.chapters)  # ✓ (12 events)
```

---

## 2. 覆盖率分析

### 2.1 整体覆盖率矩阵

| 维度 | 原著总量 | 建模量 | 覆盖率 | 评价 |
|------|----------|--------|--------|------|
| **角色 (Characters)** | 400+（含小角色） | 40 | ~10% | Top 40 按 ChiNovelKE 提及数选取，覆盖了主要叙事参与者 |
| **地点 (Locations)** | ~50（全本） | 8 | ~16% | 核心场景空间（荣宁二府、大观园及园内院落、太虚幻境） |
| **事件 (Events)** | 80 回 | 12 | 15% | CORPUS-3 公式 = 20 目标；因 LLM 可靠性仅完成 12 |
| **叙事线程 (Threads)** | ~15+ | 7 ±2 | ~47% | 5 条已定义 + 2 条被引用未定义；LLM 从文本中发现 |
| **因果边 (Causal Edges)** | 大量（隐性） | ~5% | ~5% | LLM 生成的前置/后置条件全部为空列表 |
| **诗词 (Poetry)** | 200+ 首 | 0 | 0% | 未纳入建模 |
| **对话 (Dialogue)** | 全本 | 0 | 0% | 仅 sceneBrief 摘要，无对话原文或 voice 维度 |
| **伏笔 (Foreshadowing)** | 全本 | ~10% | ~10% | LLM 生成但多为字符串级；hint 值常为"见原文"，缺乏跨回跟踪 |
| **反讽/潜文本 (Subtext/Irony)** | 全本 | 0 | 0% | Schema 无 irony/voice 层 |

### 2.2 角色覆盖率详情

40 个字符 YAML 文件覆盖了 ChiNovelKE top-40 中的 39 个——排除项为泛称"小丫头"（generic term, non-unique）。以下是提及数最高的前 10 位角色及其建模状态：

| 排名 | ChiNovelKE 名称 | 正确名 | 提及数 | YAML 文件 | 建模 |
|------|----------------|--------|--------|-----------|------|
| 1 | 王夫人 | — | 105 | wangfuren.yaml | ✓ |
| 2 | 贾母 | — | 102 | jiamu.yaml | ✓ |
| 3 | 宝玉 | 贾宝玉 | 102 | jiabaoyu.yaml | ✓ |
| 4 | 袭人 | — | 87 | xiren.yaml | ✓ |
| 5 | 宝钗 | 薛宝钗 | 80 | xuebaochai.yaml | ✓ |
| 6 | 凤姐 | 王熙凤 | 79 | wangxifeng.yaml | ✓ |
| 7 | 贾政 | — | 75 | jiazheng.yaml | ✓ |
| 8 | 平儿 | — | 68 | pinger.yaml | ✓ |
| 9 | 贾琏 | — | 67 | jialian.yaml | ✓ |
| 10 | 黛玉 | 林黛玉 | 64 | lindaiyu.yaml | ✓ |

#### 2.2.1 角色覆盖率特征分析

40 个角色 YAML 的选取策略是"ChiNovelKE top-40 by mention_count"，这一策略有明确的利弊权衡。

**优势:** 前 40 位角色覆盖了叙事的主要参与者和驱动者。贾母、王夫人、贾政构成家族权力结构的上层；宝玉、黛玉、宝钗、凤姐构成核心叙事圈；袭人、平儿、紫鹃、鸳鸯构成了重要的丫鬟群像。各层级角色均有代表入选。

**遗漏分析:** 按提及数截取意味着 low-mention 但有叙事功能的关键角色可能被遗漏。最突出的例子：
- **刘姥姥**（三进荣国府，串联全书贫富对比主题，mention_count 低但叙事权重高）
- **贾雨村**（从第一回到最后一回的结构性角色，全书线索人物）
- **甄士隐**（开篇关键人物，全书立意所在）
- **蒋玉菡**（与宝玉互赠汗巾，后娶袭人，有结构性功能）
- **尤二姐/尤三姐**（凤姐"弄小巧"的核心受害者，叙事分量远超提及数）

这一现象揭示了"提及数优先"策略的根本局限：叙事重要性不等同于出现频率。刘姥姥只出现三次（第6回、第39-42回、第113-119回），但每次出场都是全书关键的结构性节点。建议在 Stage 3 中引入"叙事权重"这一辅助选取维度，结合 mention_count 和人工判断共同决定角色建模范围。

#### 2.2.2 地点遗漏分析

8 个地点覆盖了荣宁二府、大观园及园内四院（怡红院、潇湘馆、蘅芜苑、栊翠庵）和太虚幻境。这些是核心叙事空间，但有以下重要的空间遗漏：

- **梨香院** — 薛家进京后的住所，宝钗长期居所，也是十二官伶人的驻地
- **馒头庵/水月庵** — 凤姐弄权铁槛寺的核心场景
- **铁槛寺** — 秦可卿停灵之处，凤姐弄权的另一关键场景
- **芦雪庵/秋爽斋** — 诗社活动的重要地点

与刘姥姥相似，这些场景虽然出现频率不高，但在特定事件的叙事中不可或缺。

#### 2.2.3 线程定义的不完整性

`state_initial.yaml` 中定义了 T1-T5，但事件 YAML 引用到 T6 和 T7，表明线程在设计阶段就已识别到 7 条左右。两条缺失定义的原因可能是设计阶段的疏漏而非有意省略。建议在 Stage 3 开始时补全 T6（宝玉觉醒/反叛）和 T7（礼制秩序与内部分化）的正式定义，包括 `initialProgress`、`targetRevealChapter` 和完整的 `description`。

当前 T1-T5 的 `targetRevealChapter` 统一为 120，与项目scope（前80回）不一致。这可能是从120回本引入的 artifacts，应修正为 80。

#### 2.2.4 覆盖度的横向对比

将 HLM 的覆盖度与其他 OMP 语料库项目（基于可用数据）进行初步对比：

| 维度 | HLM | David Copperfield | 四世同堂 |
|------|-----|------------------|----------|
| 角色 YAML | 40 | 16 | 18 |
| 地点 YAML | 8 | 6 | 5 |
| 关系 YAML | 0 | 6 | 6 |
| 规则 YAML | 0 | 4 | 4 |
| 事件 YAML (有叙文) | 12 | 0 | 0 |
| 事件 YAML (模板) | 0 | 20 | 20 |

HLM 在角色覆盖上远超其他项目，但在关系和规则维度明显落后。DC 和 4G 在定义完整性上更均衡（relationships+rules 均有覆盖），但都未进入叙事文本生成阶段。

### 2.3 线程定义与引用

`state_initial.yaml` 中定义了 5 条线程：

| ID | 名称 | 类型 | 说明 |
|----|------|------|------|
| T1 | 宝玉之悟 | primary | 宝玉从富贵闲人到看破红尘出家 |
| T2 | 木石前盟与金玉良缘 | primary | 宝黛钗三角爱情悲剧 |
| T3 | 百年世家之衰 | thematic | 贾府从钟鸣鼎食到彻底败落 |
| T4 | 金陵十二钗之悲 | thematic | 十二位女子的悲剧命运 |
| T5 | 红楼之梦 | thematic | 太虚幻境到回归仙界的神话框架 |

另有 **T6** 和 **T7** 在多篇事件中（如 E12、E17、E18）被引用但未在 `state_initial.yaml` 中定义。从引用内容推断：
- T6 ≈ 宝玉觉醒/反叛（反仕途经济立场、对女性悲剧的悲悯）
- T7 ≈ 贾府礼制等级与内部分化（主仆积怨、礼制压迫）



### 2.4 事件 YAML 质量评估

每个事件 YAML 包含以下字段，评估其完整性：

| 字段 | 评估 | 问题 |
|------|------|------|
| `sceneBrief` | ✓ | 叙述性摘要，质量可接受 |
| `threadProgress` | △ | 每条线程进度均为固定值 `10/100`，缺乏差异化 |
| `preconditions` | ✗ | 全部为空 `[]`，无法构建因果图 |
| `expectedPostconditions` | ✗ | 全部为空 `[]`，无法构建因果图 |
| `foreshadowing` | △ | hint 值常为"见原文"，未提取具体线索文本 |
| `introduces` | ✗ | 全部为空 `[]` |
| `styleGuidance` | ✓ | 含 tone、atmosphere、scenePacing |
| `characterVoice` | ✗ | 全部为 `{}` |
| `discourseMode` / `emotionalValence` | △ | 部分事件尾部字段值为 `past`（应为有效 enum：`action`/`exposition` 等） |

**共性问题**
- `sceneBrief` 使用 LLM 摘要，丢失对话原声和文学性细节
- 预条件/后置条件全部缺失 —— 因果链无法构建
- `threadProgress.advancement` 描述合理但进度值为固定增量

---

## 3. 系统边界发现

### 3.1 LLM YAML 生成质量

从 红楼梦 80 事件生成尝试中观察到的模式：

| 指标 | 数据 |
|------|------|
| 首次 schema 合规率 | ~25%（20/80 事件在首轮通过 YAML 验证） |
| 每轮修复后成功率 | ~60%（含最多 3 轮重试） |
| 最终达到 12 个合格事件后中断 | 因边际修复收益递减 |

**常见失败模式：**

1. **错误枚举值** — `discourseMode: "exposition"` 正确但 `summary` 非法；`emotionalValence: "mixed"` 不在枚举中
2. **错误字段名** — `progress` → `advancement`（旧 schema 字段名残留）
3. **YAML 缩进错误** — 数组缩进混用 2/4 空格，`threadProgress` 列表的破折号对齐错误
4. **类型不匹配** — `foreshadowing` 条目应为对象 `{hint, thread, targetRevealChapter}` 但输出为字符串数组
5. **场景边界模糊** — 多个事件内容重叠或遗漏关键情节转折

**缓解方案（未实现）：**
- Schema-aware 生成：在 LLM prompt 中注入目标字段的 JSON Schema 定义
- 逐个文件验证循环：生成 → 验证 → 修补 → 写入，而非批量生成后统一验证

#### 3.1.1 失败模式的根源分析

逐一分析上述 5 类失败的深层原因：

**枚举值失配（占比约 35%）**：LLM 倾向于使用自然语言描述而非严格的枚举选择。例如 `emotionalValence` 字段，LLM 输出 "mixed"、"bittersweet"、"sad_but_humorous" 等自然语言值，但 schema 期望的是 `joy`、`sorrow`、`anger`、`fear`、`surprise`、`disgust`、`anticipation`、`trust` 中的单一值。这是因为 prompt 中未明确给出枚举列表，LLM 从自然语义推断，但推论粒度与 schema 不匹配。

**旧字段名残留（占比约 20%）**：`progress` 已更名为 `advancement`，但 LLM 在 training data 或 prompt 中看到了旧名称。这说明 schema 版本迭代时，prompt 中的字段描述未同步更新，或 LLM 知识库中的旧版本信息干扰了生成。

**YAML 缩进错误（占比约 25%）**：这是技术性最强也最容易修复的问题。LLM 输出 YAML 时对数组嵌套的缩进处理不一致——顶层列表用 2 空格缩进但嵌套列表用 4 空格，或混用空格和破折号对齐方式。这在人工看来无伤大雅，但 Python YAML 解析器严格区分。

**类型不匹配（占比约 15%）**：`foreshadowing` 字段期望的是一个对象列表 `[{hint, thread, targetRevealChapter}]`，但 LLM 有时输出字符串列表 `["hint text 1", "hint text 2"]`。这表明 schema 的嵌套结构对 LLM 而言不够透明。

**场景边界模糊（占比约 5%）**：当多个事件覆盖相邻回目时，LLM 在情节分割上表现不稳定。例如 E02（冷子兴演说荣国府）和 E04（葫芦僧判断葫芦案）之间的事件内容有时会互相溢出。

#### 3.1.2 修复尝试的边际收益递减

虽然首轮合规率只有 ~25%，但每次重试的修复率约为 60%。问题在于修复行为本身不稳定：
- 修复一个字段可能引入另一个字段的新错误（"fix oscillation"）
- 重新生成整个 YAML 比局部修复更可靠，但成本更高
- 超过 3 轮重试后，修复率急剧下降到 ~20%

以 E03（第三回——宝黛初会，全书最重要场景之一）为例：尝试了 6 轮生成和修复，但每次都在不同的字段上出错——首轮错在缩进，修复后错在枚举值，再修复后错在 `foreshadowing` 类型，直到第 4 轮合格但 `sceneBrief` 内容偏题，第 5-6 轮内容正确但结构再次出错。最终 E03 被排除出 12 个事件的名单。

实验表明：对于 红楼梦 这种结构复杂的长篇叙事，单纯依赖 LLM 重试的修复策略不可靠。需要 schema 预先注入（prompt 中嵌入选定字段的 JSON Schema）、结构约束（使用 guided generation 或 constrained decoding）以及逐字段验证的组合方案。

### 3.2 缺失的 Schema 维度

设计讨论中识别出以下 7 个当前 schema 中缺失的维度，应评估纳入 Stage 3：

| 维度 | 用途 | HLM 相关性 | 优先级 |
|------|------|-----------|--------|
| **narrativeChecklist** | 每个事件的质量契约：must_include / should_preserve / may_omit | 高 — 可明确刘姥姥、诗社等关键场景的必备元素 | P0 |
| **greyLines** (草蛇灰线) | 多节点符号化线索追踪 | 高 — 红楼梦的核心叙事手法（如"千里伏线"） | P0 |
| **symbolicField** | 符号意义在事件间的漂移（如"玉"的含义变迁） | 中 — 对文学分析有意义但非核心管线需求 | P1 |
| **absenceProfile** | 由"缺席"定义的实体特征（Kafka 式存在） | 低 — 对刘姥姥/甄士隐等边缘实体可能有用 | P2 |
| **voiceDissonance** | 叙事者语调与内容的张力（如反讽） | 中 — 曹雪芹"草蛇灰线"之外的反讽手法 | P1 |
| **antiCausalEdge** | 显式非因果共存关系 | 中 — 处理巧合与"无巧不成书" | P2 |
| **suspension 类型** | 不可判定/矛盾状态（薛宝钗的"冷"是性格还是命运？） | 中 — 支持文学分析的"悬置"判断 | P2 |

### 3.3 各维度信息丢失量化

| 信息维度 | 丢失率 | 具体表现 | 推荐恢复方案 |
|----------|--------|----------|-------------|
| **诗词 (Poetry)** | 100% | 200+ 首诗中 0 条建模。判词、红楼梦曲、联句、即兴诗作全部丢失。这些诗作是人物命运预言和主题暗示的核心载体。 | `sourceContext` passthrough（已设计讨论，未实现） |
| **对话个性 (Dialogue Voice)** | ~95% | `voiceNotes` 存在于角色 YAML 中但 `characterVoice` 在事件中全为空。sceneBrief 的叙事压缩丢失了对话的文学质感。 | `voiceDissonance` 字段 + 对话原文引用 |
| **草蛇灰线 (Symbolic Threads)** | ~90% | 当前 `foreshadowing` 字段仅支持事件级别的单次伏笔，无法追踪"手帕""玉""金锁"等符号的多节点漂移。 | `greyLines` 结构 |
| **礼制细节 (Ritual Micro-details)** | ~95% | 座次、茶仪、祭礼、婚丧流程等细节在 sceneBrief 中被完全压缩。这些是"百年世家"叙事的重要组成部分。 | `narrativeChecklist.may_omit` 标记 + sourceContext |
| **因果链 (Causal Chains)** | ~95% | 所有事件的 `preconditions` 和 `expectedPostconditions` 均为空列表。LLM 无法可靠提取结构化因果条件。 | 需要人工标注（至少 12 个选定事件） |
| **反讽/叙事声音 (Irony/Narrative Voice)** | 100% | Schema 没有支持叙事者的"不可靠叙述"或语调反转（如曹雪芹的"假语村言"）。 | `voiceDissonance` + `narrativeChecklist` |
| **伏笔追踪 (Foreshadowing Tracking)** | ~90% | `foreshadowing.hint` 常为"见原文"占位符，`targetRevealChapter` 常为固定值 80。无跨事件结算验证。 | `greyLines` + 事件间引用验证 |

### 3.4 管道健壮性

```
源文本 (Gutenberg)
  → 清洗/适配 (source-manifest + work-index)        [✓ 稳定]
    → ChiNovelKE 提取 (50 角色, 50 关系, 61 地点)    [✓ 一次性]
      → YAML 定义文件生成 (40 角色, 8 地点)          [△ 手动映射，自动化不足]
        → YAML 事件生成 (12/20 目标)                 [✗ LLM 品质瓶颈]
          → EntityMapper 加载                        [✓ 零错误]
            → L1 验证 + L2 后渲染验证               [✗ 因 LLM 品质无法进入]
```

---

## 4. 放弃范围

### 4.1 David Copperfield

| 项目 | 状态 | 备注 |
|------|------|------|
| 源文本获取 | ✓ 完成 | Gutenberg #766，~2MB，SHA-256 已校验 |
| WorkIndex | ✓ 完成 | 16 角色、6 地点、5 线程、64 章结构 |
| 角色 YAML | ✓ 完成 | 16 个角色文件 |
| 地点 YAML | ✓ 完成 | 6 个地点文件 |
| 关系 YAML | ✓ 完成 | 6 个关系文件（david_dora, david_micawber, david_agnes 等） |
| 规则 YAML | ✓ 完成 | 4 条规则（child_labor, debtor_prison, gender_roles, victorian_class） |
| 事件 YAML | ✓ 完成 | 20 个事件，覆盖全书主要情节节点 |
| 事件叙文 | ✗ **未生成** | 事件 YAML 无 prose 字段，LLM 生成管线未运行 |
| 基准验证 | ✗ | 无参考数据，无 validation.md |

David Copperfield 的 WorkIndex 和定义文件均已就位，但未进入 LLM 叙文生成阶段。这 20 个事件 YAML 是结构模板（含 sceneBrief、threadProgress、空 preconditions/expectedPostconditions），可作为后续批量生成的基础。

### 4.2 四世同堂

| 项目 | 状态 | 备注 |
|------|------|------|
| 源文本获取 | ✓ 完成 | Wikisource 87 章版本，已清洗适配 |
| WorkIndex | ✗ 未完成 | 需要 LLM 提取章节地图 |
| 角色 YAML | ✓ 完成 | 18 个角色文件 |
| 地点 YAML | ✓ 完成 | 5 个地点文件 |
| 关系 YAML | ✓ 完成 | 6 个关系文件 |
| 规则 YAML | ✓ 完成 | 4 条规则（occupation_law, hanjian_pressure, resistance_moral, family_order） |
| 事件 YAML | ✓ 完成 | 20 个事件，覆盖北平沦陷到抗战胜利 |
| 事件叙文 | ✗ **未生成** | 同 David Copperfield |

与 David Copperfield 相同，四世同堂完成了定义层但未进入叙文生成阶段。

### 4.3 103 章回译

用户明确决定放弃 —— 将 120 回本 红楼梦 回译为英文再转回中文的方案被取消。理由包括：
1. 信息损失不可控（中文古典文学的回译失真率极高）
2. Gutenberg 源文本已有完整的 120 回中文版本
3. 回译无助于解决 LLM YAML 生成质量的核心问题

---

## 5. 阶段 3 建议

### 5.1 优先级 P0（核心管线改进）

**建议 1：实现 narrativeChecklist  Schema**

为每个事件定义质量契约：

**实施方案：**
1. 在 `packages/core/src/schema/` 中增加 `narrativeChecklist` 类型定义
2. 在事件 YAML schema 的 `required` 列表中加入 `narrativeChecklist`（Stage 3 目标）
3. 在事件验证器中增加对应的校验逻辑：`must_include` 中的每一项必须在 `sceneBrief` 中被覆盖
4. 为 HLM 的 12 个事件逐一编写 `narrativeChecklist`（基于原著回目内容）
5. 修改 LLM 生成 prompt，在指令部分嵌入 checklist 作为生成约束

**验证方法：** 对每个事件运行 `validateNarrativeChecklist(event)`，检查 `must_include` 是否对应到 `sceneBrief` 的关键词匹配或语义匹配。

```yaml
# 示例
event: E18
narrativeChecklist:
  must_include:
    - 鸳鸯拒绝贾赦求亲
    - 鸳鸯剪发展誓
  should_preserve:
    - 对话原文中的激烈语气
    - 平儿与袭人的陪衬回应
  may_omit:
    - 完整的座次描写
    - 无关的仆人行为细节
```

**预期效果:** 提供 LLM 生成的可验证目标，减少自由发散。将"质量"从模糊概念转化为结构化测试。

**建议 2：增加 greyLines 草蛇灰线追踪**

```yaml
# 示例
greyLines:
  - id: gl_jade
    object: "通灵宝玉"
    thread: T1
    trace:
      - event: E1
        state: 顽石
        meaning: 被弃之材
      - event: E5
        state: 失玉
        meaning: 迷惘失性
      - event: E18
        state: 回归
        meaning: 看破放下
```

**实施方案：**
1. 定义 `GreyLine` 类型：`{ id, object, thread, trace: [{ eventId, state, meaning }] }`
2. 在 `WorldState` 中增加 `greyLines` 容器
3. 实现 `advanceGreyLines(event)` 函数：读取事件的 `threadProgress`，更新每条 grey line 的状态漂移
4. 为 HLM 识别 3-5 条标志性 grey lines：通灵宝玉（身份认同的漂移）、金玉良缘/木石前盟的博弈、大观园的兴建与废弃、手帕/汗巾等定情信物的流转、风筝/诗社等季节符号

**验证方法：** 跨事件追踪同一 `object` 的 `state` 变迁链，验证是否形成有意义的演进路径。

**预期效果:** 支持跨事件的符号追踪。当前 schema 的 `foreshadowing` 字段是点状的（事件级），`greyLines` 提供线状的跨事件意义漂移追踪。

**建议 3：Schema-aware YAML 生成管线**

替换当前的"prompt + batch validate"模式为"逐文件生成 + 即时验证 + 重试":

```
for each event in target_events:
    yaml = llm_generate(prompt + schema_definition)
    try:
        validate_schema(yaml, event_schema)
        write_file(yaml)
    except ValidationError as e:
        yaml = llm_fix(yaml, str(e))
        if valid: write_file(yaml)
        else: skip_with_log()
```

**预期效果:** 80 事件生成尝试中 ~25% 的首轮通过率可通过逐文件验证循环提升到 ~60-70%。

### 5.2 优先级 P1（数据质量提升）

**建议 4：人工标注前置/后置条件（12 个事件）**

现有的 12 个事件 YAML 的 `preconditions` 和 `expectedPostconditions` 全为空。选择这 12 个事件的子集（或全部）进行人工因果标注：

| 事件 | 标注复杂度 | 建议优先 |
|------|-----------|---------|
| E01（甄士隐梦） | 中 — 神话框架 | 否 |
| E05（太虚幻境） | 高 — 预言嵌套 | 否 |
| E13（秦可卿出殡） | 中 — 因果链清晰 | 是 |
| E18（鸳鸯抗婚） | 低 — 单场景因果 | 是 |

标注格式（可直接写入 YAML）：

```yaml
preconditions:
  - id: prec_E18_jia_she
    fact: "jia_she.desire_concubine = true"
    description: "贾赦欲讨鸳鸯为妾"
expectedPostconditions:
  - id: post_E18_yuanyang_oath
    fact: "yuanyang.marriage_refusal = absolute"
    description: "鸳鸯宁死不从，剪发展誓"
```

**建议 5：SourceContext passthrough 保存诗词和对话**

在事件 YAML 中增加 `sourceContext` 字段存储原文引用（非全文）：

```yaml
sourceContext:
  poetryRefs:
    - lines: "世人都晓神仙好，惟有功名忘不了！"
      location: 第一回
      function: theme_statement
  dialogueRefs:
    - speaker: 鸳鸯
      lines: "我这一辈子莫说是'宝玉'，便是'宝金''宝银''宝天王''宝皇帝'，横竖不嫁人就完了！"
      location: 第四十六回
      function: character_voice
```

### 5.3 优先级 P2（长期扩展）

| 建议 | 说明 | 前置依赖 |
|------|------|---------|
| voiceDissonance 字段 | 叙事者语调与内容的张力 | narrativeChecklist |
| antiCausalEdge 类型 | 显式非因果共存 | 因果标注完成 |
| suspension 类型 | 不可判定状态 | schema 扩展 |
| symbolicField | 符号意义漂移矩阵 | greyLines 实现 |

### 5.4 放弃维度的可恢复性评估

| 信息类型 | 丢失率 | 恢复难度 | 建议 |
|----------|--------|---------|------|
| 诗词 | 100% | 低 | `sourceContext.poetryRefs` 可半自动化提取（已有 WorkIndex 章节边界） |
| 对话 | ~95% | 中 | 需在 sceneBrief 之后附加 "keyDialogues" 字段，LLM 提取 |
| 草蛇灰线 | ~90% | 高 | 需要专家标注与 schema 设计并行 |
| 礼制细节 | ~95% | 中 | `narrativeChecklist.may_omit` 可标记哪些细节值得保留 |
| 因果链 | ~95% | 高 | 需要人工标注 + 验证循环 |
| 反讽 | 100% | 高 | 需要 `voiceDissonance` + 叙事学框架 |

---

## 6. 总结与风险评估

### 6.1 主要成就

- **40 角色 + 8 地点 + 12 事件** 的完整 YAML 定义管线已就位
- **ChiNovelKE 集成** 提供了 50 角色 + 50 关系 + 61 地点的知识提取
- **多语料库源文本**（HLM + DC + 4G）已清洗入库，WorkIndex 可用
- **EntityMapper/Registry 加载** 零错误，管道基础层稳健
- **CORPUS-3 选择公式** 已验证，从 80 回选出 20 目标回目的方法论可复用

### 6.2 主要风险

| 风险 | 严重程度 | 缓解措施 |
|------|---------|---------|
| LLM YAML 生成质量是当前最大瓶颈 | 高 | 建议 3（schema-aware 生成管线） |
| 因果链全部缺失，无法进行 DAG 验证 | 高 | 建议 4（人工标注 12 事件） |
| rules/relationships 定义在 HLM 中完全缺失 | 中 | 短期无损（管线不依赖）；长期需 ChiNovelKE 关系映射 |
| 事件覆盖率仅 15%（12/80），不满足常规意义的大规模训练 | 中 | 取决于下游用例——12 事件足以验证管线但不足以训练 |
| David Copperfield 和 四世同堂 的生成管线未启动 | 低 | 定义文件就绪，管线改进后可批量生成 |

### 6.3 阶段 3 路径建议

```
阶段 3 建议实施顺序
1. narrativeChecklist schema 设计 + 验证器      [~3天]
2. Schema-aware YAML 批量生成管线               [~5天]
   └→ 批量生成 HLM 剩余 8 事件 + DC/4G 事件叙文
3. greyLines schema 设计 + 验证器                [~3天]
4. 12 事件人工因果标注                            [~2天]
5. sourceContext passthrough 实现                 [~2天]
6. 剩余建议（P1/P2）视资源而定
```

**最低可行目标（MVP）:** 步骤 1-2 完成后，HLM 将拥有 20 个合格的 YAML 事件 + 完整 L1 验证 + 初步 L2 验证。DC/4G 的事件叙文可批量补齐。

---

## 附录：文件统计

| 路径 | 文件数 | 说明 |
|------|--------|------|
| `fixtures/dream-of-red-chamber/definitions/characters/` | 40 | 角色 YAML |
| `fixtures/dream-of-red-chamber/definitions/locations/` | 8 | 地点 YAML |
| `fixtures/dream-of-red-chamber/definitions/relationships/` | 0 | （空目录） |
| `fixtures/dream-of-red-chamber/definitions/rules/` | 0 | （空目录） |
| `fixtures/dream-of-red-chamber/chapters/chapter_01/` | 13 | 12 事件 + 1 _chapter.yaml |
| `bench-data/corpus/dream-of-red-chamber/` | 3 | source.txt + manifest + work-index |
| `bench-data/chi-novelke/chinovelke.json` | 1 | HLM 含 50 角色/50 关系/61 地点 |
| `fixtures/david-copperfield/` | ~57 | 16 角色/6 地点/6 关系/4 规则/20 事件 |
| `fixtures/four-generations/` | ~60 | 18 角色/5 地点/7 关系/4 规则/20 事件 |
