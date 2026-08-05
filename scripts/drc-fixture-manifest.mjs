#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';

const args = process.argv.slice(2);
const check = args.includes('--check');
const write = args.includes('--write');
const rootArg = args.find((arg) => !arg.startsWith('--')) ?? 'fixtures/dream-of-red-chamber';
const root = rootArg.replace(/\/$/, '');
const manifestPath = join(root, 'fixture-manifest.json');

function fail(message) {
  throw new Error(`DRC fixture manifest: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function yamlAt(path) {
  try {
    return YAML.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `cannot parse ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fileNames(path) {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function yamlFilesAt(relativePath) {
  return fileNames(join(root, relativePath)).flatMap((entry) => {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) return yamlFilesAt(child);
    return entry.isFile() && /\.ya?ml$/.test(entry.name) ? [child] : [];
  });
}

function sourceHash(paths) {
  const payload = paths
    .sort((a, b) => a.localeCompare(b))
    .map((path) => `${path}\0${readFileSync(join(root, path), 'utf8')}`)
    .join('\0');
  return sha256(payload);
}

const chapterRoot = join(root, 'chapters');
if (!existsSync(chapterRoot)) fail('missing chapters/');

const chapters = fileNames(chapterRoot)
  .filter((entry) => entry.isDirectory() && /^chapter_\d+$/.test(entry.name))
  .map((entry) => {
    const number = Number(entry.name.slice('chapter_'.length));
    const chapterPath = join(chapterRoot, entry.name);
    const metadataPath = join(chapterPath, '_chapter.yaml');
    if (!existsSync(metadataPath)) fail(`missing ${relative(root, metadataPath)}`);
    const metadata = yamlAt(metadataPath);
    if (metadata?.chapter !== number) {
      fail(`${relative(root, metadataPath)} chapter must equal ${number}`);
    }
    const events = fileNames(chapterPath)
      .filter((file) => file.isFile() && /^E\d+.*\.ya?ml$/.test(file.name))
      .map((file) => {
        const path = join(chapterPath, file.name);
        const parsed = yamlAt(path);
        const eventId = parsed?.event;
        const fileId = file.name.match(/^(E\d+)/)?.[1];
        if (typeof eventId !== 'string' || eventId !== fileId) {
          fail(`${relative(root, path)} event must equal filename id ${fileId ?? '<missing>'}`);
        }
        return eventId;
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (metadata.plannedScenes !== events.length) {
      fail(
        `${relative(root, metadataPath)} plannedScenes ${metadata.plannedScenes} does not match ${events.length} events`,
      );
    }
    return { chapter: number, eventCount: events.length, events };
  })
  .sort((a, b) => a.chapter - b.chapter);

const chapterNumbers = new Set(chapters.map((chapter) => chapter.chapter));
if (chapterNumbers.size !== chapters.length) fail('duplicate chapter number');
const eventIds = chapters.flatMap((chapter) => chapter.events);
if (new Set(eventIds).size !== eventIds.length) fail('duplicate event id');

const definitionDirectories = [
  'characters',
  'locations',
  'items',
  'factions',
  'relationships',
  'rules',
  'narrators',
  'assertions',
];
const definitions = Object.fromEntries(
  definitionDirectories.map((directory) => [
    directory,
    fileNames(join(root, 'definitions', directory)).filter(
      (file) => file.isFile() && /\.ya?ml$/.test(file.name),
    ).length,
  ]),
);
const initial = yamlAt(join(root, 'definitions', 'state_initial.yaml'));
const sourceFiles = ['nova.yaml', ...yamlFilesAt('definitions'), ...yamlFilesAt('chapters')];

const manifest = {
  version: 1,
  generator: 'scripts/drc-fixture-manifest.mjs',
  fixture: 'dream-of-red-chamber',
  chapters,
  eventCount: eventIds.length,
  definitions,
  initialState: {
    threads: Array.isArray(initial?.threads) ? initial.threads.length : 0,
    worldFacts: Array.isArray(initial?.worldFacts) ? initial.worldFacts.length : 0,
    timeAnchors: Array.isArray(initial?.timeAnchors) ? initial.timeAnchors.length : 0,
  },
  sourceSha256: sourceHash(sourceFiles),
  corpusSource: {
    sourceChapterCount: 80,
    acquisitionScript: 'scripts/acquire-dream-of-red-chamber.mjs',
    manifest: 'bench-data/corpus/dream-of-red-chamber/source-manifest.json',
  },
};
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  if (!existsSync(manifestPath)) fail('fixture-manifest.json is missing; run with --write');
  if (readFileSync(manifestPath, 'utf8') !== rendered) {
    fail('fixture-manifest.json is stale; run with --write');
  }
  console.log(
    `DRC fixture manifest verified: ${chapters.length} chapters, ${eventIds.length} events`,
  );
} else if (write) {
  writeFileSync(manifestPath, rendered);
  console.log(`DRC fixture manifest written: ${manifestPath}`);
} else {
  process.stdout.write(rendered);
}
