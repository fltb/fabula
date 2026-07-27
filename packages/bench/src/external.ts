// ============================================================================
// External Benchmarks — P3 external dataset adapters
// ============================================================================
//
// Runs the actual external dataset conversion adapters and produces
// measurability results: conversion stats, field-level provenance
// coverage, and entity counts.
//
// Each adapter is called with the provided raw data (if any) or skipped
// gracefully. Results are reported as ExternalBenchResult entries that
// can be consumed by the main bench runner in index.ts.

import { convertAgentSFT, convertChiNovelKE, convertIN3KNovel } from './adapters/index.js';

export interface ExternalBenchResult {
  dataset: string;
  benchmark: string;
  metric: string;
  value: number;
  status: 'pending' | 'ran' | 'skipped' | 'failed';
  error?: string;
}

export interface ExternalBenchOptions {
  /** Raw ChiNovelKE dataset characters/locations/relations */
  chinovelke?: {
    characters: Array<{
      id: string;
      name: string;
      aliases: string[];
      gender: '男' | '女' | '未知';
      age_range?: string;
      role: 'protagonist' | 'antagonist' | 'supporting' | 'background';
      description: string;
      traits: string[];
      relations: string[];
      locations: string[];
    }>;
    locations: Array<{
      id: string;
      name: string;
      parent_id?: string;
      description: string;
      era?: string;
    }>;
    relations: Array<{
      id: string;
      type: string;
      from_id: string;
      to_id: string;
      direction: string;
      intensity: number;
      description: string;
    }>;
    events?: Array<Record<string, unknown>>;
  };
  /** Raw NovelAgentSFT chapter data */
  novelsft?: Array<{
    chapter_id: string;
    chapter_index: number;
    title: string;
    summary: string;
    word_count: number;
    events: Array<{
      event_id: string;
      description: string;
      characters_involved: string[];
      location: string;
      conflict_type?: string;
      emotional_tone?: string;
    }>;
    characters_appearing: string[];
    locations: string[];
  }>;
  /** Raw InteractiveNovels3K novel data */
  in3k?: Array<{
    novel_id: string;
    title: string;
    author: string;
    genre: string;
    chapters: Array<{
      novel_id: string;
      chapter_id: string;
      chapter_index: number;
      title: string;
      content: string;
      word_count: number;
      time_markers: string[];
      location_changes: string[];
      character_appearances: Record<string, number>;
    }>;
  }>;
}

/**
 * Run external dataset benchmarks.
 *
 * Accepts optional raw data for each external dataset. When data is
 * provided, the corresponding adapter conversion is executed and
 * statistics are reported. When data is omitted, the benchmark is
 * reported as 'skipped'.
 *
 * @param options  Optional raw data for external datasets
 * @returns Array of benchmark results with status, metrics, and errors
 */
export async function runExternalBench(
  options?: ExternalBenchOptions,
): Promise<ExternalBenchResult[]> {
  const results: ExternalBenchResult[] = [];

  // ── ChiNovelKE ──────────────────────────────────────────────────────────
  if (options?.chinovelke) {
    try {
      const conversion = convertChiNovelKE(options.chinovelke);
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'EntityMapper',
        metric: 'characters_converted',
        value: conversion.stats.totalCharacters,
        status: 'ran',
      });
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'EntityMapper',
        metric: 'locations_converted',
        value: conversion.stats.totalLocations,
        status: 'ran',
      });
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'EntityMapper',
        metric: 'relations_converted',
        value: conversion.stats.totalRelations,
        status: 'ran',
      });
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'FieldCoverage',
        metric: 'direct_fields',
        value: conversion.stats.directFields,
        status: 'ran',
      });
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'FieldCoverage',
        metric: 'inferred_fields',
        value: conversion.stats.inferredFields,
        status: 'ran',
      });
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'FieldCoverage',
        metric: 'unavailable_fields',
        value: conversion.stats.unavailableFields,
        status: 'ran',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        dataset: 'ChiNovelKE',
        benchmark: 'EntityMapper',
        metric: 'conversion',
        value: 0,
        status: 'failed',
        error: message,
      });
    }
  } else {
    results.push({
      dataset: 'ChiNovelKE',
      benchmark: 'EntityMapper',
      metric: 'load_success_rate',
      value: 0,
      status: 'skipped',
    });
    results.push({
      dataset: 'ChiNovelKE',
      benchmark: 'StateManager',
      metric: 'location_hierarchy_correctness',
      value: 0,
      status: 'skipped',
    });
  }

  // ── NovelAgentSFT ───────────────────────────────────────────────────────
  if (options?.novelsft) {
    try {
      const conversion = convertAgentSFT(options.novelsft);
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'EventConversion',
        metric: 'chapters_converted',
        value: conversion.chapters,
        status: 'ran',
      });
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'EventConversion',
        metric: 'events_converted',
        value: conversion.eventsConverted,
        status: 'ran',
      });
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'FieldCoverage',
        metric: 'direct_fields',
        value: conversion.coverageReport.directFields,
        status: 'ran',
      });
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'FieldCoverage',
        metric: 'inferred_fields',
        value: conversion.coverageReport.inferredFields,
        status: 'ran',
      });
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'FieldCoverage',
        metric: 'unavailable_fields',
        value: conversion.coverageReport.unavailableFields,
        status: 'ran',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        dataset: 'NovelAgentSFT',
        benchmark: 'EventConversion',
        metric: 'conversion',
        value: 0,
        status: 'failed',
        error: message,
      });
    }
  } else {
    results.push({
      dataset: 'NovelAgentSFT',
      benchmark: 'RenderPipeline',
      metric: 'throughput_tokens_per_sec',
      value: 0,
      status: 'skipped',
    });
  }

  // ── InteractiveNovels3K ─────────────────────────────────────────────────
  if (options?.in3k && options.in3k.length > 0) {
    try {
      let totalChapters = 0;
      let totalEvents = 0;
      let totalWords = 0;
      let totalDirect = 0;
      let totalInferred = 0;
      let totalUnavailable = 0;

      for (const novel of options.in3k) {
        const conversion = convertIN3KNovel(novel);
        totalChapters += conversion.chapters;
        totalEvents += conversion.eventsConverted;
        totalWords += conversion.totalWords;
        totalDirect += conversion.coverageReport.directFields;
        totalInferred += conversion.coverageReport.inferredFields;
        totalUnavailable += conversion.coverageReport.unavailableFields;
      }

      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'EventConversion',
        metric: 'novels_converted',
        value: options.in3k.length,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'EventConversion',
        metric: 'chapters_converted',
        value: totalChapters,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'EventConversion',
        metric: 'events_converted',
        value: totalEvents,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'EventConversion',
        metric: 'total_words_processed',
        value: totalWords,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'FieldCoverage',
        metric: 'direct_fields',
        value: totalDirect,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'FieldCoverage',
        metric: 'inferred_fields',
        value: totalInferred,
        status: 'ran',
      });
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'FieldCoverage',
        metric: 'unavailable_fields',
        value: totalUnavailable,
        status: 'ran',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        dataset: 'InteractiveNovels3K',
        benchmark: 'EventConversion',
        metric: 'conversion',
        value: 0,
        status: 'failed',
        error: message,
      });
    }
  } else {
    results.push({
      dataset: 'InteractiveNovels3K',
      benchmark: 'TimelineValidator',
      metric: 'false_positive_rate',
      value: 0,
      status: 'skipped',
    });
  }

  return results;
}
