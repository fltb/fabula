import type {
  LayeredCacheKey,
  RenderCacheRecord,
  RenderCacheRepository,
} from '@novalistically/core';

export type { LayeredCacheKey, RenderCacheRecord, RenderCacheRepository };

export interface FileRenderCacheRepositoryOptions {
  /** Private runtime directory below the project root. Defaults to `.nova/render-cache`. */
  readonly relativeDirectory?: string;
}
