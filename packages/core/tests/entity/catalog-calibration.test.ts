// ============================================================================
// Catalog Calibration Tests — Step 2 of the epistemic NovelIR plan
// ============================================================================
//
// Two deterministic gates over the authored fixture corpora:
//
// 1. Authored catalog contract: every definitions/entity-types.yaml matches the
//    strict, versionless source schema the compiler will parse (typeId === map
//    key, kind, explicit attribute policies, lifecyclePolicy, referenceCapabilities,
//    empty typedInvariants, no version/schemaVersion anywhere).
//
// 2. Fixture calibration: scan authored nova/definitions/chapter E*.yaml
//    (excluding scenes/, .nova/, reference/ and render artifacts) and assert
//    that every proposed attribute has an explicit authored policy and a
//    consistent valueType. The only failure categories are POLICY_REQUIRED
//    (missing explicit policy) and SHAPE_CONFLICT (incompatible observed value
//    shapes, including shapes the five-literal system cannot represent).
//
// The deterministic per-project report (console.log) is the calibration
// evidence; undeclared entity references, unused catalog entries and
// definition-baseline + introduction overlaps are report-only judgment calls.
// ============================================================================

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calibrateProject,
  findProjects,
  loadCatalogDocument,
  validateCatalogContract,
} from './calibration-scan.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const PROJECTS = findProjects(FIXTURES);

describe('authored entity catalog contract (strict, versionless)', () => {
  it('discovers every fixture project with a nova.yaml', () => {
    expect(PROJECTS.length).toBeGreaterThanOrEqual(13);
    for (const expected of [
      'zhu-fu',
      'arcane-aftermath',
      'david-copperfield',
      'dream-of-red-chamber',
      'four-generations',
      'game-dialogue-tree',
      'most-dangerous-game',
      'zhu-fu-variants/branch-A',
      'zhu-fu-variants/branch-B',
      'zhu-fu-variants/discourse-reorder',
      'zhu-fu-variants/layer-minimal',
      'zhu-fu-variants/plugin-check',
      'zhu-fu-variants/pov-switch',
    ]) {
      expect(PROJECTS).toContain(expected);
    }
  });

  it.each(PROJECTS)(
    '%s: definitions/entity-types.yaml conforms to the authored source contract',
    (rel) => {
      const projectDir = path.join(FIXTURES, rel);
      const doc = loadCatalogDocument(projectDir);
      const problems = validateCatalogContract(doc.raw);
      expect(problems).toEqual([]);
    },
  );
});

describe('fixture calibration: observed shapes vs authored catalog', () => {
  it.each(PROJECTS)(
    '%s: every proposed attribute has an explicit policy and a consistent valueType',
    (rel) => {
      const projectDir = path.join(FIXTURES, rel);
      const { failures, report } = calibrateProject(projectDir, rel);
      // The deterministic calibration report is the evidence for this project.
      console.log(`\n${report}\n`);
      expect(failures).toEqual([]);
    },
  );
});
