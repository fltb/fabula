import { describe, expect, it } from 'vitest';
import { sha256Canonical } from '../../src/cache/render-cache.ts';
import { sha256 } from '../../src/cache/pure-sha256.ts';

describe('pure synchronous SHA-256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['café', '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e'],
  ])('matches the known UTF-8 vector for %j', (input, expected) => {
    expect(sha256(input)).toBe(expected);
    expect(sha256(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is invariant to canonical object key insertion order', () => {
    expect(sha256Canonical({ b: 'second', a: 'first' })).toBe(sha256Canonical({ a: 'first', b: 'second' }));
  });
});
