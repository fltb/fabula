#!/usr/bin/env node
// ============================================================================
// CaTeRS → Novalistically Bridge
// ============================================================================
// Converts CaTeRS causal/temporal event graphs into standard Novalistically
// YAML project format with proper preconditions→postconditions DAGs.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const BENCH_DATA = path.join(ROOT, 'bench-data');
const INPUT = path.join(BENCH_DATA, 'caters/caters_stories.json');

function mkdir(...parts) {
  const d = path.join(...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeYAML(fp, data) {
  fs.writeFileSync(fp, YAML.stringify(data, { lineWidth: 120 }), 'utf-8');
}
function safeId(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('CaTeRS data not found at', INPUT);
    process.exit(1);
  }
  const stories = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

  // Group by split
  const splits = { 0: [], 1: [], 2: [] };
  for (const s of stories) splits[s.split] = splits[s.split] || [];
  // Keep all splits together for the project — use train for the main project
  const allStories = stories;

  const projDir = mkdir(BENCH_DATA, 'converted', 'caters_project');
  const defsDir = mkdir(projDir, 'definitions');
  const charsDir = mkdir(defsDir, 'characters');
  const chDir = mkdir(projDir, 'chapters', 'chapter_01');

  // Extract all unique character names from the story text using simple heuristics
  const charNames = new Set();
  const namePattern = /\b([A-Z][a-z]+)\b/g;
  for (const s of allStories) {
    const matches = s.context.match(namePattern) || [];
    for (const m of matches) {
      if (
        ![
          'He',
          'She',
          'They',
          'It',
          'The',
          'A',
          'An',
          'When',
          'After',
          'While',
          'Suddenly',
          'One',
          'To',
          'His',
          'Her',
          'I',
          'My',
          'But',
          'So',
          'And',
          'In',
          'On',
          'At',
          'Worse',
          'More',
        ].includes(m)
      ) {
        charNames.add(m);
      }
    }
  }

  // Write character definitions
  for (const name of [...charNames].slice(0, 50)) {
    writeYAML(path.join(charsDir, `${safeId(name)}.yaml`), {
      id: safeId(name),
      name,
      type: 'character',
      role: 'supporting',
      gender: 'unknown',
      description: `Character appearing in CaTeRS benchmark stories.`,
      traits: [],
      initialState: {},
    });
  }

  // Write nova.yaml
  writeYAML(path.join(projDir, 'nova.yaml'), {
    project: 'caters',
    title: 'CaTeRS — Causal and Temporal Relation Scheme',
    default_model: 'mock',
    default_language: 'en',
    genre: 'short_story',
    synopsis: `${allStories.length} everyday 5-sentence stories with ${sumStories(allStories, 'events')} annotated events and ${sumStories(allStories, 'relations')} causal/temporal edges. Benchmark for causal DAG validation.`,
    tense: 'past',
    snapshot_interval: 5,
  });

  // Write state_initial.yaml
  writeYAML(path.join(defsDir, 'state_initial.yaml'), {
    timeAnchors: [
      { id: 'story_beginning', day: 0, description: 'Start of each 5-sentence CaTeRS story' },
    ],
    threads: [
      {
        id: 'T1',
        name: 'Causal Chain',
        type: 'primary',
        description: 'The chain of events linked by cause/enable/prevent relations.',
        targetRevealChapter: 1,
        initialProgress: '0.00',
      },
    ],
    worldFacts: [],
  });

  // Write each story as a set of events with causal DAG
  let globalOrder = 0;
  let totalEvents = 0;
  let totalPreconds = 0;

  for (let si = 0; si < allStories.length; si++) {
    const story = allStories[si];
    const eventEntries = Object.entries(story.events); // [span, id]
    const eventMap = {}; // id → { text, preconds, postconds }

    // Build event map
    for (const [span, eid] of eventEntries) {
      eventMap[eid] = {
        text: span,
        preconds: [], // incoming causal edges
        postconds: [], // outgoing causal edges
      };
    }

    // Wire causal edges
    for (const r of story.relations) {
      if (r.label === 'causal') {
        eventMap[r.to_id].preconds.push({ from: r.from_id, text: r.from });
        eventMap[r.from_id].postconds.push({ to: r.to_id, text: r.to });
      }
    }

    // Skip stories with < 2 events
    if (eventEntries.length < 2) continue;

    // Create event YAML for each event in the story
    for (const [span, eid] of eventEntries) {
      const evt = eventMap[eid];
      globalOrder++;

      const preconditions = evt.preconds.map((p) => ({
        entity: 'narrative',
        attribute: 'event_completed',
        value: p.from,
        confidence: 0.9,
      }));

      const expectedPostconditions = evt.postconds.map((p) => ({
        entity: 'narrative',
        attribute: 'event_triggered',
        value: p.to,
        confidence: 0.9,
      }));

      writeYAML(path.join(chDir, `E_${String(si).padStart(3, '0')}_${eid}.yaml`), {
        event: `S${si}_${eid}`,
        title: span.slice(0, 50),
        narrativeOrder: globalOrder,
        sceneBrief: `Story ${si}: ${span}. Full context: ${story.context.slice(0, 300)}`,
        storyTime: 'story_beginning',
        sceneType: 'linear',
        tense: 'past',
        discourseMode: 'exposition',
        arcPosition:
          eid === 'E0'
            ? 'opening'
            : eid === eventEntries[eventEntries.length - 1][1]
              ? 'denouement'
              : 'rising',
        conflictType: 'person_vs_fate',
        pov: { character: 'unknown', type: 'third_person_limited' },
        preconditions: preconditions.length > 0 ? preconditions : [],
        expectedPostconditions: expectedPostconditions.length > 0 ? expectedPostconditions : [],
        threadProgress: [],
        relationshipEffects: [],
        introduces: [],
        styleGuidance: {},
      });

      totalEvents++;
      totalPreconds += preconditions.length;
    }
  }

  // Chapter metadata
  writeYAML(path.join(chDir, '_chapter.yaml'), {
    chapter: 1,
    title: 'CaTeRS Stories',
    summary: `${allStories.length} stories with ${totalEvents} events and ${totalPreconds} causal preconditions. Train=200, dev=60, test=20.`,
    intent:
      'Causal DAG benchmark — validates CausalityValidator, ReachabilityValidator, TimelineValidator',
    plannedScenes: totalEvents,
  });

  // Statistics output
  console.log(`CaTeRS → Novalistically:`);
  console.log(`  Stories: ${allStories.length} (train=200, dev=60, test=20)`);
  console.log(`  Events written: ${totalEvents}`);
  console.log(`  Causal edges (pre→post): ${totalPreconds}`);
  console.log(`  Characters extracted: ${charNames.size}`);
  console.log(`  Output: ${projDir}/`);
}

function sumStories(stories, field) {
  if (field === 'events') return stories.reduce((s, st) => s + Object.keys(st.events).length, 0);
  if (field === 'relations') return stories.reduce((s, st) => s + st.relations.length, 0);
  return 0;
}

main();
