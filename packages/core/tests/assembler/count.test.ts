import { describe, expect, it } from 'vitest';
import { countNarrativeText } from '../../src/assembler/count.ts';

describe('countNarrativeText', () => {
  it('counts Chinese characters and contiguous Latin/digit runs', () => {
    expect(countNarrativeText('祥林嫂看见 A12 和 2026 年。', 'zh')).toBe(9);
  });

  it('normalizes NFC and excludes presentation syntax', () => {
    expect(countNarrativeText('# 标题\n[祥林](https://example.test) <em>嫂</em>，e\u0301。', 'zh')).toBe(5);
  });

  it('counts English lexical tokens without markdown syntax', () => {
    expect(countNarrativeText('# A [linked](https://example.test) scene—well-lit.', 'en')).toBe(4);
  });
});
