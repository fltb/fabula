#!/usr/bin/env node
// Regenerate 红楼梦 event YAMLs with per-file validation
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const EVENTS_DIR = join(REPO, 'fixtures/dream-of-red-chamber/chapters/chapter_01');

const manifest = JSON.parse(
  readFileSync(join(REPO, 'bench-data/corpus/dream-of-red-chamber/source-manifest.json'), 'utf-8'),
);
const src = readFileSync(join(REPO, 'bench-data/corpus/dream-of-red-chamber/source.txt'), 'utf-8');

// Top 40 characters from ChiNovelKE
const KNOWN_CHARS = `wangfuren(王夫人), jiabaoyu(贾宝玉), jiamu(贾母), xiren(袭人), wangxifeng(王熙凤), jiazheng(贾政), pinger(平儿), jialian(贾琏), liwan(李纨), tanchun(探春), xueyima(薛姨妈), jiazhen(贾珍), xingfuren(邢夫人), xichun(惜春), zijuan(紫鹃), yuanyang(鸳鸯), sheyue(麝月), youshi(尤氏), jiashe(贾赦), qingwen(晴雯), yingchun(迎春), jiahuan(贾环), jiarong(贾蓉), xuepan(薛蟠), zhaoyiniang(赵姨娘), lindaiyu(林黛玉), shixiangyun(史湘云), xuebaochai(薛宝钗), miaoyu(妙玉), xiangling(香菱), yuanchun(贾元春), qin_keqing(秦可卿), liulaolao(刘姥姥), jia_yucun(贾雨村), zhen_shiyin(甄士隐), jiarui(贾瑞), liuxianglian(柳湘莲), you_erjie(尤二姐), you_sanjie(尤三姐)`;

const THREADS = `T1=真假幻灭与石头历劫(主题), T2=凤姐的权力轨迹(人物弧), T3=贾府由盛转衰(主线), T4=宝黛情缘与心灵共鸣(主线), T5=大观园众芳聚散与诗社(支线), T6=宝玉的精神觉醒与出世(人物弧), T7=礼制与人际权力网(主题)`;

const CHAPTERS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
  52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
  76, 77, 78, 79, 80,
];

// Process chapters in batches
const BATCH_SIZE = 5;
const targetChapters = process.argv[2] ? [parseInt(process.argv[2])] : CHAPTERS;

for (let i = 0; i < targetChapters.length; i++) {
  const chNum = targetChapters[i];
  const ch =
    manifest.chapters.find((c) => c.title.includes(`第${chNum}回`)) || manifest.chapters[chNum - 1];
  if (!ch) {
    console.log(`Skip ch${chNum}: not found`);
    continue;
  }

  const chapterText = src.slice(ch.startByte, ch.endByte).slice(0, 6000);

  const prompt = `你是文学数据标注员。请为以下《红楼梦》第${chNum}回生成一个严格格式的YAML事件文件。

已知人物(只能用这些ID): ${KNOWN_CHARS}
已知线索: ${THREADS}

=== 原文 ===
${chapterText}

=== 请输出完整的YAML事件文件（不要markdown标记，必须是合法YAML）===

格式要求——每个字段的缩进必须精确：
\`\`\`yaml
event: E${chNum}
title: "回目标题（中文）"
narrativeOrder: ${chNum}
sceneType: linear
storyTime: story_start
narrationTime: story_start
tense: past
discourseMode: summary
arcPosition: opening
emotionalValence: descriptive_label
conflictType: person_vs_fate
pov:
  character: narrator_omniscient
  type: omniscient
sceneBrief: "3-5句中文事实摘要"
preconditions:
  - entity: entityId1
    attribute: attr_name
    value: attr_value
  - entity: entityId2
    attribute: attr_name
    value: attr_value
expectedPostconditions:
  - entity: entityId1
    attribute: attr_name
    value: attr_value
    confidence: 0.9
  - entity: entityId2
    attribute: attr_name
    value: attr_value
    confidence: 0.9
threadProgress:
  - thread: T1
    advancement: "本回对这条线索的推进描述"
    progressAfter: 10
    progressTotal: 100
  - thread: T3
    advancement: "本回对这条线索的推进描述"
    progressAfter: 15
    progressTotal: 100
foreshadowing:
  - id: fs_ch${chNum}_hint1
    hint: "伏笔描述"
    targetRevealChapter: 1
    thread: T1
relationshipEffects: []
ruleEffects: []
introduces:
  - type: character
    id: entityId
    initialState:
      status: alive
      condition: brief_description
styleGuidance:
  tone: "中文基调"
  targetWordCount: 600
  atmosphere: "中文氛围描述"
  scenePacing: "节奏描述"
  characterVoice: {}
\`\`\`

注意事项:
1. entity ID 只能用上面提供的已知人物列表中的ID
2. preconditions 和 expectedPostconditions 中每个条目的缩进必须一致
3. attribute 和 value 必须是简短英文标识符（snake_case）
4. sceneBrief 必须是中文
5. 至少包含2条 threadProgress
6. 输出必须是合法YAML，不要有任何markdown标记`;

  console.log(`[${i + 1}/${targetChapters.length}] Generating E${chNum}...`);

  let success = false;
  for (let attempt = 0; attempt < 3 && !success; attempt++) {
    try {
      const result = await completion(prompt, { model: 'slow' });
      // Strip markdown fences
      const yamlStr = result
        .replace(/^```ya?ml\n?/gm, '')
        .replace(/```$/gm, '')
        .trim();

      // Validate YAML parsing
      const parsed = YAML.parse(yamlStr);
      if (!parsed || !parsed.event) throw new Error('Missing event field');

      // Write file
      const slug = parsed.title
        ? parsed.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 40)
        : `ch${chNum}`;
      const filename = `E${String(chNum).padStart(2, '0')}_${slug}.yaml`;
      writeFileSync(join(EVENTS_DIR, filename), yamlStr, 'utf-8');
      console.log(`  ✓ ${filename}`);
      success = true;
    } catch (e) {
      console.log(`  ✗ attempt ${attempt + 1}: ${e.message.slice(0, 80)}`);
    }
  }
  if (!success) console.log(`  ❌ FAILED after 3 attempts`);
}

console.log('\nDone.');
