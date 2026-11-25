// How transcript text is shown to Claude and in RAW: names corrected from the glossary, Whisper's silence
// phrases set aside, and runs of the same short segment folded into one line. Stored text is never changed.

export type GlossaryEntry = { name: string; variants: string[] };
type Row = { id: number; text: string; boundary?: string };

export const isHallucination = (row: Row) => !!row.boundary?.includes('LIKELY_HALLUCINATION');

// The owner's own channel, with what the microphone was doing (flags set by the worker from the recorder's timeline, plan
// 0.11 Q-4). Null for text from the speaker channel; without a flag it stays the plain "Tôi (micro)".
export function micLabel(boundary: string | undefined, me?: string) {
  const flags = boundary ?? '';
  const mic = flags.includes('CHANNEL_MIC');
  // Speaker sound heard through the mic (src/bleed.ts, MIC_BLEED_ENV from the worker): not the owner, whatever the mic state said.
  if (mic && flags.includes('MIC_BLEED')) { const of = /MIC_BLEED #(\d+)/.exec(flags)?.[1]; return `Tiếng loa lọt vào mic${of ? ` (trùng #${of})` : ''}`; }
  const state = flags.includes('MIC_STATE_ON') ? 'mic bật' : flags.includes('MIC_STATE_OFF') ? 'mic tắt — nói riêng' : flags.includes('MIC_STATE_UNKNOWN') ? '?' : null;
  if (!mic && !state) return null;
  return `Tôi${me ? ' — ' + me : ''} (${state ?? 'micro'})`;
}

// May this row reach a share-role follower (`pma follow --as dich`, `pma read --as dich`)? Positive evidence only (plan 0.12 A): text
// the host wrote itself, a speaker row heard live by a follow worker, or a mic row whose whole chunk had the mic ON. Everything else
// (mic OFF/UNKNOWN, mixed chunks, replay of a mixed file, rows from before these flags, odd labels) stays out. synthetic_fixture is
// test data of a fixture session, never audio.
export function shareable(row: { origin?: string; boundary?: string }) {
  if (row.origin === 'system_gap' || row.origin === 'operator_text' || row.origin === 'synthetic_fixture') return true;
  const flags = row.boundary ?? '';
  // Room sound that leaked into the mic is the speaker channel's text already (src/bleed.ts): never handed on as a mic row.
  if (flags.includes('CHANNEL_MIC') && flags.includes('MIC_BLEED')) return false;
  // Both kinds need the host's live-follow stamp; a mic row also needs the worker's whole-chunk-on flag.
  // MIC_SHARE_REVOKED: the host checked the mic again at hand-over and the evidence no longer held (runtime.revalidateMic).
  return flags.includes('SOURCE_LIVE_FOLLOW') && (!flags.includes('CHANNEL_MIC') || (flags.includes('MIC_SHARE_OK') && !flags.includes('MIC_SHARE_REVOKED')));
}
// What a follower may acknowledge: everything before its oldest line not yet printed, else everything scanned (hidden lines that
// were scanned are safe to drop; a visible line is never acknowledged just because a later hidden one was scanned).
export const ackOf = (batch: { id: number }[], after: number) => batch.length ? batch[0].id - 1 : after;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A one-word variant that is itself a word of a longer name ("Linh" of "Hoàng Khánh Linh") is only the given name: many people share it,
// and it is an everyday word too. Real meeting 25/11 (Vimart training): the machine-wide glossary turned "Trang" (Trang Hoàng, an attendee)
// into "Hoàng Thị Thu Trang", "Quốc" (heard for "Cowork") into "Hoàng Nam Quốc" and "Linh" into "Hoàng Khánh Linh" — people of other meetings.
export const isShortFormOf = (variant: string, name: string) => {
  const v = variant.trim().toLowerCase(); const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return !/\s/.test(v) && words.length > 1 && words.includes(v);
};
// Is this glossary name one of the people/names of the meeting being shown? `present` holds the meeting's context names, lower case.
const inMeeting = (name: string, present: Set<string>) => {
  const key = name.trim().toLowerCase();
  if (present.has(key)) return true;
  const inner = /\(([^)]+)\)/.exec(key)?.[1]?.trim();  // "Hoàng Văn Quân (Khounkham)" is present when "Khounkham" is
  return !!inner && present.has(inner);
};

// "Nam Phủ" heard by ASR becomes "Namfon (nghe: Nam Phủ)", so a wrong guess stays visible.
// `present`: the names in this meeting's context (lower case). When given, a short form (see isShortFormOf) is expanded only for a
// glossary name that is in this meeting; without it (no meeting known) the old behaviour stays.
export function applyGlossary(text: string, glossary: GlossaryEntry[], present?: Set<string>) {
  for (const entry of glossary) {
    for (const variant of [...entry.variants].sort((a, b) => b.length - a.length)) {
      if (!variant.trim() || variant.toLowerCase() === entry.name.toLowerCase()) continue;
      if (present && isShortFormOf(variant, entry.name) && !inMeeting(entry.name, present)) continue;
      // A one-word variant is often an everyday word too ("Quân" of a person, "quân" in "quân y"; also Duy, Linh, Đức: BidOps
      // 10/11). It is taken only as written (a capital stays a capital); a variant of several words still matches any case.
      const oneWord = !/\s/.test(variant.trim());
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(variant)}(?![\\p{L}\\p{N}])`, oneWord ? 'gu' : 'giu');
      text = text.replace(pattern, match => `${entry.name} (nghe: ${match})`);
    }
  }
  return text;
}

// Variants that would rewrite ordinary speech: very short, everyday words, or already standing for another name
// (audit 30/10: "Ta" almost added; "Amit" heard for both MISA and AMIS).
const COMMON = new Set(['ta', 'là', 'và', 'có', 'không', 'cái', 'này', 'đó', 'thì', 'mà', 'anh', 'chị', 'em', 'ạ', 'dạ', 'vâng', 'ừ', 'ok', 'rồi', 'nha', 'nhé', 'nữa', 'với', 'cho', 'của', 'các', 'những', 'một', 'hai', 'ba', 'bên', 'người', 'việc', 'làm', 'đi', 'được', 'phải', 'nó', 'họ', 'mình', 'bạn', 'tôi', 'ông', 'bà', 'cô', 'chú', 'bác', 'sếp', 'file', 'phim', 'mã', 'mạng', 'giá', 'hàng', 'khách']);
export function riskyVariants(name: string, variants: string[], glossary: GlossaryEntry[]) {
  const out: { variant: string; why: string }[] = [];
  for (const variant of variants) {
    const key = variant.trim().toLowerCase();
    const other = glossary.find(e => e.name.toLowerCase() !== name.trim().toLowerCase() && (e.name.toLowerCase() === key || e.variants.some(v => v.toLowerCase() === key)));
    if ([...key.replace(/[^\p{L}\p{N}]/gu, '')].length < 3) out.push({ variant, why: 'quá ngắn' });
    else if (COMMON.has(key)) out.push({ variant, why: 'là từ thông dụng' });
    else if (other) out.push({ variant, why: `đã là cách nghe của "${other.name}"` });
  }
  return out;
}

// Monitor shows one stdout line per event and cuts long lines (audit 30/10), so a batch is printed one segment per
// line and a long segment continues on following lines.
export function wrapLine(text: string, width = 450) {
  const out: string[] = [];
  while (text.length > width) { const cut = text.lastIndexOf(' ', width); const at = cut > width / 2 ? cut : width; out.push(text.slice(0, at)); text = '  ↳ ' + text.slice(at).trimStart(); }
  return [...out, text];
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

// Loops of 1-4 words ("Thủy của Thủy của …") collapse to "Thủy của [×N]", as the audio worker does for new text; this
// covers text stored before that. One word needs 6 in a row ("có có có có" is real speech), a longer phrase 4. Shorter
// phrases are tried first so "a b a b a b a b" is "a b" x4, not "a b a b" x2.
const WORD_CHAR = '[^\\s,.;:!?…]';
const WORD_GAP = '[\\s,.;:!?…]+';
const WORD = WORD_CHAR + '+';
const LOOPS = [1, 2, 3, 4].map(words => ({ words, pattern: new RegExp(`(?<!${WORD_CHAR})(${WORD}(?:${WORD_GAP}${WORD}){${words - 1}})(?:${WORD_GAP}\\1(?!${WORD_CHAR})){${words === 1 ? 5 : 3},}`, 'giu') }));
const wordCount = (text: string) => text.match(new RegExp(WORD, 'gu'))?.length ?? 0;
export function collapseLoops(text: string) {
  for (const { words, pattern } of LOOPS) text = text.replace(pattern, (match, phrase) => `${phrase} [×${wordCount(match) / words}]`);
  return text;
}

// A segment that is mostly one repeated phrase has a key (the phrase). One the worker already wrote as "phrase [×N]"
// with N >= 4 and little else around it has the key of its text without the count. Anything else has none.
const LOOP_SHARE = 0.6;
const LOOP_MARKED_MAX_WORDS = 6;
function loopKey(text: string) {
  const counts = [...text.matchAll(/\[×(\d+)\]/g)].map(match => Number(match[1]));
  if (counts.some(count => count >= 4)) {
    const rest = normalized(text.replace(/\s*\[×\d+\]/g, ''));
    return rest && rest.split(' ').length <= LOOP_MARKED_MAX_WORDS ? rest : null;
  }
  const total = wordCount(text); let best: { key: string; covered: number } | null = null;
  for (const { pattern } of LOOPS) for (const match of text.matchAll(pattern)) {
    const covered = wordCount(match[0]);
    if (!best || covered > best.covered) best = { key: normalized(match[1]), covered };
  }
  return best && best.covered / total >= LOOP_SHARE ? best.key : null;
}

// ASR loops ("cái", "cái", "cái"…) arrive as many segments; three or more identical short ones become one entry.
// Segments that are mostly the same repeated phrase ("Thủy của Thủy của …", audit 30/10) fold from two.
// A group never spans a change of channel or mic state ("Tôi (mic bật)" vs "Tôi (mic tắt — nói riêng)" vs the speakers): G7.
const isMic = (row: Row) => !!row.boundary?.includes('CHANNEL_MIC');
const sameVoice = (a: Row, b: Row) => isMic(a) === isMic(b) && micLabel(a.boundary) === micLabel(b.boundary);
export function foldRuns<T extends Row>(rows: T[], minRun = 3, maxWords = 4) {
  const out: { first: T; last: T; count: number; loop: string | null }[] = [];
  for (const row of rows) {
    const previous = out.at(-1); const key = normalized(row.text); const loop = loopKey(row.text);
    if (previous && sameVoice(previous.first, row) && key && ((loop && previous.loop === loop) || (key.split(' ').length <= maxWords && normalized(previous.first.text) === key))) { previous.last = row; previous.count++; }
    else out.push({ first: row, last: row, count: 1, loop });
  }
  return out.flatMap(group => group.count >= (group.loop ? 2 : minRun) ? [group] : rowsOf(rows, group));
}
function rowsOf<T extends Row>(rows: T[], group: { first: T; last: T; count: number }) {
  const start = rows.indexOf(group.first);
  return rows.slice(start, start + group.count).map(row => ({ first: row, last: row, count: 1 }));
}

// Times an ASR segment says it covers, checked before they are trusted for the timeline, coverage, mic sharing or the ASR position
// (0.12.1, ENG-39; an offline audit on 03/11 found segments reported past the end of their input). Returns why they cannot be
// trusted, or null. A segment is a chunk range, never word timing. `maxSeconds`: the worker's longest chunk plus slack.
export function segmentTimesProblem(event: { start?: unknown; end?: unknown; wall?: unknown }, nowMs: number, sessionStartMs: number, maxSeconds = 25): string | null {
  const start = Number(event.start), end = Number(event.end);
  if (typeof event.start !== 'number' || typeof event.end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return 'NOT_A_NUMBER';
  if (start < 0 || end < 0) return 'NEGATIVE';
  if (end < start) return 'END_BEFORE_START';
  if (end - start > maxSeconds) return 'LONGER_THAN_A_CHUNK';
  if (event.wall === undefined || event.wall === null || event.wall === '') return null;
  const wall = Date.parse(String(event.wall));
  if (!Number.isFinite(wall)) return 'BAD_WALL_TIME';
  if (wall + (end - start) * 1000 > nowMs + 10000) return 'AFTER_NOW';
  if (wall < sessionStartMs - 60000) return 'BEFORE_SESSION';
  return null;
}

// The readings of a chunk (item 1a, 0.13): the same audio decoded by the Vietnamese and by the Lao model, each kept with its own signals.
// They ride in the row's `alternatives`; items with `rv` are readings, items without are the older "other Lao/Thai reading" (language, text, score).
// `avgLogProb` is the model's own mean token log-probability: two models' numbers are never one scale, so they are printed side by side and never
// subtracted here. `viSyllableShare` says how much of the text is valid Vietnamese syllables (n/d): a signal about the text, not proof of meaning.
export type Reading = { rv?: number; language: string; text: string; score?: number; model?: string; avgLogProb?: number | null; viSyllableShare?: number | null; viSyllables?: number; viTokens?: number; viSyllableVersion?: string; loopPenalty?: number; status?: string; picked?: boolean };
const STATUS_LABELS: Record<string, string> = { invented: 'nghi câu bịa', empty: 'không có chữ' };
export function readingFacts(a: Reading) {
  const parts: string[] = [];
  parts.push(`điểm mô hình ${a.avgLogProb === null || a.avgLogProb === undefined ? '?' : a.avgLogProb}${a.model ? ' (' + a.model + ')' : ''}`);
  parts.push(`âm tiết Việt ${a.viSyllableShare === null || a.viSyllableShare === undefined ? 'n/a' : `${a.viSyllables}/${a.viTokens} = ${Math.round(a.viSyllableShare * 100)}%`}`);
  parts.push(`lặp ${Math.round((a.loopPenalty ?? 0) * 100)}%`);
  if (a.status && STATUS_LABELS[a.status]) parts.push(STATUS_LABELS[a.status]);
  return parts.join(' · ');
}
// One line per reading, for `follow`, `read` and RAW. The picked reading is the row's own text: only its signals are printed (no second copy of the text).
export function readingLines(alternatives: Reading[], prefix = '  ↳ ', note = 'cách nghe khác') {
  return alternatives.map(a => {
    const text = a.text.replace(/\r?\n/g, ' ');
    if (a.rv === undefined) return `${prefix}${a.language} (${note}): ${text}`;
    const head = `${prefix}${a.language}${a.picked ? ' (dòng chính)' : ' (cách nghe song song)'} [${readingFacts(a)}]`;
    return a.picked ? head : `${head}: ${text}`;
  });
}
export const hasReadings = (alternatives: Reading[] | undefined) => !!alternatives?.some(a => a.rv !== undefined);
