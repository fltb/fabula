import type { JsonValue } from '../contracts/json.js';

/** Core-defined identity; hosts must not interpret its fields or derive paths from it. */
export interface LayeredCacheKey {
  readonly version: 1;
  readonly sourceHash: string;
  readonly layers: Readonly<Record<string, string>>;
}

/** Complete derived output. It is never an accepted-artifact source. */
export interface RenderCacheRecord {
  readonly version: 1;
  readonly key: LayeredCacheKey;
  readonly recordHash: string;
  readonly output: JsonValue;
}

export interface RenderCacheRepository {
  get(input: { readonly key: LayeredCacheKey }): Promise<RenderCacheRecord | null>;
  put(input: { readonly key: LayeredCacheKey; readonly record: RenderCacheRecord }): Promise<void>;
  remove(input: { readonly key: LayeredCacheKey }): Promise<void>;
}
