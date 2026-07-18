import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// P1b: zhu-fu-variants test suite
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadYaml(filePath: string) {
  return YAML.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ----- branch-A: honest answer variant -----
describe('zhu-fu-variants / branch-A (honest answer)', () => {
  const baseDir = path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'branch-A');
  const chapterDir = path.join(baseDir, 'chapters', 'chapter_01');

  it('should load project config (nova.yaml)', () => {
    const nova = loadYaml(path.join(baseDir, 'nova.yaml'));
    expect(nova.project).toBe('zhu-fu-branch-a');
    expect(nova.genre).toBe('literary');
    expect(nova.tense).toBe('past');
    expect(nova.title).toContain('分支A');
    expect(nova.synopsis).toContain('诚实地');
  });

  it('should load E0 with honest answer narrative', () => {
    const e0 = loadYaml(path.join(chapterDir, 'E0_encounter.yaml'));
    expect(e0.event).toBe('E0');
    expect(e0.sceneBrief).toContain('诚实地告诉');
    expect(e0.sceneBrief).toContain('就像灯灭');

    // Check postconditions reflect honesty, not guilt
    const knowledgePost = e0.expectedPostconditions.find(
      (p: any) => p.entity === 'narrator' && p.attribute === 'knowledge'
    );
    expect(knowledgePost.value).toBe('gave_honest_answer_to_xianglins_wife');

    const emotionalPost = e0.expectedPostconditions.find(
      (p: any) => p.entity === 'narrator' && p.attribute === 'emotionalState'
    );
    expect(emotionalPost.value).toBe('truthful_but_uncertain');
  });

  it('should load E1 with different emotional resolution', () => {
    const e1 = loadYaml(path.join(chapterDir, 'E1_death_news.yaml'));
    expect(e1.event).toBe('E1');
    expect(e1.sceneBrief).toContain('愤怒');

    const emotionalPost = e1.expectedPostconditions.find(
      (p: any) => p.entity === 'narrator' && p.attribute === 'emotionalState'
    );
    expect(emotionalPost.value).toBe('melancholy_but_not_guilty');
  });

  it('should have 7 event files', () => {
    const files = fs.readdirSync(chapterDir).filter(
      (f) => f.startsWith('E') && f.endsWith('.yaml')
    );
    expect(files.length).toBe(7);
  });

  it('should have E2-E6 as copies from base (unchanged flashback)', () => {
    const e2b = loadYaml(path.join(chapterDir, 'E2_first_arrival.yaml'));
    const e3b = loadYaml(path.join(chapterDir, 'E3_kidnapping.yaml'));
    expect(e2b.event).toBe('E2');
    expect(e3b.event).toBe('E3');
    expect(e2b.sceneType).toBe('flashback');
    expect(e3b.sceneType).toBe('flashback');
  });
});

// ----- branch-B: He Laoliu survives -----
describe('zhu-fu-variants / branch-B (He Laoliu survives)', () => {
  const baseDir = path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'branch-B');
  const chapterDir = path.join(baseDir, 'chapters', 'chapter_01');

  it('should load project config (nova.yaml)', () => {
    const nova = loadYaml(path.join(baseDir, 'nova.yaml'));
    expect(nova.project).toBe('zhu-fu-branch-b');
    expect(nova.genre).toBe('literary');
    expect(nova.tense).toBe('past');
    expect(nova.title).toContain('分支B');
    expect(nova.synopsis).toContain('贺老六挺过');
  });

  it('should load E4 with He Laoliu survival', () => {
    const e4 = loadYaml(path.join(chapterDir, 'E4_survival.yaml'));
    expect(e4.event).toBe('E4');
    expect(e4.sceneBrief).toContain('睁开了眼睛');
    expect(e4.sceneBrief).toContain('活过来了');

    const heLaoliuStatus = e4.expectedPostconditions.find(
      (p: any) => p.entity === 'he_laoliu' && p.attribute === 'status'
    );
    expect(heLaoliuStatus.value).toBe('alive');

    const locationPost = e4.expectedPostconditions.find(
      (p: any) => p.entity === 'xianglins_wife' && p.attribute === 'location'
    );
    expect(locationPost.value).toBe('he_family_hollow');
  });

  it('should load E5 with quiet years narrative', () => {
    const e5 = loadYaml(path.join(chapterDir, 'E5_quiet_years.yaml'));
    expect(e5.event).toBe('E5');
    expect(e5.sceneBrief).toContain('阿毛长成了');
    expect(e5.sceneBrief).toContain('春丫头');

    const hasSecondChild = e5.expectedPostconditions.find(
      (p: any) => p.entity === 'xianglins_wife' && p.attribute === 'has_second_child'
    );
    expect(hasSecondChild.value).toBe(true);
  });

  it('should load E6 with natural death resolution', () => {
    const e6 = loadYaml(path.join(chapterDir, 'E6_old_age.yaml'));
    expect(e6.event).toBe('E6');
    expect(e6.sceneBrief).toContain('灶上还有粥');

    const heDeathCause = e6.expectedPostconditions.find(
      (p: any) => p.entity === 'he_laoliu' && p.attribute === 'cause_of_death'
    );
    expect(heDeathCause.value).toBe('old_age');

    const xlDeathLocation = e6.expectedPostconditions.find(
      (p: any) => p.entity === 'xianglins_wife' && p.attribute === 'death_location'
    );
    expect(xlDeathLocation.value).toBe('own_home_he_family_hollow');
  });

  it('should have 7 event files (E0-E3 from base, E4-E6 new)', () => {
    const files = fs.readdirSync(chapterDir).filter(
      (f) => f.startsWith('E') && f.endsWith('.yaml')
    );
    expect(files.length).toBe(7);
    expect(files).toContain('E0_encounter.yaml');
    expect(files).toContain('E4_survival.yaml');
    expect(files).toContain('E5_quiet_years.yaml');
    expect(files).toContain('E6_old_age.yaml');
    // Should NOT contain original E4-E6 names
    expect(files).not.toContain('E4_return_to_lu.yaml');
    expect(files).not.toContain('E5_threshold_rejection.yaml');
    expect(files).not.toContain('E6_expulsion_death.yaml');
  });

  it('should have E0-E3 unchanged from base fixture', () => {
    const e0 = loadYaml(path.join(chapterDir, 'E0_encounter.yaml'));
    const e1 = loadYaml(path.join(chapterDir, 'E1_death_news.yaml'));
    expect(e0.event).toBe('E0');
    expect(e0.sceneBrief).toContain('说不清'); // original evasion
    expect(e1.event).toBe('E1');
    expect(e1.sceneBrief).toContain('谬种');
  });
});

// ----- error-injection: 28 intentionally broken YAML files -----
describe('zhu-fu-variants / error-injection (28 files)', () => {
  const eiDir = path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'error-injection');

  it('should have exactly 28 error-injection files', () => {
    const files = fs.readdirSync(eiDir).filter(f => f.endsWith('.yaml'));
    expect(files.length).toBe(28);
  });

  it('each file should have valid injected array', () => {
    const files = fs.readdirSync(eiDir).filter(f => f.endsWith('.yaml'));
    for (const file of files) {
      const data = loadYaml(path.join(eiDir, file));
      expect(data.injected).toBeDefined();
      expect(Array.isArray(data.injected)).toBe(true);
      expect(data.injected.length).toBeGreaterThanOrEqual(1);

      for (const entry of data.injected) {
        expect(entry.entityId).toBeDefined();
        expect(entry.attribute).toBeDefined();
        expect(entry.expectedValidator).toBeDefined();
        expect(entry.expectedSeverity).toBeDefined();
        expect(['error', 'warning', 'info']).toContain(entry.expectedSeverity);
        expect(entry.description).toBeDefined();
      }
    }
  });

  it('should target multiple validators (coverage check)', () => {
    const files = fs.readdirSync(eiDir).filter(f => f.endsWith('.yaml'));
    const validators = new Set<string>();
    for (const file of files) {
      const data = loadYaml(path.join(eiDir, file));
      for (const entry of data.injected) {
        validators.add(entry.expectedValidator);
      }
    }
    expect(validators.size).toBeGreaterThanOrEqual(15);
    expect(validators.has('timeline')).toBe(true);
    expect(validators.has('schema')).toBe(true);
    expect(validators.has('pacing')).toBe(true);
    expect(validators.has('appearance')).toBe(true);
  });

  it('should have the specified 001_timeline_order error', () => {
    const data = loadYaml(path.join(eiDir, '001_timeline_order.yaml'));
    expect(data.injected[0].entityId).toBe('E3');
    expect(data.injected[0].attribute).toBe('storyTime');
    expect(data.injected[0].expectedValidator).toBe('timeline');
    expect(data.injected[0].expectedSeverity).toBe('error');
  });
});

// ----- extreme-damage: 5 robustness boundary tests -----
describe('zhu-fu-variants / extreme-damage (5 files)', () => {
  const edDir = path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'extreme-damage');

  it('should have exactly 5 extreme-damage files', () => {
    const files = fs.readdirSync(edDir).filter(f => f.endsWith('.yaml'));
    expect(files.length).toBe(5);
  });

  it('each file should have valid injected array', () => {
    const files = fs.readdirSync(edDir).filter(f => f.endsWith('.yaml'));
    for (const file of files) {
      const data = loadYaml(path.join(edDir, file));
      expect(data.injected).toBeDefined();
      expect(Array.isArray(data.injected)).toBe(true);

      for (const entry of data.injected) {
        expect(entry.entityId).toBeDefined();
        expect(entry.attribute).toBeDefined();
        expect(entry.expectedValidator).toBeDefined();
        expect(entry.expectedSeverity).toBeDefined();
        expect(['error', 'warning', 'info']).toContain(entry.expectedSeverity);
        expect(entry.description).toBeDefined();
      }
    }
  });

  it('should target CausalityValidator and ReachabilityValidator', () => {
    const files = fs.readdirSync(edDir).filter(f => f.endsWith('.yaml'));
    const validators = new Set<string>();
    for (const file of files) {
      const data = loadYaml(path.join(edDir, file));
      for (const entry of data.injected) {
        validators.add(entry.expectedValidator);
      }
    }
    expect(validators.has('causality')).toBe(true);
    expect(validators.has('reachability')).toBe(true);
  });

  it('should have circular dependency test file', () => {
    const data = loadYaml(path.join(edDir, '003_circular_dependency.yaml'));
    expect(data.injected[0].description.toLowerCase()).toContain('circular');
    expect(data.injected[0].expectedValidator).toBe('causality');
  });

  it('should have missing genesis test file', () => {
    const data = loadYaml(path.join(edDir, '004_missing_genesis.yaml'));
    expect(data.injected.length).toBeGreaterThanOrEqual(1);
    const genesisEntry = data.injected.find(
      (e: any) => e.entityId === 'system:genesis'
    );
    expect(genesisEntry).toBeDefined();
    expect(genesisEntry.expectedValidator).toBe('reachability');
  });
});
