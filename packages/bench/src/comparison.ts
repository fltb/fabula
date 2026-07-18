// ============================================================================
// 祝福 (Zhu Fu) Comparison Framework — LLM-assisted prose comparison
// ============================================================================
//
// Provides data structures and a reporting function for comparing generated
// prose against original excerpts from 祝福 (Lu Xun's "New Year's Sacrifice").
//
// Actual LLM-assisted similarity evaluation is delegated to external scripts
// or test harnesses. This module only provides the structural types, the
// reporting function createComparisonReport(), and reference excerpts.
// ============================================================================

/**
 * A single event/segment comparison between original and generated text.
 */
export interface ComparisonSegment {
  eventId: string;
  originalExcerpt: string;
  generatedExcerpt: string;
  similarityScore?: number;     // 0-1, LLM-evaluated
  thematicAlignment?: 'strong' | 'moderate' | 'weak' | 'none';
  structuralMatch?: boolean;    // scene structure matched?
  notes: string;
}

/**
 * Complete comparison report covering all events in a story.
 */
export interface ComparisonReport {
  storyId: string;
  segments: ComparisonSegment[];
  overallSimilarity: number;    // average of similarityScore
  thematicScore: number;        // % of strong+moderate alignments
  structuralAccuracy: number;   // % of structuralMatch=true
  generatedAt: string;
}

/**
 * Create a comparison report from individual segment comparisons.
 * Computes aggregate scores: overall similarity average, thematic alignment
 * percentage, and structural accuracy percentage.
 */
export function createComparisonReport(segments: ComparisonSegment[]): ComparisonReport {
  const scored = segments.filter(s => s.similarityScore !== undefined);
  const overallSimilarity = scored.length > 0
    ? scored.reduce((sum, s) => sum + (s.similarityScore ?? 0), 0) / scored.length
    : 0;

  const thematic = segments.filter(
    s => s.thematicAlignment === 'strong' || s.thematicAlignment === 'moderate',
  );
  const structural = segments.filter(s => s.structuralMatch === true);

  return {
    storyId: 'zhu-fu',
    segments,
    overallSimilarity: Math.round(overallSimilarity * 100) / 100,
    thematicScore: segments.length > 0
      ? Math.round((thematic.length / segments.length) * 100)
      : 0,
    structuralAccuracy: segments.length > 0
      ? Math.round((structural.length / segments.length) * 100)
      : 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Reference excerpts from the original 祝福 (New Year's Sacrifice) text
 * for each event in the fixture. These map to the canonical events E0-E6.
 *
 * Source: Lu Xun, "祝福" (1924). Public domain text.
 */
export const ZHU_FU_REFERENCE_EXCERPTS: Record<string, string> = {
  E0: '她一手提着竹篮，内中一个破碗，空的；一手拄着一支比她更长的竹竿，下端开了裂：她分明已经纯乎是一个乞丐了。',
  E1: '"不早不迟，偏偏要在这时候，——这就可见是一个谬种！"',
  E2: '大家都说鲁四老爷家里雇着了女工，实在比勤快的男人还勤快。到年底，扫尘，洗地，杀鸡，宰鹅，彻夜的煮福礼，全是一人担当，竟没有雇短工。',
  E3: '她婆婆来抓她回去的时候，是早已许给了贺家坳的贺老六的，所以回家之后不几天，也就装在花轿里抬去了。',
  E4: '"我真傻，真的，"祥林嫂抬起她没有神采的眼睛来，接着说。',
  E5: '"你放着罢，祥林嫂！"四婶慌忙大声说。她像是受了炮烙似的缩手，脸色同时变作灰黑，也不再去取烛台。',
  E6: '我独坐在发出黄光的菜油灯下，想，这百无聊赖的祥林嫂，被人们弃在尘芥堆中的，看得厌倦了的陈旧的玩物，先前还将形骸露在尘芥里，从活得有趣的人们看来，恐怕要怪讶她何以还要存在，现在总算被无常打扫得干干净净了。',
};
