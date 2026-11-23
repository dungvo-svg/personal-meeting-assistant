// The name table of a meeting (item 8, 0.13.3): which names the recogniser should be told about, and which wrong spellings may be
// corrected where the sentence itself shows the word is a name. Sources: the session's context (attendees, mentioned people,
// nicknames, system names), the glossary, and names met in earlier meetings of this machine (read from the runtime DB at run time).
// Nothing here changes stored text: hotwords go to the recogniser, corrections only change what is shown.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Participant } from './participants.js';
import type { GlossaryEntry } from './text.js';

export type NameSource = 'context' | 'glossary' | 'history';
export type TableName = { name: string; kind: 'attendee' | 'mentioned' | 'alias' | 'system' | 'glossary'; source: NameSource };

// Short on purpose: faster-whisper puts hotwords in front of the decoded text as a prompt, so a long list eats the model's context and
// makes it repeat names. A few dozen terms and ~240 characters is the cap (plan 0.13, item 8).
export const HOTWORDS_MAX_TERMS = 24;
export const HOTWORDS_MAX_CHARS = 240;
export const HOTWORDS_FILE = 'hotwords.json';
const HISTORY_SESSIONS = 40;
const HISTORY_MAX = 12;
const LAO = /[຀-໿]/u;
const KIND_RANK: Record<string, number> = { system: 0, attendee: 1, mentioned: 2, alias: 3, glossary: 4 };

// Names of earlier meetings (not this one), most often met first. Aliases are left out: a nickname is only true in its own meeting.
export function historyNames(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }, exceptSessionId?: string, limit = HISTORY_MAX): TableName[] {
  const counts = new Map<string, { name: string; kind: TableName['kind']; n: number }>();
  let rows: any[] = [];
  try { rows = db.prepare('SELECT id,context FROM sessions ORDER BY created DESC LIMIT ?').all(HISTORY_SESSIONS); } catch { return []; }
  for (const row of rows) {
    if (row.id === exceptSessionId) continue;
    let context: any; try { context = JSON.parse(row.context); } catch { continue; }
    const entries: Participant[] = [...(Array.isArray(context?.participants) ? context.participants : []), ...(Array.isArray(context?.names) ? context.names : [])];
    for (const entry of entries) {
      if (typeof entry?.name !== 'string' || !entry.name.trim() || entry.kind === 'alias') continue;
      const key = entry.name.trim().toLowerCase(); const seen = counts.get(key);
      if (seen) seen.n++; else counts.set(key, { name: entry.name.trim(), kind: (entry.kind ?? 'attendee') as TableName['kind'], n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1)).slice(0, limit).map(({ name, kind }) => ({ name, kind, source: 'history' as const }));
}

// Every name the table holds for this meeting, once each, most trusted source first: this meeting's own context, then the glossary,
// then earlier meetings.
export function nameTable(context: { participants?: Participant[]; names?: Participant[] } | undefined, glossary: GlossaryEntry[], history: TableName[] = []): TableName[] {
  const out = new Map<string, TableName>();
  const add = (item: TableName) => { const key = item.name.trim().toLowerCase(); if (key && !out.has(key)) out.set(key, { ...item, name: item.name.trim() }); };
  const own: TableName[] = [...(context?.participants ?? []), ...(context?.names ?? [])].map(p => ({ name: p.name, kind: p.kind ?? 'attendee', source: 'context' as const }));
  own.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  own.forEach(add);
  glossary.forEach(entry => add({ name: entry.name, kind: 'glossary', source: 'glossary' }));
  history.forEach(add);
  return [...out.values()];
}

// The text to hand the recogniser as hotwords, one string per model. The Vietnamese model gets every name that is not written only in Lao
// script. The Lao model gets only names written in Lao script: a Latin word in its prompt invites it to write Latin where the speech is Lao.
// A one-word nickname shorter than 3 letters ("Ta") is left out: it only teaches the decoder a common word.
export function hotwordsOf(table: TableName[]) {
  const fit = (names: string[]) => {
    const picked: string[] = []; let chars = 0;
    for (const name of names) {
      if (picked.length >= HOTWORDS_MAX_TERMS || chars + name.length + (picked.length ? 2 : 0) > HOTWORDS_MAX_CHARS) break;  // 2: the ", " between
      chars += name.length + (picked.length ? 2 : 0); picked.push(name);
    }
    return picked;
  };
  const usable = table.filter(t => [...t.name.replace(/[^\p{L}\p{N}]/gu, '')].length >= 3).map(t => t.name);
  const vi = fit(usable.filter(name => !(LAO.test(name) && !/[A-Za-zÀ-ɏḀ-ỿ]/u.test(name))));
  const lo = fit(usable.filter(name => LAO.test(name)));
  return { vi, lo };
}

// The file the ASR worker reads (tools/audio_worker.py, next to the recorder's files). The worker looks at it again for every chunk, so a
// name added in the middle of a meeting is used from the next chunk on. Rewritten only when the text changed.
export function writeHotwordsFile(dir: string, table: TableName[], now = new Date()) {
  const { vi, lo } = hotwordsOf(table);
  const body = JSON.stringify({ v: 1, updated: now.toISOString(), vi: vi.join(', '), lo: lo.join(', '), terms: { vi, lo } });
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, HOTWORDS_FILE);
    writeFileSync(path, body, 'utf8');
    return { path, vi: vi.length, lo: lo.length };
  } catch { return null; }
}
export const hotwordsFileExists = (dir: string) => existsSync(join(dir, HOTWORDS_FILE));

// ---- correction where the sentence shows a name --------------------------------------------------------------------------
// A weak variant is a wrong spelling that is also an ordinary word ("dùng" heard for "Dũng"). It is corrected ONLY when what follows it is
// a verb that hands out work ("nghiên cứu", "phụ trách", "gửi"…) and what stands before it is not a word that makes it the ordinary verb
// ("để dùng", "cần dùng", "không dùng"). The correction is marked: "Dũng (nghe: dùng) (sửa theo bảng tên)". Any other "dùng" stays as heard.
const ASSIGN_VERBS = ['nghiên cứu', 'phụ trách', 'chịu trách nhiệm', 'xử lý', 'xử lí', 'kiểm tra', 'soạn', 'gửi', 'báo cáo', 'theo dõi', 'liên hệ', 'hoàn thành', 'chuẩn bị', 'triển khai', 'cập nhật', 'rà soát', 'tổng hợp', 'đảm nhận', 'thực hiện', 'lên kế hoạch', 'check', 'review'];
const NOT_A_NAME_BEFORE = new Set(['để', 'cần', 'nên', 'được', 'phải', 'có', 'thể', 'không', 'chưa', 'hay', 'thường', 'đang', 'đã', 'sẽ', 'cũng', 'vẫn', 'chỉ', 'mới', 'sử', 'khi', 'nếu']);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type WeakRule = { name: string; variant: string };
export function weakNameRules(entries: Participant[] | undefined): WeakRule[] {
  const out: WeakRule[] = [];
  for (const entry of entries ?? []) {
    if (entry.kind === 'alias') continue;
    for (const variant of entry.weakVariants ?? []) if (variant.trim() && variant.trim().toLowerCase() !== entry.name.trim().toLowerCase()) out.push({ name: entry.name, variant: variant.trim() });
  }
  return out;
}

export const WEAK_FLAG = '(sửa theo bảng tên)';
export function applyWeakNames(text: string, rules: WeakRule[]) {
  if (!rules.length) return text;
  const verbs = ASSIGN_VERBS.map(escape).join('|');
  for (const { name, variant } of rules) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escape(variant)})(?=\\s+(?:${verbs})(?![\\p{L}\\p{N}]))`, 'giu');
    text = text.replace(pattern, (match: string, _found: string, offset: number, whole: string) => {
      const prefix = whole.slice(0, offset);
      // Already inside the "(nghe: …)" tail of an earlier correction: leave it.
      if (/\(nghe:[^)]*$/u.test(prefix)) return match;
      // The word right before it (same clause, only spaces between) makes it the ordinary verb.
      const before = /([\p{L}\p{N}]+)\s+$/u.exec(prefix)?.[1]?.toLowerCase();
      if (before && NOT_A_NAME_BEFORE.has(before)) return match;
      return `${name} (nghe: ${match}) ${WEAK_FLAG}`;
    });
  }
  return text;
}
