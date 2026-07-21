import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../../src/errors.ts';
import { readYamlFile } from '../../src/entity/yaml-loader.ts';
import { eventFileSchema } from '../../src/schemas/event.ts';

const event = `event: E1\nnarrativeOrder: 1\ntitle: Test\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: test\npreconditions: []\nexpectedPostconditions: []\n`;

describe('strict YAML compiler', () => {
  it('preserves valid typed YAML and rejects malformed, unknown, and absent required files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-yaml-'));
    const valid = join(dir, 'event.yaml');
    const malformed = join(dir, 'malformed.yaml');
    const unknown = join(dir, 'unknown.yaml');
    try {
      writeFileSync(valid, event);
      writeFileSync(malformed, 'event: [');
      writeFileSync(unknown, `${event}unsupported: true\n`);
      expect(readYamlFile({ filePath: valid, schema: eventFileSchema })?.event).toBe('E1');
      for (const path of [malformed, unknown, join(dir, 'missing.yaml')]) {
        try {
          readYamlFile({ filePath: path, schema: eventFileSchema });
          throw new Error('expected ConfigError');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).code).toBe('CONFIG_INVALID');
          expect((error as ConfigError).context.path).toContain(path);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
