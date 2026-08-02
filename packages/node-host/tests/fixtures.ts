import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeAuthoringFixture(root: string, options: { discourseLedger?: boolean } = {}): void {
  mkdirSync(join(root, 'definitions', 'characters'), { recursive: true });
  mkdirSync(join(root, 'chapters', 'chapter_01'), { recursive: true });
  writeFileSync(join(root, 'nova.yaml'), 'project: fixture\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'state_initial.yaml'), 'facts: []\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'entity-types.yaml'), 'entities: []\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'characters', 'z.yaml'), 'id: z\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'characters', 'a.yaml'), 'id: a\n', 'utf8');
  writeFileSync(join(root, 'chapters', 'chapter_01', '_chapter.yaml'), 'chapter: 1\n', 'utf8');
  writeFileSync(join(root, 'chapters', 'chapter_01', 'E1.yaml'), 'event: E1\n', 'utf8');
  if (options.discourseLedger) writeFileSync(join(root, 'definitions', 'discourse-ledger.yaml'), 'version: 1\n', 'utf8');
}
