import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

const FIXTURE_PATH = '/home/float/myfile/Projects/novalistically/fixtures/arcane-aftermath';

describe('deep character debug', () => {
  it('check raw bytes', () => {
    const filePath = path.join(FIXTURE_PATH, 'definitions/characters/camille.yaml');
    const buf = fs.readFileSync(filePath);
    console.log('First 100 bytes:', JSON.stringify(buf.slice(0, 100).toString('utf-8')));
    console.log('Hex:', buf.slice(0, 20).toString('hex'));
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n')[0];
    console.log('First line:', JSON.stringify(firstLine));
    console.log('First line chars:', [...firstLine].map(c => c.charCodeAt(0) + ':' + c));
    
    const parsed = YAML.parse(content);
    console.log('Parsed keys:', Object.keys(parsed));
    console.log('parsed.character:', parsed.character);
    console.log('parsed["character"]:', parsed['character']);
    console.log('All key-value pairs:');
    for (const [k, v] of Object.entries(parsed)) {
      console.log(`  ${k}: ${typeof v} ${Array.isArray(v) ? v.length : ''}`);
    }
    
    expect(1).toBe(1);
  });
});
