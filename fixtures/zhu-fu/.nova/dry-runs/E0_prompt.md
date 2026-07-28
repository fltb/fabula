## Role
You produce clean literary prose from a narrative context package. Your output is pure narrative text with no metadata.

## Instructions
- Write ONLY the scene narrative. No planning. No self-analysis. No section headers. No JSON.
- Begin directly with the action or description. Do not label or explain the scene.
- Stay strictly in the POV character's perspective (third-person limited unless stated otherwise).
- Use sensory detail and interiority. Show emotional state through physical detail, not abstract summary.
- Do NOT contradict any established fact from the context package.
- End when this scene's narrative beat is complete. A clean break is better than over-writing.
- Target length: ~1700 字（characters）.
- Tone: 冷峻、不安、深冬的沉闷.
- Pacing: 缓慢铺陈→突然相遇→匆促逃离.
- Atmosphere: 灰白色的沉重晚云，满天飞舞的雪花，爆竹的火药香——鲁镇的年终氛围与祥林嫂的凄凉形成对照。.
- This scene should be approximately 1700 字 long. This is a firm target — do not significantly under- or over-write.
- Emotional keynote: unsettling_encounter_guilt.
- Character voice: narrator: 第一人称叙述，内省而犹豫。面对问题时语无伦次——'也许有罢——我想'、'说不清'。; xianglins_wife: 单刀直入的三连问，不绕弯子。她已没有时间和精力客套——这是她人生最后的提问。

## Narrative Coverage Requirements
The following narrative dimensions must be addressed in this scene prose:
- [REQUIRED] 对话个性: 祥林嫂的三连问直接而急迫，'我'的回答含糊逃避——对话体现人物性格和关系张力
- [REQUIRED] 反讽距离: 全镇忙祝福与祥林嫂走向死亡形成叙事反讽
- [recommended] 心理描写: '我'的内心不安——'说不清'的自我欺骗

## Source Style Anchors
Reference these style elements from the original text as prose guidance:
- "她是五年前的花白的头发，即今已经全白，全不像四十上下的人；脸上瘦削不堪，黄中带黑，而且消尽了先前悲哀的神色，仿佛是木刻似的；只有那眼珠间或一轮，还可以表示她是一个活物。" (鲁迅的白描——用外貌的逐层剥落暗示内在生命力的消亡。'眼珠间或一轮'是唯一的生命证据，也是通往死亡的渐进。)
- "'就是——'她走近两步，放低了声音，极秘密似的切切的说，'一个人死了之后，究竟有没有魂灵的？'" (灵魂之问必须以原文的突兀停顿、低声和切切追问呈现；保留问题本身，不将其改写成抽象主题说明。)
- "'说不清'是一句极有用的话。不更事的勇敢的少年，往往敢于给人解决疑问……然而一用这说不清来作结束，便事事逍遥自在了。" (鲁迅的反讽叙事距离——'我'用'说不清'为道德逃避辩护，但叙述者反讽地暴露了这种自欺。)

## Work Synopsis
一个返乡的知识分子在鲁镇遇见沦为乞丐的祥林嫂，她问他关于灵魂和地狱的问题，随后在除夕夜冻死街头。通过倒叙，故事展现了她悲惨的一生——被婆婆卖掉改嫁、丧夫失子、被主家视为不洁、捐门槛赎罪仍被排斥，最终在众人的祝福声中孤寂死去。

## Thematic Intent
封建礼教吃掉个体——鲁镇'祝福'仪式是社会合谋的镜像
Sub-themes: 知识分子的道德无力——'我'的'说不清'是启蒙失败的自供, 女性的三重压迫——夫权、族权、神权, 叙述的伦理——讲述他人的苦难是否本身就是一种剥削, 孤独与沟通的不可能性——祥林嫂的三连问无人能答

## Narrator
Type: retrospective_entity
Fidelity: reliable; Sincerity: sincere

## Author Notes
- 本场以《祝福》原文为唯一表述基准：优先保持 sourceContext 中原句的语序、关键词、对白与留白。
- 以三问三答和“说不清”的自我辩解为中心；不得补写原文没有的人物行为、灵魂答案或现代化解释。

## Narrative Context Package
```json
{
  "eventId": "E0",
  "systemContext": {
    "genre": "literary",
    "style": "literary",
    "narrativeRules": [],
    "thematicIntent": {
      "primaryTheme": "封建礼教吃掉个体——鲁镇'祝福'仪式是社会合谋的镜像",
      "subThemes": [
        "知识分子的道德无力——'我'的'说不清'是启蒙失败的自供",
        "女性的三重压迫——夫权、族权、神权",
        "叙述的伦理——讲述他人的苦难是否本身就是一种剥削",
        "孤独与沟通的不可能性——祥林嫂的三连问无人能答"
      ]
    },
    "synopsis": "一个返乡的知识分子在鲁镇遇见沦为乞丐的祥林嫂，她问他关于灵魂和地狱的问题，随后在除夕夜冻死街头。通过倒叙，故事展现了她悲惨的一生——被婆婆卖掉改嫁、丧夫失子、被主家视为不洁、捐门槛赎罪仍被排斥，最终在众人的祝福声中孤寂死去。"
  },
  "sceneSpec": {
    "goal": "旧历年底，叙述者'我'回到故乡鲁镇，暂住在四叔鲁四老爷家。除夕前日，'我'在镇东头河边遇到沦为乞丐的祥林嫂——她头发全白，脸黄中带黑，木刻似的神情，只有眼珠间或一轮表明她还活着。她突然拦住'我'，用发亮的眼睛盯着'我'，问了三个关于灵魂和地狱的问题：人死了有没有灵魂？有没有地狱？死去的家人能不能见面？'我'在惊慌中给出含糊的回答——'也许有罢……说不清'——然后匆匆逃回四叔家，心中惴惴不安。",
    "povType": "first_person",
    "povCharacter": "narrator",
    "conflict": "缓慢铺陈→突然相遇→匆促逃离",
    "expectedOutcome": "narrator.knowledge = encountered_xianglins_wife; narrator.emotionalState = guilty_uneasy; xianglins_wife.spiritual_state = undefined; narrator.knowledge_of_xianglins_wife = saw_her_as_beggar; narrator.location = fourth_master_lu_house; xianglins_wife.emotionalState = undefined",
    "emotionalValence": "unsettling_encounter_guilt",
    "authorNotes": [
      "本场以《祝福》原文为唯一表述基准：优先保持 sourceContext 中原句的语序、关键词、对白与留白。",
      "以三问三答和“说不清”的自我辩解为中心；不得补写原文没有的人物行为、灵魂答案或现代化解释。"
    ]
  },
  "characterSnapshots": [
    {
      "id": "narrator",
      "name": "我",
      "currentState": {
        "lifecycle": "active",
        "aliases": [
          "我",
          "叙述者",
          "四叔的侄子"
        ],
        "gender": "男",
        "appearance": "一个年轻的知识分子，穿着城里人的衣服，与鲁镇的乡绅氛围格格不入。具体的面容和衣着 文中未详写，但从他与四老爷的关系和住在书房来看，他有读书人的清瘦气质。\n",
        "age": "约二十五岁至三十岁",
        "profession": "知识分子（新派读书人）",
        "traits": [
          "educated",
          "new_school",
          "morally_ambivalent",
          "introspective",
          "evasive",
          "guilt_prone",
          "self_justifying",
          "observant",
          "outsider_in_hometown"
        ],
        "location": "luchen_town",
        "status": "alive",
        "condition": "well",
        "purpose": "new_year_visit",
        "emotionalState": "restless_uneasy",
        "knowledge_of_xianglins_wife": "none_yet",
        "moral_state": "untested"
      },
      "traits": [
        "educated",
        "new_school",
        "morally_ambivalent",
        "introspective",
        "evasive",
        "guilt_prone",
        "self_justifying",
        "observant",
        "outsider_in_hometown"
      ],
      "voiceNotes": "",
      "appearance": "一个年轻的知识分子，穿着城里人的衣服，与鲁镇的乡绅氛围格格不入。具体的面容和衣着 文中未详写，但从他与四老爷的关系和住在书房来看，他有读书人的清瘦气质。\n"
    },
    {
      "id": "fourth_master_lu",
      "name": "鲁四老爷",
      "currentState": {
        "lifecycle": "active",
        "aliases": [
          "四叔",
          "鲁四老爷",
          "四老爷",
          "讲理学的老监生"
        ],
        "gender": "男",
        "appearance": "一个上了年纪的老监生，穿着传统士绅的长衫。面容威严，眉头常锁。家中陈设半旧半新，书房里挂着'事理通达心气和平'的对联。",
        "age": "约五十至六十岁",
        "profession": "地主士绅",
        "traits": [
          "conservative",
          "hypocritical",
          "patriarchal",
          "rigid",
          "superstitious",
          "class_conscious",
          "cruel_beneath_decorum",
          "anti_reform"
        ],
        "location": "luchen_town",
        "status": "alive",
        "condition": "well",
        "attitude_toward_xianglins_wife": "tolerant_but_suspicious"
      },
      "traits": [
        "conservative",
        "hypocritical",
        "patriarchal",
        "rigid",
        "superstitious",
        "class_conscious",
        "cruel_beneath_decorum",
        "anti_reform"
      ],
      "voiceNotes": "",
      "appearance": "一个上了年纪的老监生，穿着传统士绅的长衫。面容威严，眉头常锁。家中陈设半旧半新，书房里挂着'事理通达心气和平'的对联。"
    },
    {
      "id": "xianglins_wife",
      "name": "祥林嫂",
      "currentState": {
        "lifecycle": "active",
        "aliases": [
          "祥林嫂",
          "祥林的妻子",
          "老了的",
          "谬种"
        ],
        "gender": "女",
        "appearance": "white_hair_yellow_black_face_wooden_expression_beggars_basket",
        "age": "约二十六七岁到四十岁",
        "profession": "佣工",
        "traits": [
          "hardworking",
          "obedient",
          "resilient",
          "superstitious",
          "traumatized",
          "repetitive_storyteller",
          "spiritually_broken",
          "silenced",
          "nameless"
        ],
        "location": "luchen_streets",
        "status": "beggar",
        "condition": "widowed_seeking_work",
        "emotionalState": "spiritually_devastated",
        "spiritual_state": "broken",
        "work_capability": "none",
        "social_status": "widow_under_suspicion",
        "has_ah_mao": false,
        "marital_status": "widowed_twice",
        "has_donated_threshold": true
      },
      "traits": [
        "hardworking",
        "obedient",
        "resilient",
        "superstitious",
        "traumatized",
        "repetitive_storyteller",
        "spiritually_broken",
        "silenced",
        "nameless"
      ],
      "voiceNotes": "",
      "appearance": "初到鲁镇：脸色青黄但两颊还是红的，手脚壮大，安分耐劳的农妇模样。丧子归来：两颊血色消失，眼角带泪痕，眼光无神。崩溃后：脸色灰黑，眼睛窅陷，神情呆滞，直是一个木偶人。沦为乞丐：头发全白，脸黄中带黑，瘦削不堪，木刻似的，只有眼珠间或一轮表明她还活着。始终穿乌裙、蓝夹袄、月白背心，头上扎白头绳。额角有撞香案留下的伤疤。"
    },
    {
      "id": "liu_ma",
      "name": "柳妈",
      "currentState": {
        "lifecycle": "active",
        "aliases": [
          "柳妈",
          "善女人"
        ],
        "gender": "女",
        "appearance": "一个上了年纪的鲁镇老妇人，穿着素净。作为'善女人'，她的衣着可能带着信佛的标志（如素色衣服、念珠等）。面容是农村老太太的朴实模样，但絮叨起来很有活力。",
        "age": "约五十至六十岁",
        "profession": "帮工、信佛的善女人",
        "traits": [
          "pious",
          "talkative",
          "well_meaning",
          "superstitious",
          "unknowingly_cruel",
          "victim_herself"
        ],
        "location": "luchen_town",
        "status": "alive",
        "condition": "well"
      },
      "traits": [
        "pious",
        "talkative",
        "well_meaning",
        "superstitious",
        "unknowingly_cruel",
        "victim_herself"
      ],
      "voiceNotes": "",
      "appearance": "一个上了年纪的鲁镇老妇人，穿着素净。作为'善女人'，她的衣着可能带着信佛的标志（如素色衣服、念珠等）。面容是农村老太太的朴实模样，但絮叨起来很有活力。"
    }
  ],
  "relationshipContext": [],
  "worldFacts": [
    {
      "id": "fourth_master_lu.aliases",
      "description": "fourth_master_lu.aliases",
      "value": [
        "四叔",
        "鲁四老爷",
        "四老爷",
        "讲理学的老监生"
      ]
    },
    {
      "id": "fourth_master_lu.gender",
      "description": "fourth_master_lu.gender",
      "value": "男"
    },
    {
      "id": "fourth_master_lu.appearance",
      "description": "fourth_master_lu.appearance",
      "value": "一个上了年纪的老监生，穿着传统士绅的长衫。面容威严，眉头常锁。家中陈设半旧半新，书房里挂着'事理通达心气和平'的对联。"
    },
    {
      "id": "fourth_master_lu.age",
      "description": "fourth_master_lu.age",
      "value": "约五十至六十岁"
    },
    {
      "id": "fourth_master_lu.profession",
      "description": "fourth_master_lu.profession",
      "value": "地主士绅"
    },
    {
      "id": "fourth_master_lu.traits",
      "description": "fourth_master_lu.traits",
      "value": [
        "conservative",
        "hypocritical",
        "patriarchal",
        "rigid",
        "superstitious",
        "class_conscious",
        "cruel_beneath_decorum",
        "anti_reform"
      ]
    },
    {
      "id": "fourth_master_lu.location",
      "description": "fourth_master_lu.location",
      "value": "luchen_town"
    },
    {
      "id": "fourth_master_lu.status",
      "description": "fourth_master_lu.status",
      "value": "alive"
    },
    {
      "id": "fourth_master_lu.condition",
      "description": "fourth_master_lu.condition",
      "value": "well"
    },
    {
      "id": "fourth_master_lu.attitude_toward_xianglins_wife",
      "description": "fourth_master_lu.attitude_toward_xianglins_wife",
      "value": "tolerant_but_suspicious"
    },
    {
      "id": "narrator.aliases",
      "description": "narrator.aliases",
      "value": [
        "我",
        "叙述者",
        "四叔的侄子"
      ]
    },
    {
      "id": "narrator.gender",
      "description": "narrator.gender",
      "value": "男"
    },
    {
      "id": "narrator.appearance",
      "description": "narrator.appearance",
      "value": "一个年轻的知识分子，穿着城里人的衣服，与鲁镇的乡绅氛围格格不入。具体的面容和衣着 文中未详写，但从他与四老爷的关系和住在书房来看，他有读书人的清瘦气质。\n"
    },
    {
      "id": "narrator.age",
      "description": "narrator.age",
      "value": "约二十五岁至三十岁"
    },
    {
      "id": "narrator.profession",
      "description": "narrator.profession",
      "value": "知识分子（新派读书人）"
    },
    {
      "id": "narrator.traits",
      "description": "narrator.traits",
      "value": [
        "educated",
        "new_school",
        "morally_ambivalent",
        "introspective",
        "evasive",
        "guilt_prone",
        "self_justifying",
        "observant",
        "outsider_in_hometown"
      ]
    },
    {
      "id": "narrator.location",
      "description": "narrator.location",
      "value": "luchen_town"
    },
    {
      "id": "narrator.status",
      "description": "narrator.status",
      "value": "alive"
    },
    {
      "id": "narrator.condition",
      "description": "narrator.condition",
      "value": "well"
    },
    {
      "id": "narrator.purpose",
      "description": "narrator.purpose",
      "value": "new_year_visit"
    }
  ],
  "knowledgeBoundary": {
    "characterId": "narrator",
    "knownFacts": []
  },
  "activeThreads": [
    {
      "id": "T1",
      "name": "T1",
      "progress": 0,
      "total": 0,
      "description": ""
    },
    {
      "id": "T2",
      "name": "T2",
      "progress": 0,
      "total": 0,
      "description": "祥林嫂的灵魂之问开启了故事的核心主题。她的三连问——灵魂？地狱？死去的家人能否见面？——表明她内心的终极困境：希望与恐惧并存。"
    },
    {
      "id": "T3",
      "name": "T3",
      "progress": 0,
      "total": 0,
      "description": "叙述者'我'面对祥林嫂的问题选择了逃避——'说不清'。'我'代表知识分子在目睹苦难时的道德软弱。"
    },
    {
      "id": "T4",
      "name": "T4",
      "progress": 0,
      "total": 0,
      "description": "外面的祝福忙乱与河边凄凉相遇形成对比——全镇人都在忙着迎福神，而祥林嫂正在走向死亡。"
    }
  ],
  "previousSceneSummary": "",
  "volumeSummary": "",
  "activeRules": [],
  "narratorProfile": {
    "id": "narrator_wo",
    "access": "full",
    "assertion": "constrained",
    "truth": "limited_knowledge",
    "fidelity": "reliable",
    "sincerity": "sincere",
    "type": "retrospective_entity",
    "knowledgeBoundary": "narrator_wo_present_day_knowledge"
  },
  "discourseProjection": {
    "plannedReveals": [
      "assertion_xianglin_death"
    ],
    "openClaims": [
      "assertion_afterlife_uncertain"
    ],
    "visibleHints": [],
    "accessibleClaims": [
      {
        "assertionId": "assertion_afterlife_uncertain",
        "narrator": "narrator_wo",
        "type": "claim",
        "surface": "灵魂和地狱是否存在——'也许有罢……说不清'"
      }
    ],
    "authorizedTargets": [
      {
        "assertionId": "assertion_xianglin_death",
        "actionType": "reveal",
        "discoursePosition": 1
      },
      {
        "assertionId": "assertion_afterlife_uncertain",
        "actionType": "claim",
        "discoursePosition": 1
      }
    ],
    "activeWithholdingPolicies": []
  }
}
```

## Output
Write the scene now. Output ONLY the prose text — no explanation, no formatting, no JSON.