import { tableFromIPC } from 'apache-arrow';
import { readFileSync } from 'fs';

const buf = readFileSync('/home/float/myfile/Projects/novalistically/bench-data/interactive-novels-3k/data-00000-of-00002.arrow');
const table = tableFromIPC(buf);

// Find a rich book with high popularity
let best = null, bestPop = 0;
for (let i = 0; i < Math.min(500, table.numRows); i++) {
  const r = table.get(i).toJSON();
  const chs = Array.from(r.book_chapter || []);
  const pop = Number(r.popularity) || 0;
  // prefer books with many chapters and dialogue
  if (chs.length > 20 && pop > bestPop) { best = r; bestPop = pop; }
}
console.log('Book:', best.book_title, '| author:', best.book_author);
console.log('Tags:', best.book_tag);
console.log('Intro:', best.book_intro.slice(0, 200));
console.log('Chapters:', Array.from(best.book_chapter).length);
console.log('Popularity:', best.popularity, '| Collect:', best.collect);

const chs = Array.from(best.book_chapter);
for (let i = 0; i < Math.min(3, chs.length); i++) {
  const ch = chs[i];
  const items = Array.from(ch.content || []);
  console.log(`\n--- Chapter ${i}: ${ch.chapter_title} (${items.length} segments) ---`);
  for (let j = 0; j < Math.min(8, items.length); j++) {
    const tag = items[j].content_tag || '?';
    const role = items[j].role ? `[${items[j].role}]` : '';
    const text = (items[j].content || '').slice(0, 100);
    console.log(`  ${tag.padEnd(10)} ${role.padEnd(16)} ${text}`);
  }
}
