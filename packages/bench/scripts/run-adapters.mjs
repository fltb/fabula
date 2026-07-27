#!/usr/bin/env node
// ============================================================================
// External Dataset → Novalistically Standard Project (YAML)
// ============================================================================
//
// Reads bridged JSON from bench-data/, converts to standard Novalistically
// YAML project format (nova.yaml + definitions/ + chapters/), loadable by
// EntityMapper.loadProject().
//
// Usage: node packages/bench/scripts/run-adapters.mjs
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const BENCH_DATA = path.join(ROOT, 'bench-data');
const OUTPUT_BASE = path.join(BENCH_DATA, 'converted');

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function mkdir(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeYAML(filePath, data) {
  fs.writeFileSync(filePath, YAML.stringify(data, { lineWidth: 120 }), 'utf-8');
}

function safeId(name) {
  // Keep Chinese chars + ASCII, replace problematic ones
  return name
    .replace(/[^\u4e00-\u9fff_a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// ChiNovelKE → Full Project
// ═══════════════════════════════════════════════════════════════════════════

function buildChiNovelKEProject(raw) {
  const projDir = mkdir(OUTPUT_BASE, 'chinovelke_project');
  const defsDir = mkdir(projDir, 'definitions');
  const charsDir = mkdir(defsDir, 'characters');
  const locsDir = mkdir(defsDir, 'locations');
  const relsDir = mkdir(defsDir, 'relationships');

  // nova.yaml
  writeYAML(path.join(projDir, 'nova.yaml'), {
    project: 'chinovelke',
    title: 'ChiNovelKE — Classical Chinese Novel Knowledge Extraction',
    default_model: 'mock',
    default_language: 'zh',
    genre: 'classical',
    synopsis: `Aggregated from ChiNovelKE: ${raw.characters.length} characters, ${raw.locations.length} locations, ${raw.relations.length} relations across 西游记, 红楼梦, 水浒传.`,
    tense: 'past',
    snapshot_interval: 10,
  });

  // Characters
  for (const c of raw.characters) {
    const roleMap = {
      protagonist: 'supporting',
      antagonist: 'antagonist',
      supporting: 'supporting',
      background: 'background',
    };
    writeYAML(path.join(charsDir, `${safeId(c.id)}.yaml`), {
      id: c.id,
      name: c.name,
      type: 'character',
      role: roleMap[c.role] || 'supporting',
      gender: c.gender || '未知',
      age: c.age_range || undefined,
      description: c.description || `${c.name} — from ChiNovelKE`,
      aliases: c.aliases || [],
      traits: c.traits || [],
      initialState: {},
    });
  }

  // Locations
  for (const l of raw.locations) {
    writeYAML(path.join(locsDir, `${safeId(l.id)}.yaml`), {
      id: l.id,
      name: l.name,
      kind: 'location',
      description: l.description || '',
      parent: l.parent_id || undefined,
      initialState: {},
    });
  }

  // Relationships
  for (const r of raw.relations) {
    writeYAML(path.join(relsDir, `${safeId(r.id)}.yaml`), {
      id: r.id,
      participants: [r.from_id, r.to_id],
      type: r.type,
      description: r.description || '',
      initialState: { intensity: r.intensity || 50, direction: r.direction || 'bidirectional' },
    });
  }

  // state_initial.yaml
  writeYAML(path.join(defsDir, 'state_initial.yaml'), {
    timeAnchors: [
      { id: 'default_time', day: 0, description: 'Default time anchor for ChiNovelKE data' },
    ],
    threads: [],
    worldFacts: [],
  });

  // chapter placeholder
  const chDir = mkdir(projDir, 'chapters', 'chapter_01');
  writeYAML(path.join(chDir, '_chapter.yaml'), {
    chapter: 1,
    title: 'ChiNovelKE Entities',
    summary: `Auto-generated from ChiNovelKE: ${raw.characters.length} characters, ${raw.locations.length} locations, ${raw.relations.length} relations.`,
    intent: 'Entity definitions for benchmark testing',
    plannedScenes: 0,
  });

  return {
    projDir,
    chars: raw.characters.length,
    locs: raw.locations.length,
    rels: raw.relations.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// NovelAgentSFT → Event Project
// ═══════════════════════════════════════════════════════════════════════════

function buildAgentSFTProject(chapters) {
  const projDir = mkdir(OUTPUT_BASE, 'novel_agent_sft_project');
  const chDir = mkdir(projDir, 'chapters', 'chapter_01');
  let eventCount = 0;

  writeYAML(path.join(projDir, 'nova.yaml'), {
    project: 'novel_agent_sft',
    title: 'NovelAgentSFT — Web Novel Event Skeleton',
    default_model: 'mock',
    default_language: 'zh',
    genre: 'webnovel',
    synopsis: `Converted from NovelAgentSFT narrative samples: ${chapters.length} chapters, narrative type classification data.`,
    tense: 'past',
    snapshot_interval: 5,
  });

  const defsDir = mkdir(projDir, 'definitions');
  writeYAML(path.join(defsDir, 'state_initial.yaml'), {
    timeAnchors: [{ id: 'default_time', day: 0 }],
    threads: [],
    worldFacts: [],
  });

  // Collect all unique character names
  const allChars = new Set();
  for (const ch of chapters) {
    for (const e of ch.events || []) {
      for (const c of e.characters_involved || []) {
        if (c && c !== '未知') allChars.add(c);
      }
    }
  }
  const charsDir = mkdir(defsDir, 'characters');
  for (const name of allChars) {
    writeYAML(path.join(charsDir, `${safeId(name)}.yaml`), {
      id: safeId(name),
      name,
      type: 'character',
      role: 'supporting',
      gender: '未知',
      description: `Character appearing in NovelAgentSFT samples.`,
      traits: [],
      initialState: {},
    });
  }

  // Events
  for (const ch of chapters) {
    for (const e of ch.events || []) {
      eventCount++;
      const conflictMap = {
        人物冲突: 'person_vs_person',
        社会冲突: 'person_vs_society',
        自我冲突: 'person_vs_self',
        命运冲突: 'person_vs_fate',
        自然冲突: 'person_vs_nature',
      };
      const emotionMap = {
        悲伤: 'sad',
        愤怒: 'angry',
        喜悦: 'joyful',
        恐惧: 'fearful',
        紧张: 'tense',
        平静: 'calm',
      };

      writeYAML(path.join(chDir, `E_${e.event_id}.yaml`), {
        event: e.event_id,
        title: (e.description || 'Event').slice(0, 50),
        narrativeOrder: eventCount,
        sceneBrief: e.description || '',
        storyTime: `chapter_${ch.chapter_index}`,
        sceneType: 'linear',
        tense: 'past',
        discourseMode: 'exposition',
        arcPosition:
          eventCount <= 2
            ? 'opening'
            : eventCount >= chapters.reduce((s, c) => s + (c.events?.length || 0), 0) * 0.7
              ? 'climax'
              : 'rising',
        conflictType: conflictMap[e.conflict_type] || 'person_vs_self',
        emotionalValence: emotionMap[e.emotional_tone] || 'neutral',
        pov: { character: (e.characters_involved || ['unknown'])[0], type: 'third_person_limited' },
        preconditions: [],
        expectedPostconditions: [],
        threadProgress: [],
        relationshipEffects: [],
        introduces: [],
        styleGuidance: {},
      });
    }
  }

  writeYAML(path.join(chDir, '_chapter.yaml'), {
    chapter: 1,
    title: 'NovelAgentSFT Events',
    summary: `Auto-generated: ${chapters.length} source chapters, ${eventCount} events.`,
    intent: 'Event skeleton for RenderPipeline throughput testing',
    plannedScenes: eventCount,
  });

  return { projDir, events: eventCount, chapters: chapters.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// InteractiveNovels3K → Event Project
// ═══════════════════════════════════════════════════════════════════════════

function buildIN3KProject(batchPath) {
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
  const projDir = mkdir(OUTPUT_BASE, 'interactive_novels_3k_project');
  const chDir = mkdir(projDir, 'chapters', 'chapter_01');
  let eventCount = 0;

  writeYAML(path.join(projDir, 'nova.yaml'), {
    project: 'interactive_novels_3k',
    title: 'Chinese Interactive Novels 3K',
    default_model: 'mock',
    default_language: 'zh',
    genre: 'interactive_fiction',
    synopsis: `Converted from Chinese Interactive Novels 3K: ${batch.length} novels. Sample batch for TimelineValidator throughput testing.`,
    tense: 'past',
    snapshot_interval: 10,
  });

  const defsDir = mkdir(projDir, 'definitions');
  // Create time anchors for the first novel's chapters
  const firstNovel = batch[0];
  const timeAnchors = firstNovel.chapters.map((ch, i) => ({
    id: `chapter_${i}`,
    day: i,
    description: ch.title || `Chapter ${i}`,
  }));
  writeYAML(path.join(defsDir, 'state_initial.yaml'), {
    timeAnchors,
    threads: [],
    worldFacts: [],
  });

  for (const novel of batch.slice(0, 3)) {
    // limit to 3 novels
    for (const ch of novel.chapters) {
      if (eventCount >= 200) break; // cap events for reasonable output
      const charCount = Object.entries(ch.character_appearances || {}).sort((a, b) => b[1] - a[1]);
      const povChar = charCount[0]?.[0] || 'unknown';

      eventCount++;
      writeYAML(path.join(chDir, `E_${ch.chapter_id}.yaml`), {
        event: ch.chapter_id,
        title: ch.title || `Chapter ${ch.chapter_index}`,
        narrativeOrder: eventCount,
        sceneBrief: (ch.content || '').slice(0, 500),
        storyTime: `chapter_${ch.chapter_index}`,
        sceneType: 'linear',
        tense: 'past',
        discourseMode: 'dialogue',
        arcPosition: 'rising',
        pov: { character: povChar, type: 'third_person_limited' },
        preconditions: [],
        expectedPostconditions: [],
        threadProgress: [],
        relationshipEffects: [],
        introduces: [],
        styleGuidance: {},
      });
    }
  }

  writeYAML(path.join(chDir, '_chapter.yaml'), {
    chapter: 1,
    title: 'Interactive Novels 3K Events',
    summary: `Auto-generated: ${eventCount} events from ${batch.length} novels.`,
    intent: 'TimelineValidator throughput benchmark data',
    plannedScenes: eventCount,
  });

  return { projDir, events: eventCount, novels: batch.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  fs.mkdirSync(OUTPUT_BASE, { recursive: true });
  const results = [];

  // 1. ChiNovelKE
  const cnkBridged = path.join(BENCH_DATA, 'chi-novelke/bridged.json');
  if (fs.existsSync(cnkBridged)) {
    const raw = JSON.parse(fs.readFileSync(cnkBridged, 'utf-8'));
    const r = buildChiNovelKEProject(raw);
    console.log(
      `ChiNovelKE:          ${r.chars} chars, ${r.locs} locs, ${r.rels} rels → ${r.projDir}`,
    );
    results.push(r);
  }

  // 2. NovelAgentSFT
  const sftBridged = path.join(BENCH_DATA, 'novel-agent-sft/bridged.json');
  if (fs.existsSync(sftBridged)) {
    const raw = JSON.parse(fs.readFileSync(sftBridged, 'utf-8'));
    const r = buildAgentSFTProject(raw);
    console.log(`NovelAgentSFT:       ${r.events} events, ${r.chapters} chapters → ${r.projDir}`);
    results.push(r);
  }

  // 3. InteractiveNovels3K
  const batch0 = path.join(BENCH_DATA, 'interactive-novels-3k/bridged/bridged_batch_0.json');
  if (fs.existsSync(batch0)) {
    const r = buildIN3KProject(batch0);
    console.log(`InteractiveNovels3K: ${r.events} events, ${r.novels} novels → ${r.projDir}`);
    results.push(r);
  }

  console.log(`\n═══ All projects at ${OUTPUT_BASE}/ ═══`);
  for (const d of fs.readdirSync(OUTPUT_BASE)) {
    const stat = fs.statSync(path.join(OUTPUT_BASE, d));
    if (stat.isDirectory()) {
      const files = fs.readdirSync(path.join(OUTPUT_BASE, d), { recursive: true }).length;
      console.log(`  ${d}/  (${files} files)`);
    }
  }
}

await main();
