// Speaker sound that leaks into the owner's microphone (room audio in Google Meet): the mic row is text of someone else, not the
// owner. The host sees both channels' rows, so it compares a mic row with the speaker rows heard at the same time; the audio
// worker (which has the sound) adds its own envelope check as MIC_BLEED_ENV and the MIC_FAINT hint (tools/audio_worker.py).
// A flagged row keeps its text and its WAV; it is only no longer "Tôi" and never reaches a share role.
//
// Conservative: the words must overlap strongly AND in time. A real owner utterance that shares a few words with what the room says
// at the same moment ("vâng", "ok anh") is too short or too weakly contained to qualify.

export type BleedRow = { id: number; text: string; wall?: string; start: number; end: number; boundary?: string };

const GRAM = 3;
export const TEXT_MIN_CHARS = 10;      // normalized characters a mic row needs before its words can be compared
export const STRONG_CONTAIN = 0.8;     // share of the mic row's trigrams found in the speaker text of the same moment
export const STRONG_DICE = 0.35;       // and the overlap against ONE speaker row, so a long speaker sentence does not swallow a short phrase
export const FAINT_CONTAIN = 0.5;      // with MIC_FAINT (mic at its noise floor, room much louder) a weaker overlap is enough
export const NEAR_SECONDS = 2;         // chunk edges of the two channels differ
export const FAINT_MIN_CHARS = 16;      // the weaker rule needs enough text for a partial overlap to mean something

export const normalizeText = (text: string) => text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

function grams(text: string) {
  const padded = ` ${normalizeText(text)} `; const out = new Map<string, number>();
  for (let i = 0; i + GRAM <= padded.length; i++) { const gram = padded.slice(i, i + GRAM); out.set(gram, (out.get(gram) ?? 0) + 1); }
  return out;
}
const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
function shared(a: Map<string, number>, b: Map<string, number>) { let n = 0; for (const [gram, count] of a) n += Math.min(count, b.get(gram) ?? 0); return n; }

// contain: share of `a`'s trigrams found in `b`; dice: symmetric overlap. Both 0 for empty text.
export function textOverlap(a: string, b: string) {
  const ga = grams(a), gb = grams(b), ta = total(ga), tb = total(gb);
  if (!ta || !tb) return { contain: 0, dice: 0 };
  const both = shared(ga, gb);
  return { contain: both / ta, dice: (2 * both) / (ta + tb) };
}

const span = (row: BleedRow) => { const begin = Date.parse(row.wall ?? ''); return [begin, begin + Math.max(0, row.end - row.start) * 1000] as const; };
export const isMicRow = (row: { boundary?: string }) => !!row.boundary?.includes('CHANNEL_MIC');

export function nearInTime(mic: BleedRow, speaker: BleedRow, seconds = NEAR_SECONDS) {
  const [a, b] = span(mic), [c, d] = span(speaker);
  return Number.isFinite(a) && Number.isFinite(c) && c <= b + seconds * 1000 && d >= a - seconds * 1000;
}

export type Bleed = { id: number; why: 'TEXT' | 'FAINT_TEXT'; contain: number; dice: number };

// The speaker row a mic row is a leak of, or null. `speakers` are rows of the speaker channel (any time; the nearby ones are picked here).
export function bleedOf(mic: BleedRow, speakers: BleedRow[]): Bleed | null {
  if (!isMicRow(mic) || normalizeText(mic.text).length < TEXT_MIN_CHARS) return null;
  const near = speakers.filter(row => !isMicRow(row) && nearInTime(mic, row) && normalizeText(row.text));
  if (!near.length) return null;
  const mine = grams(mic.text), together = new Map<string, number>();
  for (const row of near) for (const [gram, count] of grams(row.text)) together.set(gram, (together.get(gram) ?? 0) + count);
  const combined = total(mine) ? shared(mine, together) / total(mine) : 0;
  let best: { id: number; contain: number; dice: number } | null = null;
  for (const row of near) {
    const { contain, dice } = textOverlap(mic.text, row.text);
    if (!best || dice + contain > best.dice + best.contain) best = { id: row.id, contain, dice };
  }
  if (!best) return null;
  if (best.contain >= STRONG_CONTAIN && best.dice >= STRONG_DICE) return { ...best, why: 'TEXT' };
  if (mic.boundary?.includes('MIC_FAINT') && normalizeText(mic.text).length >= FAINT_MIN_CHARS && combined >= FAINT_CONTAIN) return { ...best, why: 'FAINT_TEXT' };
  return null;
}
