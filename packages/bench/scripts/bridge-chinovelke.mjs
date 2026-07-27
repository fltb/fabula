#!/usr/bin/env node
// ============================================================================
// Bridge: Raw ChiNovelKE → Adapter-compatible ChiNovelKERawData format
// ============================================================================
//
// The real ChiNovelKE dataset (chinovelke.json) contains evaluation annotation
// entries for Chinese classical novels. These entries are structured as:
//   characters: {name, mention_count, is_valid_character, correct_name, ...}
//   relations:  {person_a, person_b, system_type, correct_type, correct_category, ...}
//   locations:  {name, correct_parent, tier}
//
// The adapter expects:
//   ChiNovelKECharacter: {id, name, aliases, gender, age_range, role, description, traits, relations, locations}
//   ChiNovelKERelationData: {id, type, from_id, to_id, direction, intensity, description}
//   ChiNovelKELocation: {id, name, parent_id, description, era}
//
// This script bridges the two formats, filling what's available and marking
// the rest with reasonable defaults or unavailable values.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

// ─── ID sanitization ────────────────────────────────────────────────────────

function sanitizeId(name) {
  // Keep Chinese characters, alphanumeric, underscores. Replace others with '_'.
  return name
    .replace(/[^\u4e00-\u9fff_a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// ─── Novel metadata → character traits/roles ────────────────────────────────

const NOVEL_CHARACTER_INFO = {
  journey_to_west: {
    孙悟空: {
      gender: '男',
      role: 'protagonist',
      traits: ['神通广大', '桀骜不驯', '忠诚'],
      age_range: '500+',
    },
    唐僧: { gender: '男', role: 'protagonist', traits: ['慈悲', '软弱', '执着'], age_range: '30+' },
    猪八戒: {
      gender: '男',
      role: 'supporting',
      traits: ['贪吃', '好色', '憨厚'],
      age_range: 'unknown',
    },
    沙僧: {
      gender: '男',
      role: 'supporting',
      traits: ['忠厚', '勤劳', '沉默'],
      age_range: 'unknown',
    },
    白龙马: {
      gender: '男',
      role: 'supporting',
      traits: ['忠诚', '忍辱负重'],
      age_range: 'unknown',
    },
    观音菩萨: {
      gender: '女',
      role: 'supporting',
      traits: ['慈悲', '智慧', '法力无边'],
      age_range: 'unknown',
    },
    如来佛祖: {
      gender: '男',
      role: 'background',
      traits: ['至高无上', '法力无边'],
      age_range: 'unknown',
    },
    玉皇大帝: { gender: '男', role: 'antagonist', traits: ['威严', '官僚'], age_range: 'unknown' },
    太白金星: { gender: '男', role: 'background', traits: ['老练', '圆滑'], age_range: 'unknown' },
    二郎神: {
      gender: '男',
      role: 'antagonist',
      traits: ['神通广大', '高傲'],
      age_range: 'unknown',
    },
    牛魔王: { gender: '男', role: 'antagonist', traits: ['强大', '狡猾'], age_range: 'unknown' },
    铁扇公主: { gender: '女', role: 'supporting', traits: ['泼辣', '母爱'], age_range: 'unknown' },
    红孩儿: { gender: '男', role: 'antagonist', traits: ['顽皮', '神通'], age_range: 'child' },
    白骨精: { gender: '女', role: 'antagonist', traits: ['狡猾', '残忍'], age_range: 'unknown' },
    蜘蛛精: { gender: '女', role: 'antagonist', traits: ['妖艳', '狠毒'], age_range: 'unknown' },
    镇元大仙: {
      gender: '男',
      role: 'supporting',
      traits: ['神通广大', '重情义'],
      age_range: 'unknown',
    },
  },
  dream_of_red_chamber: {
    贾宝玉: {
      gender: '男',
      role: 'protagonist',
      traits: ['多情', '叛逆', '纯真'],
      age_range: '13-19',
    },
    林黛玉: {
      gender: '女',
      role: 'protagonist',
      traits: ['才华横溢', '敏感', '孤傲'],
      age_range: '12-17',
    },
    薛宝钗: {
      gender: '女',
      role: 'supporting',
      traits: ['端庄', '世故', '博学'],
      age_range: '14-19',
    },
    王熙凤: {
      gender: '女',
      role: 'supporting',
      traits: ['精明', '泼辣', '狠毒'],
      age_range: '20-25',
    },
    贾母: { gender: '女', role: 'supporting', traits: ['慈祥', '权威', '享乐'], age_range: '70+' },
    贾政: { gender: '男', role: 'antagonist', traits: ['迂腐', '严厉', '封建'], age_range: '50+' },
    贾琏: { gender: '男', role: 'supporting', traits: ['好色', '纨绔'], age_range: '20-30' },
    史湘云: {
      gender: '女',
      role: 'supporting',
      traits: ['豪爽', '才情', '乐观'],
      age_range: '13-18',
    },
    妙玉: {
      gender: '女',
      role: 'supporting',
      traits: ['孤傲', '洁癖', '才情'],
      age_range: '18-20',
    },
    袭人: {
      gender: '女',
      role: 'supporting',
      traits: ['温顺', '忠诚', '心机'],
      age_range: '16-20',
    },
    晴雯: {
      gender: '女',
      role: 'supporting',
      traits: ['刚烈', '美丽', '直率'],
      age_range: '15-17',
    },
  },
  water_margin: {
    宋江: {
      gender: '男',
      role: 'protagonist',
      traits: ['忠义', '矛盾', '领导力'],
      age_range: '30-40',
    },
    武松: {
      gender: '男',
      role: 'protagonist',
      traits: ['勇猛', '正义', '嗜酒'],
      age_range: '25-30',
    },
    林冲: {
      gender: '男',
      role: 'protagonist',
      traits: ['忍辱', '武艺高强', '悲剧'],
      age_range: '30-35',
    },
    鲁智深: {
      gender: '男',
      role: 'protagonist',
      traits: ['豪爽', '正义', '粗中有细'],
      age_range: '30-40',
    },
    李逵: {
      gender: '男',
      role: 'supporting',
      traits: ['莽撞', '忠诚', '嗜杀'],
      age_range: '25-30',
    },
    吴用: {
      gender: '男',
      role: 'supporting',
      traits: ['智谋', '阴险', '忠心'],
      age_range: '30-40',
    },
    卢俊义: {
      gender: '男',
      role: 'supporting',
      traits: ['武艺高强', '富有', '被逼上梁山'],
      age_range: '35-45',
    },
    高俅: {
      gender: '男',
      role: 'antagonist',
      traits: ['奸诈', '弄权', '迫害忠良'],
      age_range: '40-60',
    },
    西门庆: {
      gender: '男',
      role: 'antagonist',
      traits: ['好色', '有钱', '霸道'],
      age_range: '25-35',
    },
    潘金莲: { gender: '女', role: 'antagonist', traits: ['淫荡', '狠毒'], age_range: '20-25' },
  },
};

// ─── Main bridge ────────────────────────────────────────────────────────────

function bridgeChiNovelKE(rawPath, outputPath) {
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
  const allCharacters = [];
  const allLocations = [];
  const allRelations = [];

  for (const [novelId, novel] of Object.entries(raw.novels)) {
    const annotations = novel.annotations;
    const charInfo = NOVEL_CHARACTER_INFO[novelId] || {};

    // ── Bridge characters ──
    if (annotations.characters?.entries) {
      for (const entry of annotations.characters.entries) {
        if (!entry.is_valid_character) continue;
        const canonical = entry.correct_name || entry.name;
        const info = charInfo[canonical] || charInfo[entry.name] || {};
        const id = sanitizeId(novelId + '_' + canonical);

        allCharacters.push({
          id,
          name: canonical,
          aliases: canonical !== entry.name ? [entry.name] : [],
          gender: info.gender || '未知',
          age_range: info.age_range || undefined,
          role: info.role || 'supporting',
          description: `${canonical} — ${novel.title}（${novel.genre}），首次出现于第${entry.first_chapter}回，共提及${entry.mention_count}次。${entry.notes || ''}`,
          traits: info.traits || [],
          relations: [],
          locations: [],
        });
      }
    }

    // ── Bridge relations ──
    if (annotations.relations?.entries) {
      for (const entry of annotations.relations.entries) {
        const aSanitized = sanitizeId(entry.person_a);
        const bSanitized = sanitizeId(entry.person_b);
        allRelations.push({
          id: sanitizeId(`rel_${novelId}_${entry.person_a}_${entry.person_b}`),
          type: entry.correct_type || entry.system_type,
          from_id: aSanitized,
          to_id: bSanitized,
          direction: 'bidirectional',
          intensity: Math.min(entry.mention_count || 10, 100),
          description: (entry.example_evidence || '').slice(0, 200),
        });
      }
    }

    // ── Bridge locations ──
    if (annotations.location_hierarchy?.entries) {
      for (const entry of annotations.location_hierarchy.entries) {
        allLocations.push({
          id: sanitizeId(novelId + '_' + entry.name),
          name: entry.name,
          parent_id: entry.correct_parent
            ? sanitizeId(novelId + '_' + entry.correct_parent)
            : undefined,
          description: `${entry.name} — ${entry.tier}级别地点`,
          era:
            novel.genre === 'fantasy' ? '神话时代' : novel.genre === 'realistic' ? '清代' : '宋代',
        });
      }
    }
  }

  const result = {
    characters: allCharacters,
    locations: allLocations,
    relations: allRelations,
    events: [],
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(
    `Bridged ChiNovelKE: ${allCharacters.length} chars, ${allRelations.length} rels, ${allLocations.length} locs → ${outputPath}`,
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────

const inputPath = path.join(ROOT, 'bench-data/chi-novelke/chinovelke.json');
const outputPath = path.join(ROOT, 'bench-data/chi-novelke/bridged.json');

if (!fs.existsSync(inputPath)) {
  console.error('Raw Chinovelke JSON not found at', inputPath);
  process.exit(1);
}

bridgeChiNovelKE(inputPath, outputPath);
