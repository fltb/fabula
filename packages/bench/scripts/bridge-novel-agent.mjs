#!/usr/bin/env node
// ============================================================================
// Bridge: Raw NovelAgentSFT samples → Adapter-compatible AgentSFTChapter format
// ============================================================================
//
// NovelAgentSFT sample data includes:
//   - narrative_sample.json: [{unit_id, text, type}] — narrative classification
//   - scene_sample.json: {boundaries, reasons} — scene boundary detection
//   - attr_sample.json: {top_candidates, best_candidate, uncertain} — attribution
//   - scene_v4_sample.json: scene boundaries v4
//
// Adapter expects AgentSFTChapter[]:
//   {chapter_id, chapter_index, title, summary, word_count, events[]:
//     {event_id, description, characters_involved[], location?, conflict_type?, emotional_tone?},
//    characters_appearing[], locations[]}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const SAMPLES_DIR = path.join(ROOT, 'bench-data/novel-agent-sft/samples_by_type');

// ─── Extract chapters from narrative samples ───────────────────────────────

function buildChaptersFromNarrativeUnits(units) {
  // Group narrative units by detecting scene boundaries (type changes to action/scene_description after dialogue)
  const chapters = [];
  let currentChapter = { events: [], chars: new Set(), locs: new Set() };
  let chapterIdx = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];

    // Detect chapter boundary: action after long dialogue sequence, or every ~5 units
    if (
      currentChapter.events.length >= 5 ||
      (i > 0 && units[i - 1].type === 'dialogue' && unit.type === 'scene_description')
    ) {
      if (currentChapter.events.length > 0) {
        chapters.push(finalizeChapter(currentChapter, chapterIdx++));
      }
      currentChapter = { events: [], chars: new Set(), locs: new Set() };
    }

    const eventId = `evt_${chapterIdx}_${currentChapter.events.length}`;
    // Extract character names from text (simple: look for 2-3 char names before action verbs)
    const charMatch = unit.text.match(
      /([\u4e00-\u9fff]{2,3})(?:道|说|问|答|喊|叫|笑|哭|想|看|走|来|去)/,
    );
    const chars = charMatch ? [charMatch[1]] : ['未知'];

    currentChapter.events.push({
      event_id: eventId,
      description: `${unit.type}: ${unit.text.slice(0, 80)}`,
      characters_involved: chars,
      location: undefined,
      conflict_type: mapToConflictType(unit.type, unit.text),
      emotional_tone: mapToEmotionalTone(unit.text),
    });

    for (const character of chars) currentChapter.chars.add(character);
    // Simple location extraction
    const locMatch = unit.text.match(
      /([\u4e00-\u9fff]{2,4})(?:山|殿|堂|院|室|厅|房|楼|阁|庙|寺|观|城|镇|村|园|岛)/,
    );
    if (locMatch) currentChapter.locs.add(locMatch[0]);
  }

  if (currentChapter.events.length > 0) {
    chapters.push(finalizeChapter(currentChapter, chapterIdx));
  }

  return chapters;
}

function finalizeChapter(ch, idx) {
  const events = ch.events;
  const chars = [...ch.chars];
  const locs = [...ch.locs];
  const allText = events.map((e) => e.description).join(' ');

  return {
    chapter_id: `ch_${idx}`,
    chapter_index: idx,
    title: `Chapter ${idx + 1}`,
    summary: allText.slice(0, 200),
    word_count: allText.replace(/[^\u4e00-\u9fff]/g, '').length,
    events,
    characters_appearing: chars,
    locations: locs,
  };
}

// ─── Conflict type mapping ──────────────────────────────────────────────────

function mapToConflictType(type, text) {
  if (text.includes('哭') || text.includes('悲伤') || text.includes('痛苦')) return '人物冲突';
  if (text.includes('杀') || text.includes('打') || text.includes('战')) return '人物冲突';
  if (text.includes('命') || text.includes('运') || text.includes('注定')) return '命运冲突';
  if (text.includes('雪') || text.includes('风') || text.includes('雨') || text.includes('山'))
    return '自然冲突';
  if (text.includes('礼') || text.includes('规') || text.includes('不许')) return '社会冲突';
  if (type === 'thought') return '自我冲突';
  return undefined;
}

function mapToEmotionalTone(text) {
  if (text.includes('哭') || text.includes('泪') || text.includes('悲')) return '悲伤';
  if (text.includes('怒') || text.includes('恨') || text.includes('气')) return '愤怒';
  if (text.includes('笑') || text.includes('喜') || text.includes('乐')) return '喜悦';
  if (text.includes('怕') || text.includes('恐') || text.includes('惊')) return '恐惧';
  if (text.includes('紧') || text.includes('急') || text.includes('慌')) return '紧张';
  return '平静';
}

// ─── Main bridge ────────────────────────────────────────────────────────────

function bridgeNovelAgentSFT(samplesDir, outputPath) {
  const allChapters = [];

  // Process each narrative sample file (representing different novels/chapters)
  const files = fs.existsSync(samplesDir)
    ? fs.readdirSync(samplesDir).filter((f) => f.startsWith('narrative_') && f.endsWith('.json'))
    : [];

  // If no samples_by_type directory, use the top-level sample files
  const narrativePath = path.join(ROOT, 'bench-data/novel-agent-sft/narrative_sample.json');
  const narrativeFiles =
    files.length > 0
      ? files.map((f) => path.join(samplesDir, f))
      : fs.existsSync(narrativePath)
        ? [narrativePath]
        : [];

  for (const file of narrativeFiles.slice(0, 5)) {
    // limit to 5 for reasonable output
    try {
      const units = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(units)) {
        const chapters = buildChaptersFromNarrativeUnits(units);
        allChapters.push(...chapters);
      }
    } catch (e) {
      console.error(`  Skipping ${path.basename(file)}: ${e.message}`);
    }
  }

  // If no chapters were created from samples, synthesize at least one from narrative_sample.json
  if (allChapters.length === 0 && fs.existsSync(narrativePath)) {
    const units = JSON.parse(fs.readFileSync(narrativePath, 'utf-8'));
    if (Array.isArray(units)) {
      const chapters = buildChaptersFromNarrativeUnits(units);
      allChapters.push(...chapters);
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(allChapters, null, 2), 'utf-8');
  console.log(
    `Bridged NovelAgentSFT: ${allChapters.length} chapters from narrative samples → ${outputPath}`,
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────

const outputPath = path.join(ROOT, 'bench-data/novel-agent-sft/bridged.json');
bridgeNovelAgentSFT(SAMPLES_DIR, outputPath);
