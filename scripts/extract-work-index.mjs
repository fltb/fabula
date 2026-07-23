#!/usr/bin/env node
// ============================================================================
// extract-work-index.mjs — LLM-powered WorkIndex extraction from source texts
//
// Feeds chapter text + known character list to LLM, extracts structured
// CharacterAnchor[], LocationAnchor[], ThreadAnchor[], NarrativeNodeAnchor[]
// per chapter. Batches 5 chapters per LLM call.
//
// Usage: node scripts/extract-work-index.mjs <work-id>
//   work-id: dream-of-red-chamber | david-copperfield | four-generations-87
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

const WORK_CONFIG = {
  'dream-of-red-chamber': {
    displayName: '红楼梦 前80回',
    corpusDir: 'bench-data/corpus/dream-of-red-chamber',
    language: 'zh',
    knownCharacters: [
      { entityId: 'char_jiabaoyu', primaryName: '贾宝玉', aliases: ['宝玉','宝二爷','怡红公子','绛洞花主','富贵闲人','混世魔王'] },
      { entityId: 'char_lindaiyu', primaryName: '林黛玉', aliases: ['黛玉','颦儿','潇湘妃子','林妹妹'] },
      { entityId: 'char_xuebaochai', primaryName: '薛宝钗', aliases: ['宝钗','宝姐姐','蘅芜君'] },
      { entityId: 'char_wangxifeng', primaryName: '王熙凤', aliases: ['凤姐','凤辣子','琏二奶奶'] },
      { entityId: 'char_jiamu', primaryName: '贾母', aliases: ['老太太','老祖宗','史太君'] },
      { entityId: 'char_jiazheng', primaryName: '贾政', aliases: ['政老爷','存周'] },
      { entityId: 'char_wangfuren', primaryName: '王夫人', aliases: ['太太'] },
      { entityId: 'char_xifuren', primaryName: '邢夫人', aliases: ['大太太'] },
      { entityId: 'char_jiashe', primaryName: '贾赦', aliases: ['赦老爷','恩侯'] },
      { entityId: 'char_jiazhen', primaryName: '贾珍', aliases: ['珍大爷'] },
      { entityId: 'char_jialian', primaryName: '贾琏', aliases: ['琏二爷'] },
      { entityId: 'char_jiayuanchun', primaryName: '贾元春', aliases: ['元春','元妃','大小姐'] },
      { entityId: 'char_jiayingchun', primaryName: '贾迎春', aliases: ['迎春','二木头','二小姐'] },
      { entityId: 'char_jiatanchun', primaryName: '贾探春', aliases: ['探春','三姑娘','蕉下客'] },
      { entityId: 'char_jiaxichun', primaryName: '贾惜春', aliases: ['惜春','四小姐'] },
      { entityId: 'char_liwan', primaryName: '李纨', aliases: ['大嫂子','稻香老农'] },
      { entityId: 'char_shiuiangyun', primaryName: '史湘云', aliases: ['湘云','云儿','枕霞旧友'] },
      { entityId: 'char_miaoyu', primaryName: '妙玉', aliases: ['妙玉师父'] },
      { entityId: 'char_qinwen', primaryName: '晴雯', aliases: ['晴雯丫头'] },
      { entityId: 'char_xiren', primaryName: '袭人', aliases: ['花袭人','花珍珠','蕊珠'] },
      { entityId: 'char_pinger', primaryName: '平儿', aliases: ['平姑娘'] },
      { entityId: 'char_yuanyang', primaryName: '鸳鸯', aliases: ['金鸳鸯','鸳鸯姐姐'] },
      { entityId: 'char_ziuan', primaryName: '紫鹃', aliases: ['紫鹃丫头','鹦哥'] },
      { entityId: 'char_xiangling', primaryName: '香菱', aliases: ['甄英莲','秋菱'] },
      { entityId: 'char_liuxianglian', primaryName: '柳湘莲', aliases: ['冷二郎','冷面郎君'] },
      { entityId: 'char_jiaqiang', primaryName: '贾蔷', aliases: ['蔷哥儿'] },
      { entityId: 'char_jiaqin', primaryName: '贾芹', aliases: ['芹哥儿'] },
      { entityId: 'char_jiahuan', primaryName: '贾环', aliases: ['环三爷'] },
      { entityId: 'char_xuepan', primaryName: '薛蟠', aliases: ['薛大傻子','呆霸王'] },
      { entityId: 'char_liulaolao', primaryName: '刘姥姥', aliases: ['刘老老'] },
    ],
    knownLocations: [
      { locationId: 'loc_rongguofu', name: '荣国府' },
      { locationId: 'loc_ningguofu', name: '宁国府' },
      { locationId: 'loc_daguanyuan', name: '大观园' },
      { locationId: 'loc_yihongyuan', name: '怡红院' },
      { locationId: 'loc_xiaoxiangguan', name: '潇湘馆' },
      { locationId: 'loc_hengwuyuan', name: '蘅芜苑' },
      { locationId: 'loc_daoxiangcun', name: '稻香村' },
      { locationId: 'loc_qiushuangzhai', name: '秋爽斋' },
    ],
    knownThreads: [
      { threadId: 'thread_baoyu_daiyu', name: '宝黛爱情', type: 'main' },
      { threadId: 'thread_jiashuai', name: '贾府兴衰', type: 'main' },
      { threadId: 'thread_yuanyang', name: '元春省亲', type: 'sub' },
      { threadId: 'thread_wangxifeng', name: '凤姐理家', type: 'sub' },
      { threadId: 'thread_xiangqi', name: '十二钗命运', type: 'main' },
    ],
  },
  'david-copperfield': {
    displayName: 'David Copperfield',
    corpusDir: 'bench-data/corpus/david-copperfield',
    language: 'en',
    knownCharacters: [
      { entityId: 'char_david', primaryName: 'David Copperfield', aliases: ['Davy','Trotwood','Trot','Daisy','Master Copperfield'] },
      { entityId: 'char_clara', primaryName: 'Clara Copperfield', aliases: ['Mrs Copperfield','Clara'] },
      { entityId: 'char_peggotty', primaryName: 'Clara Peggotty', aliases: ['Peggotty','Mrs Barkis'] },
      { entityId: 'char_murdstone', primaryName: 'Edward Murdstone', aliases: ['Mr Murdstone'] },
      { entityId: 'char_jane_murdstone', primaryName: 'Jane Murdstone', aliases: ['Miss Murdstone'] },
      { entityId: 'char_betsey', primaryName: 'Betsey Trotwood', aliases: ['Miss Trotwood','Aunt Betsey','Miss Betsey'] },
      { entityId: 'char_mr_dick', primaryName: 'Mr Dick', aliases: ['Richard Babley'] },
      { entityId: 'char_steerforth', primaryName: 'James Steerforth', aliases: ['Steerforth'] },
      { entityId: 'char_traddles', primaryName: 'Tommy Traddles', aliases: ['Traddles'] },
      { entityId: 'char_micawber', primaryName: 'Wilkins Micawber', aliases: ['Mr Micawber'] },
      { entityId: 'char_mrs_micawber', primaryName: 'Emma Micawber', aliases: ['Mrs Micawber'] },
      { entityId: 'char_uriah_heep', primaryName: 'Uriah Heep', aliases: ['Heep','Ury'] },
      { entityId: 'char_agnes', primaryName: 'Agnes Wickfield', aliases: ['Agnes'] },
      { entityId: 'char_mr_wickfield', primaryName: 'Mr Wickfield', aliases: ['Wickfield'] },
      { entityId: 'char_dora', primaryName: 'Dora Spenlow', aliases: ['Dora','Mrs Copperfield'] },
      { entityId: 'char_emily', primaryName: 'Little Emily', aliases: ['Emily','Em\'ly','Little Em\'ly'] },
      { entityId: 'char_dan_peggotty', primaryName: 'Daniel Peggotty', aliases: ['Mr Peggotty','Dan'] },
      { entityId: 'char_ham', primaryName: 'Ham Peggotty', aliases: ['Ham'] },
      { entityId: 'char_mrs_gummidge', primaryName: 'Mrs Gummidge', aliases: ['Gummidge'] },
      { entityId: 'char_creakle', primaryName: 'Mr Creakle', aliases: ['Creakle'] },
      { entityId: 'char_barkis', primaryName: 'Mr Barkis', aliases: ['Barkis'] },
      { entityId: 'char_dr_strong', primaryName: 'Dr Strong', aliases: ['Doctor Strong'] },
      { entityId: 'char_littimer', primaryName: 'Littimer', aliases: ['Mr Littimer'] },
      { entityId: 'char_rosa_dartle', primaryName: 'Rosa Dartle', aliases: ['Miss Dartle','Rosa'] },
      { entityId: 'char_martha', primaryName: 'Martha Endell', aliases: ['Martha'] },
      { entityId: 'char_mr_spenlow', primaryName: 'Mr Spenlow', aliases: ['Spenlow'] },
      { entityId: 'char_miss_mowcher', primaryName: 'Miss Mowcher', aliases: ['Mowcher'] },
    ],
    knownLocations: [
      { locationId: 'loc_blunderstone', name: 'Blunderstone Rookery' },
      { locationId: 'loc_yarmouth', name: 'Yarmouth' },
      { locationId: 'loc_dover', name: 'Dover' },
      { locationId: 'loc_canterbury', name: 'Canterbury' },
      { locationId: 'loc_london', name: 'London' },
      { locationId: 'loc_salem_house', name: 'Salem House School' },
      { locationId: 'loc_doctors_commons', name: 'Doctors\' Commons' },
    ],
    knownThreads: [
      { threadId: 'thread_bildungsroman', name: 'Growth and Maturity', type: 'main' },
      { threadId: 'thread_dora_agnes', name: 'Dora vs Agnes Romance', type: 'main' },
      { threadId: 'thread_uriah_heep', name: 'Uriah Heep\'s Schemes', type: 'sub' },
      { threadId: 'thread_emily_steerforth', name: 'Emily and Steerforth Tragedy', type: 'sub' },
      { threadId: 'thread_micawber', name: 'Micawber\'s Fortunes', type: 'sub' },
    ],
  },
  'four-generations-87': {
    displayName: '四世同堂 87章',
    corpusDir: 'bench-data/corpus/four-generations/four-generations-87',
    language: 'zh',
    knownCharacters: [
      { entityId: 'char_sr_qi', primaryName: '祁老人', aliases: ['祁老太爷','老太爷','祁大个子'] },
      { entityId: 'char_qi_tianyou', primaryName: '祁天佑', aliases: ['天佑','祁掌柜'] },
      { entityId: 'char_qi_ruixuan', primaryName: '祁瑞宣', aliases: ['瑞宣','大哥'] },
      { entityId: 'char_qi_ruifeng', primaryName: '祁瑞丰', aliases: ['瑞丰','老二'] },
      { entityId: 'char_qi_ruiquan', primaryName: '祁瑞全', aliases: ['瑞全','老三'] },
      { entityId: 'char_yunmei', primaryName: '韵梅', aliases: ['小顺儿的妈','小顺儿妈'] },
      { entityId: 'char_qian_moyin', primaryName: '钱默吟', aliases: ['钱先生','钱诗人'] },
      { entityId: 'char_guan_xiaohe', primaryName: '冠晓荷', aliases: ['冠先生'] },
      { entityId: 'char_da_chibao', primaryName: '大赤包', aliases: ['冠大奶奶','冠太太'] },
      { entityId: 'char_gaodi', primaryName: '冠高第', aliases: ['高第','大妹妹'] },
      { entityId: 'char_zhaodi', primaryName: '冠招弟', aliases: ['招弟','二妹妹'] },
      { entityId: 'char_you_tongfang', primaryName: '尤桐芳', aliases: ['桐芳'] },
      { entityId: 'char_li_siye', primaryName: '李四爷', aliases: ['四爷','李四'] },
      { entityId: 'char_xiao_cui', primaryName: '小崔', aliases: [] },
      { entityId: 'char_sun_qi', primaryName: '孙七', aliases: [] },
      { entityId: 'char_xiao_wen', primaryName: '小文', aliases: ['文侯爷'] },
      { entityId: 'char_wen_ruoxia', primaryName: '文若霞', aliases: ['若霞','小文太太'] },
      { entityId: 'char_baixunzhang', primaryName: '白巡长', aliases: ['白巡警'] },
      { entityId: 'char_chang_erye', primaryName: '常二爷', aliases: ['老常'] },
    ],
    knownLocations: [
      { locationId: 'loc_xiaoyangquan', name: '小羊圈胡同' },
      { locationId: 'loc_qijia', name: '祁家' },
      { locationId: 'loc_qianjia', name: '钱家' },
      { locationId: 'loc_guanjia', name: '冠家' },
      { locationId: 'loc_beijing', name: '北平' },
    ],
    knownThreads: [
      { threadId: 'thread_resistance', name: '抗日救国', type: 'main' },
      { threadId: 'thread_ruixuan', name: '祁瑞宣的苦闷与觉醒', type: 'main' },
      { threadId: 'thread_qianjiaren', name: '钱家人的抗争', type: 'sub' },
      { threadId: 'thread_hanjian', name: '汉奸的丑态', type: 'sub' },
      { threadId: 'thread_smallfolk', name: '小人物群像', type: 'sub' },
    ],
  },
};

const workId = process.argv[2];
if (!workId || !WORK_CONFIG[workId]) {
  console.error('Usage: node scripts/extract-work-index.mjs <work-id>');
  console.error('  work-id: ' + Object.keys(WORK_CONFIG).join(' | '));
  process.exit(1);
}

const config = WORK_CONFIG[workId];
const manifestPath = join(REPO, config.corpusDir, 'source-manifest.json');
const sourcePath = join(REPO, config.corpusDir, 'source.txt');
const outputPath = join(REPO, config.corpusDir, 'work-index.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const sourceText = readFileSync(sourcePath, 'utf-8');

console.log(`=== ${config.displayName} — LLM WorkIndex Extraction ===`);
console.log(`  Chapters: ${manifest.chapters.length}`);
console.log(`  Characters: ${config.knownCharacters.length}`);
console.log(`  Locations: ${config.knownLocations.length}`);

// Extract chapter texts using byte offsets from manifest
const chapterTexts = [];
for (const ch of manifest.chapters) {
  const text = sourceText.slice(ch.startByte, ch.endByte);
  chapterTexts.push({ id: ch.chapterId, title: ch.title, text, wordCount: ch.wordCount });
}

console.log(`  Chapter texts extracted: ${chapterTexts.length}`);

// Build the prompt for LLM batch extraction
// We'll process 5 chapters at a time to keep context manageable
const BATCH_SIZE = 5;
const batches = [];
for (let i = 0; i < chapterTexts.length; i += BATCH_SIZE) {
  batches.push(chapterTexts.slice(i, i + BATCH_SIZE));
}

console.log(`  Batches: ${batches.length} (${BATCH_SIZE} chapters each)`);

// Instead of running LLM calls here (which requires API setup),
// generate a work-index template with chapter metadata and known entities.
// The LLM extraction would fill in per-chapter appearances and scene candidates.

// For now, build a minimal WorkIndex with chapter boundaries and known entities.
const workIndex = {
  workId: manifest.workId,
  editionId: manifest.editionId,
  version: '1.0.0',
  frozenAt: new Date().toISOString(),
  sourceHash: manifest.sourceHash,
  chapters: manifest.chapters,
  characters: config.knownCharacters.map(c => ({
    ...c,
    firstAppearance: null, // Would be filled by LLM
    chapters: [],          // Would be filled by LLM
  })),
  locations: config.knownLocations.map(l => ({
    ...l,
    chapters: [],
  })),
  threads: config.knownThreads.map(t => ({
    ...t,
    chapters: [],
    status: 'planned',
  })),
  narrativeNodes: [],
  discourseNodes: [],
  candidates: [],
  extractionMethod: 'llm-assisted',
  extractionStatus: 'template-only', // 'complete' when LLM extraction is done
  extractionNotes: 'Chapter boundaries, known characters/locations/threads from Wikipedia + LLM extraction pending. Per-chapter appearance data needs LLM pass.',
};

writeFileSync(outputPath, JSON.stringify(workIndex, null, 2), 'utf-8');
console.log(`\n  WorkIndex template written: ${outputPath}`);
console.log(`  Status: template-only (LLM extraction pending)`);
console.log(`  Characters: ${workIndex.characters.length}`);
console.log(`  Locations: ${workIndex.locations.length}`);
console.log(`  Threads: ${workIndex.threads.length}`);

// Print next steps
console.log(`\n=== Next Steps ===`);
console.log(`  1. Use eval completion() to extract per-chapter appearances`);
console.log(`  2. Feed batches of chapter text + character list to LLM`);
console.log(`  3. Fill in characters[*].chapters, locations[*].chapters, threads[*].chapters`);
console.log(`  4. Identify NarrativeNode anchors from LLM-identified scene boundaries`);
console.log(`  5. Run corpus gate validation`);
