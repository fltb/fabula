// ────────────────────────────────────────────────────────────────────────────
// countWords — Utility
// ────────────────────────────────────────────────────────────────────────────

/**
 * Counts words in a text string, stripping common markdown formatting
 * so the count more closely reflects the actual prose word count.
 */
export function countWords(text: string): number {
  const cleaned = text
    // Remove markdown headings markers, list markers, blockquotes, separators
    .replace(/^[#*\-_~`>|]+\s*/gm, '')
    // Remove inline links: keep the displayed text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove image tags
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}
