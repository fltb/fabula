import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function writeCatalogRoots(root: string): void {
  const defs = join(root, 'definitions');
  writeFileSync(
    join(defs, 'entity-types.yaml'),
    `types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n`,
    'utf8',
  );
  writeFileSync(
    join(defs, 'thread-types.yaml'),
    `types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy:\n      reopenPolicy: forbidden\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n`,
    'utf8',
  );
  writeFileSync(
    join(defs, 'propositions.yaml'),
    'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'utf8',
  );
  writeFileSync(join(defs, 'relationship-types.yaml'), 'types: {}\n', 'utf8');
  writeFileSync(join(defs, 'rule-types.yaml'), 'types: {}\n', 'utf8');
}

export function writeAuthoringFixture(
  root: string,
  options: { discourseLedger?: boolean } = {},
): void {
  mkdirSync(join(root, 'definitions', 'characters'), { recursive: true });
  mkdirSync(join(root, 'chapters', 'chapter_01'), { recursive: true });
  writeFileSync(join(root, 'nova.yaml'), 'project: fixture\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'state_initial.yaml'), 'facts: []\n', 'utf8');
  writeCatalogRoots(root);
  writeFileSync(join(root, 'definitions', 'characters', 'z.yaml'), 'id: z\n', 'utf8');
  writeFileSync(join(root, 'definitions', 'characters', 'a.yaml'), 'id: a\n', 'utf8');
  writeFileSync(join(root, 'chapters', 'chapter_01', '_chapter.yaml'), 'chapter: 1\n', 'utf8');
  writeFileSync(join(root, 'chapters', 'chapter_01', 'E1.yaml'), 'event: E1\n', 'utf8');
  if (options.discourseLedger)
    writeFileSync(join(root, 'definitions', 'discourse-ledger.yaml'), 'version: 1\n', 'utf8');
}
