export const NARRATIVE_TEXT_COUNT_VERSION = 1;

/** Counts reader-visible narrative units after removing presentation syntax. */
export function countNarrativeText(text: string, language: string): number {
  const visible = text
    .normalize('NFC')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^[#>*\-`~]+\s*/gm, '');
  if (language.startsWith('zh')) {
    const cjk = visible.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? [];
    const latinRuns = visible.match(/[A-Za-z0-9]+/g) ?? [];
    return cjk.length + latinRuns.length;
  }
  return visible.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
