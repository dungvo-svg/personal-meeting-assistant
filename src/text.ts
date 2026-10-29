// How transcript text is shown to Claude and in RAW: names corrected from the glossary, Whisper's silence
// phrases set aside, and runs of the same short segment folded into one line. Stored text is never changed.

export type GlossaryEntry = { name: string; variants: string[] };
type Row = { id: number; text: string; boundary?: string };

export const isHallucination = (row: Row) => !!row.boundary?.includes('LIKELY_HALLUCINATION');

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Nam Phủ" heard by ASR becomes "Namfon (nghe: Nam Phủ)", so a wrong guess stays visible.
export function applyGlossary(text: string, glossary: GlossaryEntry[]) {
  for (const entry of glossary) {
    for (const variant of [...entry.variants].sort((a, b) => b.length - a.length)) {
      if (!variant.trim() || variant.toLowerCase() === entry.name.toLowerCase()) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(variant)}(?![\\p{L}\\p{N}])`, 'giu');
      text = text.replace(pattern, match => `${entry.name} (nghe: ${match})`);
    }
  }
  return text;
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

// ASR loops ("cái", "cái", "cái"…) arrive as many segments; three or more identical short ones become one entry.
export function foldRuns<T extends Row>(rows: T[], minRun = 3, maxWords = 4) {
  const out: { first: T; last: T; count: number }[] = [];
  for (const row of rows) {
    const previous = out.at(-1); const key = normalized(row.text);
    if (previous && key && key.split(' ').length <= maxWords && normalized(previous.first.text) === key) { previous.last = row; previous.count++; }
    else out.push({ first: row, last: row, count: 1 });
  }
  return out.flatMap(group => group.count >= minRun ? [group] : rowsOf(rows, group));
}
function rowsOf<T extends Row>(rows: T[], group: { first: T; last: T; count: number }) {
  const start = rows.indexOf(group.first);
  return rows.slice(start, start + group.count).map(row => ({ first: row, last: row, count: 1 }));
}
