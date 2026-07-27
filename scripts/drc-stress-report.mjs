#!/usr/bin/env node
// ============================================================================
// drc-stress-report.mjs — Stress report for 红楼梦 fixture events
//
// Reads canonical event YAMLs from fixture chapters, correlates them with any
// available rendered scenes, reference excerpts, and scene metadata, computes
// containment metrics, and writes a Markdown report to
//   <fixtureDir>/output/stress-report.md
//
// Usage:
//   node scripts/drc-stress-report.mjs <fixtureDir>
//   node scripts/drc-stress-report.mjs <fixtureDir> --stability <dir1,dir2,dir3>
//
// Stability mode loads rendered scenes from three separate run directories
// and computes pairwise bigram containment for same-event output.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Regex matching CJK Unified Ideographs (Han characters). */
const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/** Count Han characters in a string. */
function hanCount(text) {
  let count = 0;
  HAN_RE.lastIndex = 0;
  while (HAN_RE.exec(text) !== null) count++;
  return count;
}

/** Extract an array of Han characters from text. */
function extractHan(text) {
  return text.match(HAN_RE) || [];
}

/** Build a Set of character bigrams from a character array. */
function bigramSet(chars) {
  const s = new Set();
  for (let i = 1; i < chars.length; i++) {
    s.add(chars[i - 1] + chars[i]);
  }
  return s;
}

/**
 * Compute bigram containment: |set(render bigrams) ∩ set(original bigrams)|
 * / |set(render bigrams)|.
 *
 * Returns a number 0–1, or null when render content is insufficient (<2 chars).
 */
function bigramContainment(renderChars, originalChars) {
  if (renderChars.length < 2) return null;
  if (originalChars.length < 2) return 0;
  const rSet = bigramSet(renderChars);
  const oSet = bigramSet(originalChars);
  if (rSet.size === 0) return null;
  let inter = 0;
  for (const bg of rSet) {
    if (oSet.has(bg)) inter++;
  }
  return inter / rSet.size;
}

/** Format a number as a percentage string for the report. */
function pct(v) {
  if (v === null || v === undefined) return 'N/A';
  return (v * 100).toFixed(1) + '%';
}

/** Format a number with locale separators. */
function fmtNum(n) {
  if (n === null || n === undefined) return 'N/A';
  return n.toLocaleString('en-US');
}

/** Read a text file; return null on any failure. */
function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Read a binary file (returns Buffer); return null on failure. */
function readBinary(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Read and parse a YAML file; return null on any failure. */
function readYaml(path) {
  try {
    const raw = readFileSync(path, 'utf-8');
    return YAML.parse(raw);
  } catch {
    return null;
  }
}

/** Read and parse a JSON file; return null on any failure. */
function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** List directory entries (files + subdirs), sorted, excluding dotfiles. */
function listDir(dir) {
  try {
    return readdirSync(dir).filter(n => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let fixtureDir = null;
  let stabilityDirs = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stability') {
      const val = args[++i];
      if (!val) {
        console.error('ERROR: --stability requires a comma-separated list of run directories');
        process.exit(1);
      }
      stabilityDirs = val.split(',').map(s => s.trim()).filter(Boolean);
      if (stabilityDirs.length < 2) {
        console.error('ERROR: --stability requires at least 2 run directories for pairwise comparison');
        process.exit(1);
      }
    } else if (!fixtureDir) {
      fixtureDir = args[i];
    }
  }

  if (!fixtureDir) {
    fixtureDir = 'fixtures/dream-of-red-chamber';
    console.warn(`No fixture dir specified, using default: ${fixtureDir}`);
  }

  const resolvedFixture = isAbsolute(fixtureDir) ? fixtureDir : join(REPO_ROOT, fixtureDir);
  const resolvedStability = stabilityDirs
    ? stabilityDirs.map(d => isAbsolute(d) ? d : join(REPO_ROOT, d))
    : null;

  return { fixtureDir: resolvedFixture, stabilityDirs: resolvedStability };
}

// ── Source text loading ────────────────────────────────────────────────────

function loadSourceBuffer() {
  const p = join(REPO_ROOT, 'bench-data', 'corpus', 'dream-of-red-chamber', 'source.txt');
  const buf = readBinary(p);
  if (!buf) {
    console.warn('WARNING: source.txt not found — excerpt validation will be N/A');
  }
  return buf;
}

// ── Event discovery ────────────────────────────────────────────────────────

function discoverEvents(fixtureDir) {
  const chaptersDir = join(fixtureDir, 'chapters');
  if (!existsSync(chaptersDir)) {
    console.error(`ERROR: chapters dir not found: ${chaptersDir}`);
    process.exit(1);
  }

  const chapterNames = listDir(chaptersDir).filter(n => n.startsWith('chapter_'));
  const events = [];

  for (const chName of chapterNames) {
    const chPath = join(chaptersDir, chName);

    // Read _chapter.yaml for chapter number
    const chMetaPath = join(chPath, '_chapter.yaml');
    const chMeta = readYaml(chMetaPath);
    const chapterNum = chMeta?.chapter ?? null;

    // Gather event YAML file names (everything except _chapter.yaml)
    const yamls = listDir(chPath).filter(
      n => n.endsWith('.yaml') && n !== '_chapter.yaml'
    );

    for (const yf of yamls) {
      const yfPath = join(chPath, yf);
      const data = readYaml(yfPath);
      if (!data) {
        console.warn(`  WARNING: could not parse ${yfPath}`);
        continue;
      }

      const eventId = data.event || basename(yf, '.yaml').split('_')[0];
      events.push({
        eventId,
        title: data.title || '',
        chapterNum,
        data,
        // Companion file paths (may not exist yet)
        sceneMdPath: join(fixtureDir, 'scenes', `chapter-${String(chapterNum).padStart(2, '0')}`, `${eventId}.md`),
        sceneYamlPath: join(fixtureDir, 'scenes', `chapter-${String(chapterNum).padStart(2, '0')}`, `${eventId}.yaml`),
        referenceTxtPath: join(fixtureDir, 'reference', 'original', `${eventId}.txt`),
        responseJsonPath: join(fixtureDir, '.nova', 'responses', `${eventId}.json`),
      });
    }
  }

  return events;
}

// ── Per-event metrics ──────────────────────────────────────────────────────

function computeMetrics(event, sourceBuf) {
  const { eventId, chapterNum, sceneMdPath, sceneYamlPath, referenceTxtPath, responseJsonPath } = event;

  // Rendered scene content — prefer scenes/{id}.md, fallback to .nova/responses/{id}.json
  let renderText = readText(sceneMdPath);
  let proseSource = 'none';
  const responseData = readJson(responseJsonPath);

  if (renderText !== null) {
    proseSource = 'scene';
  } else if (responseData && typeof responseData.prose === 'string' && responseData.prose.trim().length > 0) {
    renderText = responseData.prose;
    proseSource = 'response';
  }

  const renderChars = renderText ? extractHan(renderText) : [];
  const renderHan = renderChars.length;

  // Reference original excerpt
  const origBuf = readBinary(referenceTxtPath);
  const origText = origBuf ? origBuf.toString('utf-8') : null;
  const origChars = origText ? extractHan(origText) : [];
  const origHan = origChars.length;

  // Scene metadata (released / attempts)
  // Scene YAML metadata wins if it has explicitly populated fields.
  // Otherwise read from response JSON if present; legacy fields → 'N/A'.
  const sceneMeta = readYaml(sceneYamlPath);

  let released, attempts;

  if (sceneMeta && sceneMeta.released !== undefined) {
    released = sceneMeta.released;
  } else if (responseData && responseData.released !== undefined) {
    released = responseData.released;
  } else {
    released = 'N/A';
  }

  if (sceneMeta && sceneMeta.attempts !== undefined) {
    attempts = sceneMeta.attempts;
  } else if (responseData && responseData.attempts !== undefined) {
    attempts = responseData.attempts;
  } else {
    attempts = 'N/A';
  }

  // Bigram containment
  const containment = bigramContainment(renderChars, origChars);

  // Byte-for-byte excerpt validation (fail-closed)
  let excerptStatus = 'OK';
  if (origBuf !== null && origBuf.length > 0) {
    if (sourceBuf === null) {
      excerptStatus = 'N/A (no source)';
    } else if (!sourceBuf.includes(origBuf)) {
      excerptStatus = 'EXCERPT_INVALID';
    }
  } else if (origBuf === null) {
    excerptStatus = 'N/A (no reference)';
  } else {
    // Empty original — no validation needed
    excerptStatus = 'N/A (empty)';
  }

  return {
    eventId,
    title: event.title,
    chapterNum,
    renderHan,
    origHan,
    containment,
    released,
    attempts,
    excerptStatus,
    proseSource,
  };
}


// ── Report writing ─────────────────────────────────────────────────────────

function writeReport(reportPath, rows, aggregates, stabilitySection) {
  const timestamp = execSync(
    "date '+%Y-%m-%d %H:%M %Z'", { encoding: 'utf-8' }
  ).trim();

  const lines = [];
  lines.push('# Stress Report — Dream of Red Chamber');
  lines.push('');
  lines.push(`> **时间**: ${timestamp}`);
  lines.push('');
  lines.push('## Event Metrics');
  lines.push('');
  lines.push('| ID | Chapter | Render Han | Original Han | Containment | Released | Attempts | Source | Excerpt');
  lines.push('|----|---------|-----------|-------------|-------------|----------|----------|--------|---------');

  for (const r of rows) {
    const ch = r.chapterNum !== null ? r.chapterNum : '?';
    const containmentStr = pct(r.containment);
    const renderStr = fmtNum(r.renderHan);
    const origStr = fmtNum(r.origHan);

    let excerptDisplay = r.excerptStatus;
    if (excerptDisplay === 'OK') excerptDisplay = '✅ OK';
    else if (excerptDisplay === 'EXCERPT_INVALID') excerptDisplay = '❌ EXCERPT_INVALID';

    lines.push(
      `| ${r.eventId} | ${ch} | ${renderStr} | ${origStr} | ${containmentStr} | ${r.released} | ${r.attempts} | ${r.proseSource} | ${excerptDisplay}`
    );
  }

  lines.push('');
  lines.push('## Aggregate');
  lines.push('');

  const meanContainment = aggregates.meanContainment !== null
    ? pct(aggregates.meanContainment)
    : 'N/A';
  const minContainment = aggregates.minContainment !== null
    ? pct(aggregates.minContainment)
    : 'N/A';

  lines.push(`- **Events**: ${aggregates.totalEvents}`);
  lines.push(`- **With render (scene)**: ${aggregates.withRender}`);
  lines.push(`- **With response fallback**: ${aggregates.withResponseFallback}`);
  lines.push(`- **With prose (total)**: ${aggregates.withProse}`);
  lines.push(`- **Released**: ${aggregates.releasedCount}`);
  lines.push(`- **With reference**: ${aggregates.withRef}`);
  lines.push(`- **Mean containment**: ${meanContainment}`);
  lines.push(`- **Min containment**: ${minContainment}`);
  lines.push(`- **Drift count (< 0.15)**: ${aggregates.driftCount}`);
  lines.push(`- **EXCERPT_INVALID count**: ${aggregates.excerptInvalidCount}`);

  if (aggregates.degradedSource) {
    lines.push(`- **⚠ Source degraded**: source.txt unavailable — containment and excerpt validation limited`);
  }
  if (aggregates.degradedRefs) {
    lines.push(`- **⚠ Reference degraded**: no reference/original texts available`);
  }

  if (stabilitySection) {
    lines.push('');
    lines.push(stabilitySection);
  }

  writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`Report written: ${reportPath}`);
}

// ── Aggregate calculation ──────────────────────────────────────────────────

function computeAggregates(rows, sourceBuf) {
  const containments = rows
    .map(r => r.containment)
    .filter(c => c !== null && c !== undefined);

  const totalEvents = rows.length;
  const withRender = rows.filter(r => r.renderHan > 0 && r.proseSource === 'scene').length;
  const withProse = rows.filter(r => r.proseSource !== 'none').length;
  const withResponseFallback = rows.filter(r => r.proseSource === 'response').length;
  const releasedCount = rows.filter(r => r.released === true).length;
  const withRef = rows.filter(r => r.origHan > 0).length;
  const excerptInvalidCount = rows.filter(r => r.excerptStatus === 'EXCERPT_INVALID').length;

  const meanContainment = containments.length > 0
    ? containments.reduce((a, b) => a + b, 0) / containments.length
    : null;

  const minContainment = containments.length > 0
    ? Math.min(...containments)
    : null;

  const driftCount = containments.filter(c => c < 0.15).length;

  return {
    totalEvents,
    withRender,
    withProse,
    withResponseFallback,
    releasedCount,
    withRef,
    meanContainment,
    minContainment,
    driftCount,
    excerptInvalidCount,
    degradedSource: sourceBuf === null,
    degradedRefs: withRef === 0,
  };
}

// ── Stability section ──────────────────────────────────────────────────────

/**
 * For --stability mode: load rendered scenes/*.md from up to three run
 * directories and compute pairwise bigram containment for same-event output.
 */
function buildStabilitySection(stabilityDirs, eventIds) {
  const lines = [];
  lines.push('## Stability (Run Comparison)');
  lines.push('');

  // Validate directories
  const validDirs = stabilityDirs.filter(d => existsSync(d));
  if (validDirs.length < 2) {
    lines.push('⚠ Fewer than 2 run directories exist — cannot compute pairwise comparison.');
    lines.push('');
    return lines.join('\n');
  }

  // Label each directory by its basename
  const dirLabels = validDirs.map(d => basename(d) || d);

  // Load all scene texts per directory
  const scenesByDir = validDirs.map(dir => {
    const label = basename(dir);
    const scenesDir = join(dir, 'scenes');
    const responsesDir = join(dir, '.nova', 'responses');
    const map = {};

    // Load scene markdown files first
    if (existsSync(scenesDir)) {
      const sceneFiles = listDir(scenesDir).filter(n => n.endsWith('.md'));
      for (const sf of sceneFiles) {
        const id = basename(sf, '.md');
        const text = readText(join(scenesDir, sf));
        if (text !== null) {
          map[id] = extractHan(text);
        }
      }
      // Also scan nested chapter-NN/ subdirectories (release layout)
      const chapterDirs = listDir(scenesDir).filter(n => n.startsWith('chapter-')).map(n => join(scenesDir, n));
      for (const chDir of chapterDirs) {
        const chFiles = listDir(chDir).filter(n => n.endsWith('.md'));
        for (const cf of chFiles) {
          const id = basename(cf, '.md');
          if (!map[id]) {  // flat path wins, but nested fills gaps
            const text = readText(join(chDir, cf));
            if (text !== null) {
              map[id] = extractHan(text);
            }
          }
        }
      }
    }

    // Fallback to response JSON for eventIds not yet in map
    if (existsSync(responsesDir)) {
      for (const eid of eventIds) {
        if (!map[eid]) {
          const responseData = readJson(join(responsesDir, `${eid}.json`));
          if (responseData && typeof responseData.prose === 'string' && responseData.prose.trim().length > 0) {
            map[eid] = extractHan(responseData.prose);
          }
        }
      }
    }

    return { label, scenes: map };
  });

  // For each event that exists in at least 2 directories, compute pairwise containment
  lines.push(`| Event | Pair | Containment |`);
  lines.push(`|-------|------|-------------|`);

  let pairCount = 0;
  let totalContainment = 0;

  for (const eid of eventIds) {
    const presentScenes = scenesByDir
      .map((d, i) => ({ idx: i, chars: d.scenes[eid] }))
      .filter(s => s.chars && s.chars.length >= 2);

    // All pairwise combinations
    for (let i = 0; i < presentScenes.length; i++) {
      for (let j = i + 1; j < presentScenes.length; j++) {
        const a = presentScenes[i];
        const b = presentScenes[j];
        const containment = bigramContainment(a.chars, b.chars);
        if (containment !== null) {
          lines.push(
            `| ${eid} | ${dirLabels[a.idx]} ↔ ${dirLabels[b.idx]} | ${pct(containment)} |`
          );
          pairCount++;
          totalContainment += containment;
        }
      }
    }
  }

  lines.push('');
  if (pairCount > 0) {
    const mean = totalContainment / pairCount;
    lines.push(`- **Pairwise comparisons**: ${pairCount}`);
    lines.push(`- **Mean pairwise containment**: ${pct(mean)}`);
  } else {
    lines.push('⚠ No pairwise comparisons possible (insufficient rendered scenes across runs).');
  }

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { fixtureDir, stabilityDirs } = parseArgs();
  console.log(`Fixture dir: ${fixtureDir}`);

  // Load source text (binary for byte-level comparison)
  const sourceBuf = loadSourceBuffer();

  // Discover events from chapter YAMLs
  const events = discoverEvents(fixtureDir);
  console.log(`Found ${events.length} events in fixture chapters`);

  if (events.length === 0) {
    console.error('ERROR: no events found — check fixture directory structure');
    process.exit(1);
  }

  // Compute per-event metrics
  const rows = events.map(ev => computeMetrics(ev, sourceBuf));

  // Aggregate
  const aggregates = computeAggregates(rows, sourceBuf);

  // Stability section (optional)
  let stabilitySection = null;
  if (stabilityDirs) {
    const eventIds = events.map(e => e.eventId);
    stabilitySection = buildStabilitySection(stabilityDirs, eventIds);
  }

  // Ensure output directory exists
  const outputDir = join(fixtureDir, 'output');
  mkdirSync(outputDir, { recursive: true });

  // Write report
  const reportPath = join(outputDir, 'stress-report.md');
  writeReport(reportPath, rows, aggregates, stabilitySection);

  console.log('Done.');
}

main();
