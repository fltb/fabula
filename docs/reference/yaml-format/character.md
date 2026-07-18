# 角色 YAML 格式

**源类型：** `packages/core/src/types/character.ts` (CharacterDefinition)  
**Schema：** 通过 `EntityMapper` 中的 YAML 加载内联定义

角色被定义为 `definitions/characters/` 目录下的 YAML 文件。每个文件定义一个 `CharacterDefinition`——故事角色的完整规范，包括其特质、外貌、声音、别名和初始世界状态。

## CharacterDefinition 字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | `string` | 唯一标识符（例如 `xianglins_wife`、`narrator`） |
| `name` | `string` | 故事语言中的显示名称（例如 `祥林嫂`、`我`） |
| `type` | `string` | 角色类型标签（例如 `tragic_protagonist`、`intellectual_witness`、`domestic_manager`） |
| `archetype` | `string`（可选） | 叙事原型（例如 `victim_of_system`、`passive_observer`） |
| `faction` | `string`（可选） | 阵营归属 |
| `role` | `enum`（可选） | `minor`、`supporting`、`antagonist`、`background` |
| `description` | `string` | 角色的完整散文描述（可多行） |
| `traits` | `string[]` | 特质标签（例如 `hardworking`、`superstitious`、`traumatized`） |
| `voiceNotes` | `string`（可选） | 说话模式、特征性短语和对话指导 |
| `appearance` | `string`（可选） | 角色的视觉描述 |
| `aliases` | `string[]`（可选） | 该角色的别名或头衔 |
| `gender` | `string`（可选） | 性别认同（男/女/male/female） |
| `age` | `number \| string`（可选） | 年龄或年龄范围 |
| `profession` | `string`（可选） | 职业或社会角色 |
| `backstory` | `string`（可选） | 完整的背景故事叙述 |
| `knownSecrets` | `string[]`（可选） | 角色所知的可能不公开的信息 |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——直接流入 `EntityRegistry` |

## 角色状态的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadDefinitions()` 读取所有角色 YAML 文件，并将每个角色注册为 `kind: 'character'` 的 `Entity`。`initialState` 值成为注册表中实体的初始属性。

2. **EntityRegistry → CharacterSnapshot** — 在上下文编译期间，`ContextCompiler` 将相关实体转换为 `CharacterSnapshot` 对象。每个快照包含角色的当前属性（位置、状态、情感状态）、特质、声音注释和关系上下文。

3. **CharacterSnapshot → ContextPackage → LLM 提示** — `ContextPackage` 将所有角色快照捆绑在一起，并赋予优先级加权的相关性分数。`PromptAssembler` 将其渲染到 Pass 1 散文提示中，为 LLM 提供完整的角色上下文。

4. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中角色的属性通过后置条件解析进行更新。这确保上下文始终反映最新状态。

## 示例（来自 zhu-fu 测试夹具: xianglins_wife.yaml）

```yaml
id: xianglins_wife
name: "祥林嫂"
type: tragic_protagonist
archetype: victim_of_system
role: supporting
description: "祥林嫂是个二十六七岁（初到鲁镇时）到四十岁上下（死时）的农村寡妇..."
appearance: "初到鲁镇：脸色青黄但两颊还是红的，手脚壮大，安分耐劳的农妇模样。"
aliases:
  - "祥林嫂"
  - "祥林的妻子"
  - "老了的"
  - "谬种"
gender: "女"
age: "约二十六七岁到四十岁"
profession: "佣工"
traits:
  - hardworking
  - obedient
  - resilient
  - superstitious
  - traumatized
  - repetitive_storyteller
  - spiritually_broken
  - silenced
  - nameless
voiceNotes: "初到鲁镇时沉默寡言，只是不停地做活。丧子后反复讲述阿毛被狼叼走的故事——'我真傻，真的'是她的标志句..."
initialState:
  location: weijia_shan
  status: alive
  condition: "widowed_seeking_work"
  marital_status: "widow_of_xianglin"
  emotionalState: "fearful_but_determined"
  spiritual_state: "innocent"
backstory: "她是卫家山人，家里穷，年纪很小的时候就嫁给了比她小十岁的祥林..."
knownSecrets:
  - "她曾从婆家逃跑，这被视为不守妇道"
  - "她是被绑着、塞进花轿强行嫁给贺老六的"
```
