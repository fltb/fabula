// checklist-coverage.ts - Run with: npx tsx packages/core/src/ai/tools/checklist-coverage.ts
/**
 * checklist-coverage.ts
 *
 * Reads all 20 dream-of-red-chamber event YAML files, parses narrativeChecklist
 * from each, and outputs a summary JSON to output/checklist-coverage.json.
 *
 * Usage: npx tsx packages/core/src/ai/tools/checklist-coverage.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHAPTER_DIR = resolve(
  __dirname,
  '../../../../../fixtures/dream-of-red-chamber/chapters/chapter_01',
);

const OUTPUT_DIR = resolve(__dirname, '../../../../../output');
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'checklist-coverage.json');

interface NarrativeChecklistItem {
  dimension: string;
  description: string;
  required: boolean;
}

interface EventChecklistYaml {
  event: string;
  title: string;
  narrativeChecklist?: {
    items?: NarrativeChecklistItem[];
  };
}

interface EventChecklistData {
  event: string;
  title: string;
  requiredCount: number;
  totalCount: number;
  dimensions: string[];
}

interface DimensionStats {
  dimension: string;
  eventCount: number;
  requiredCount: number;
}

interface CoverageReport {
  generatedAt: string;
  totalEvents: number;
  eventsWithChecklist: number;
  perEvent: EventChecklistData[];
  perDimension: DimensionStats[];
  summary: {
    totalChecklistItems: number;
    totalRequiredItems: number;
  };
}

function readYaml(path: string): EventChecklistYaml {
  const content = readFileSync(path, 'utf-8');
  return YAML.parse(content) as unknown as EventChecklistYaml;
}

function main() {
  const allFiles = readdirSync(CHAPTER_DIR).filter((f) => f.startsWith('E') && f.endsWith('.yaml'));
  allFiles.sort();

  const perEvent: EventChecklistData[] = [];
  const dimensionMap = new Map<string, { eventSet: Set<string>; requiredCount: number }>();

  for (const file of allFiles) {
    const data = readYaml(resolve(CHAPTER_DIR, file));
    const eventId: string = data.event;
    const title: string = data.title;

    let requiredCount = 0;
    let totalCount = 0;
    const dimensions: string[] = [];

    if (data.narrativeChecklist && Array.isArray(data.narrativeChecklist.items)) {
      const items = data.narrativeChecklist.items as NarrativeChecklistItem[];
      totalCount = items.length;
      for (const item of items) {
        dimensions.push(item.dimension);
        if (item.required) requiredCount++;
        let stats = dimensionMap.get(item.dimension);
        if (!stats) {
          stats = {
            eventSet: new Set(),
            requiredCount: 0,
          };
          dimensionMap.set(item.dimension, stats);
        }
        stats.eventSet.add(eventId);
        if (item.required) stats.requiredCount++;
      }
    }

    perEvent.push({
      event: eventId,
      title,
      requiredCount,
      totalCount,
      dimensions,
    });
  }

  const perDimension: DimensionStats[] = Array.from(dimensionMap.entries())
    .map(([dimension, stats]) => ({
      dimension,
      eventCount: stats.eventSet.size,
      requiredCount: stats.requiredCount,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  const totalChecklistItems = perEvent.reduce((sum, e) => sum + e.totalCount, 0);
  const totalRequiredItems = perEvent.reduce((sum, e) => sum + e.requiredCount, 0);

  const report: CoverageReport = {
    generatedAt: new Date().toISOString(),
    totalEvents: perEvent.length,
    eventsWithChecklist: perEvent.filter((e) => e.totalCount > 0).length,
    perEvent,
    perDimension,
    summary: {
      totalChecklistItems,
      totalRequiredItems,
    },
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Written to ${OUTPUT_PATH}`);
  console.log(`Total events: ${report.totalEvents}`);
  console.log(`Events with checklist: ${report.eventsWithChecklist}`);
  console.log(`Total checklist items: ${report.summary.totalChecklistItems}`);
  console.log(`Total required items: ${report.summary.totalRequiredItems}`);
  console.log(`Dimensions tracked: ${perDimension.length}`);
}

main();
