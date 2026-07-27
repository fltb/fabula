// ============================================================================
// canonical-fact-value.test.ts — CanonicalFactValue validation, canonicalization,
// freezing, and deep equality
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  canonicalDeepEqual,
  canonicalizeFactValue,
  isCanonicalFactValue,
} from '../../src/entity/fact-value.js';
import { ConfigError } from '../../src/errors.js';

describe('CanonicalFactValue acceptance', () => {
  it('accepts null', () => {
    expect(isCanonicalFactValue(null)).toBe(true);
    expect(canonicalizeFactValue(null)).toBe(null);
  });

  it('accepts boolean', () => {
    expect(isCanonicalFactValue(true)).toBe(true);
    expect(isCanonicalFactValue(false)).toBe(true);
    expect(canonicalizeFactValue(true)).toBe(true);
    expect(canonicalizeFactValue(false)).toBe(false);
  });

  it('accepts finite numbers', () => {
    expect(isCanonicalFactValue(0)).toBe(true);
    expect(isCanonicalFactValue(-1)).toBe(true);
    expect(isCanonicalFactValue(3.14)).toBe(true);
    expect(isCanonicalFactValue(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(canonicalizeFactValue(42)).toBe(42);
    expect(canonicalizeFactValue(0)).toBe(0);
  });

  it('accepts strings', () => {
    expect(isCanonicalFactValue('hello')).toBe(true);
    expect(isCanonicalFactValue('')).toBe(true);
    expect(canonicalizeFactValue('world')).toBe('world');
  });

  it('accepts arrays of canonical values', () => {
    const arr = [1, 'two', null, true, [3, 4]];
    expect(isCanonicalFactValue(arr)).toBe(true);
    const canon = canonicalizeFactValue(arr);
    expect(Array.isArray(canon)).toBe(true);
    expect(canon).toEqual([1, 'two', null, true, [3, 4]]);
  });

  it('accepts plain objects', () => {
    const obj = { a: 1, b: 'two', c: null, d: { e: true } };
    expect(isCanonicalFactValue(obj)).toBe(true);
    const canon = canonicalizeFactValue(obj);
    expect(canon).toEqual({ a: 1, b: 'two', c: null, d: { e: true } });
  });
});

describe('CanonicalFactValue rejection', () => {
  it('rejects undefined', () => {
    expect(isCanonicalFactValue(undefined)).toBe(false);
    expect(() => canonicalizeFactValue(undefined)).toThrow(ConfigError);
  });

  it('rejects NaN', () => {
    expect(isCanonicalFactValue(NaN)).toBe(false);
    expect(() => canonicalizeFactValue(NaN)).toThrow(ConfigError);
  });

  it('rejects Infinity', () => {
    expect(isCanonicalFactValue(Infinity)).toBe(false);
    expect(isCanonicalFactValue(-Infinity)).toBe(false);
    expect(() => canonicalizeFactValue(Infinity)).toThrow(ConfigError);
    expect(() => canonicalizeFactValue(-Infinity)).toThrow(ConfigError);
  });

  it('rejects Date instances', () => {
    expect(isCanonicalFactValue(new Date())).toBe(false);
    expect(() => canonicalizeFactValue(new Date())).toThrow(ConfigError);
  });

  it('rejects class instances', () => {
    class MyClass {}
    const instance = new MyClass();
    expect(isCanonicalFactValue(instance)).toBe(false);
    expect(() => canonicalizeFactValue(instance)).toThrow(ConfigError);
  });

  it('rejects functions', () => {
    expect(isCanonicalFactValue(() => {})).toBe(false);
    expect(() => canonicalizeFactValue(() => {})).toThrow(ConfigError);
  });

  it('rejects symbols', () => {
    expect(isCanonicalFactValue(Symbol('test'))).toBe(false);
    expect(() => canonicalizeFactValue(Symbol('test'))).toThrow(ConfigError);
  });

  it('rejects BigInt', () => {
    expect(isCanonicalFactValue(BigInt(42))).toBe(false);
    expect(() => canonicalizeFactValue(BigInt(42))).toThrow(ConfigError);
  });

  it('rejects RegExp', () => {
    expect(isCanonicalFactValue(/regex/)).toBe(false);
    expect(() => canonicalizeFactValue(/regex/)).toThrow(ConfigError);
  });
});

describe('CanonicalFactValue freezing', () => {
  it('freezes top-level objects', () => {
    const canon = canonicalizeFactValue({ a: 1 }) as Record<string, unknown>;
    expect(Object.isFrozen(canon)).toBe(true);
  });

  it('freezes nested objects', () => {
    const canon = canonicalizeFactValue({ a: { b: 2 } }) as Record<string, unknown>;
    expect(Object.isFrozen(canon)).toBe(true);
    expect(Object.isFrozen(canon.a as Record<string, unknown>)).toBe(true);
  });

  it('freezes arrays', () => {
    const canon = canonicalizeFactValue([1, [2, 3]]) as unknown[];
    expect(Object.isFrozen(canon)).toBe(true);
    expect(Object.isFrozen(canon[1] as unknown[])).toBe(true);
  });

  it('prevents mutation of frozen copy', () => {
    const canon = canonicalizeFactValue({ a: 1 }) as Record<string, unknown>;
    expect(() => {
      (canon as Record<string, unknown>).b = 2;
    }).toThrow();
  });
});

describe('canonicalDeepEqual', () => {
  it('returns true for identical primitives', () => {
    expect(canonicalDeepEqual(42, 42)).toBe(true);
    expect(canonicalDeepEqual('hello', 'hello')).toBe(true);
    expect(canonicalDeepEqual(true, true)).toBe(true);
    expect(canonicalDeepEqual(null, null)).toBe(true);
  });

  it('returns false for different primitives', () => {
    expect(canonicalDeepEqual(42, 43)).toBe(false);
    expect(canonicalDeepEqual('hello', 'world')).toBe(false);
    expect(canonicalDeepEqual(true, false)).toBe(false);
  });

  it('compares arrays recursively', () => {
    expect(canonicalDeepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(canonicalDeepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(canonicalDeepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(canonicalDeepEqual([1, [2, 3]], [1, [2, 4]])).toBe(false);
  });

  it('compares objects key-order independently', () => {
    expect(canonicalDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonicalDeepEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(canonicalDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('compares deeply nested objects', () => {
    const a = { x: { y: { z: 42 } } };
    const b = { x: { y: { z: 42 } } };
    expect(canonicalDeepEqual(a, b)).toBe(true);
    (b as Record<string, unknown>).x = { y: { z: 43 } };
    expect(canonicalDeepEqual(a, b)).toBe(false);
  });
});
