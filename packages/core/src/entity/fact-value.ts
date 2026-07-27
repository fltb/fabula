// ============================================================================
// FactValue — Canonical form, validation, and deep equality
// ============================================================================
//
// STATE-1: All Fact values written to WorldState MUST be canonicalized.
// Canonical values are JSON-compatible primitives, plain objects, and arrays.
// Frozen at every level to prevent accidental mutation.

import { ConfigError } from '../errors.js';

export type CanonicalFactValue =
  | null
  | boolean
  | number
  | string
  | CanonicalFactValue[]
  | { [k: string]: CanonicalFactValue };

/**
 * Check whether `v` is a valid CanonicalFactValue.
 * Rejects undefined, NaN, Infinity, -Infinity, Date, class instances,
 * functions, and symbols. Recursively validates arrays and objects.
 */
export function isCanonicalFactValue(v: unknown): boolean {
  if (v === null) return true;
  if (v === undefined) return false;

  const type = typeof v;
  if (type === 'boolean') return true;
  if (type === 'number') {
    return Number.isFinite(v);
  }
  if (type === 'string') return true;
  if (type === 'bigint') return false;
  if (type === 'symbol') return false;
  if (type === 'function') return false;

  if (Array.isArray(v)) {
    return v.every(isCanonicalFactValue);
  }

  if (typeof v === 'object') {
    // Reject Date, RegExp, Map, Set, class instances, etc.
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) return false;
    return Object.values(v as Record<string, unknown>).every(isCanonicalFactValue);
  }

  return false;
}

/**
 * Deep-copy `v` into canonical form, freezing every level.
 * Throws ConfigError if `v` cannot be represented as CanonicalFactValue.
 */
export function canonicalizeFactValue(v: unknown): CanonicalFactValue {
  if (v === null) return null;
  if (v === undefined) {
    throw new ConfigError('Non-canonical FactValue: undefined is not allowed');
  }

  const type = typeof v;
  if (type === 'boolean') return v as CanonicalFactValue;
  if (type === 'number') {
    if (!Number.isFinite(v)) {
      throw new ConfigError(`Non-canonical FactValue: non-finite number ${v}`);
    }
    return v as CanonicalFactValue;
  }
  if (type === 'string') return v as CanonicalFactValue;
  if (type === 'bigint') {
    throw new ConfigError('Non-canonical FactValue: BigInt is not allowed');
  }
  if (type === 'symbol') {
    throw new ConfigError('Non-canonical FactValue: Symbol is not allowed');
  }
  if (type === 'function') {
    throw new ConfigError('Non-canonical FactValue: function is not allowed');
  }

  if (Array.isArray(v)) {
    const arr = v.map(canonicalizeFactValue);
    return Object.freeze(arr) as unknown as CanonicalFactValue;
  }

  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) {
      if (v instanceof Date) {
        throw new ConfigError('Non-canonical FactValue: Date instances are not allowed');
      }
      throw new ConfigError('Non-canonical FactValue: class instances are not allowed');
    }
    const obj: Record<string, CanonicalFactValue> = {};
    for (const key of Object.keys(v as Record<string, unknown>)) {
      obj[key] = canonicalizeFactValue((v as Record<string, unknown>)[key]);
    }
    return Object.freeze(obj) as unknown as CanonicalFactValue;
  }

  throw new ConfigError(`Non-canonical FactValue: unexpected type ${type}`);
}

/**
 * Deep equality for CanonicalFactValue.
 * Key-order independent for objects. Uses Object.is for primitives.
 */
export function canonicalDeepEqual(a: CanonicalFactValue, b: CanonicalFactValue): boolean {
  if (Object.is(a, b)) return true;

  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  const aType = typeof a;
  const bType = typeof b;
  if (aType !== bType) return false;

  if (aType === 'boolean' || aType === 'number' || aType === 'string') {
    return Object.is(a, b);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!canonicalDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (!Array.isArray(a) && !Array.isArray(b) && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, CanonicalFactValue>).sort();
    const bKeys = Object.keys(b as Record<string, CanonicalFactValue>).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (
        !canonicalDeepEqual(
          (a as Record<string, CanonicalFactValue>)[aKeys[i]],
          (b as Record<string, CanonicalFactValue>)[bKeys[i]],
        )
      )
        return false;
    }
    return true;
  }

  return false;
}
