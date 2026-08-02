// ============================================================================
// Test Fixture — materialize on-disk authoring fixtures as immutable snapshots
// ============================================================================
// The version-controlled `fixtures/` projects (zhu-fu, arcane-aftermath,
// zhu-fu-variants/*) are read once at module scope and converted into
// `ProjectSourceSnapshotV1` values via the pure `source-snapshot.ts` builder.
// Core only ever receives the immutable snapshot — never a Storage class or a
// project directory. Reads are deterministic because the fixture bytes are
// version-controlled.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ProjectSourceSnapshotV1 } from '../../src/contracts/source.ts';
import { createSourceDocument, toSourceSnapshot } from './source-snapshot.ts';

/** Recursively collect every YAML file under `dir` (excluding `.nova` runtime dirs). */
function collectYamlFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      if (entry.name === '.nova') continue;
      collectYamlFiles(join(dir, entry.name), out);
      continue;
    }
    if (/\.ya?ml$/i.test(entry.name)) out.push(join(dir, entry.name));
  }
}

/**
 * Build an immutable source snapshot from a version-controlled fixture
 * directory. Logical paths are POSIX-relativized from the fixture root; every
 * document carries content hash, parse result, and schema diagnostics derived
 * by the pure builder, and the snapshot gets one canonical sourceHash.
 */
export function materializeFixtureSnapshot(fixtureRoot: string): ProjectSourceSnapshotV1 {
  const files: string[] = [];
  collectYamlFiles(fixtureRoot, files);
  const documents = files.map((file) => {
    const logicalPath = relative(fixtureRoot, file).split(sep).join('/');
    return createSourceDocument(logicalPath, readFileSync(file, 'utf8'));
  });
  return toSourceSnapshot(documents);
}
