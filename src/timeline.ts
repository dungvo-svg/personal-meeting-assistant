// Reads what tools/recorder.py left in <audio dir>: timeline.jsonl (Q-1 of docs/PLAN_0_11.md) and the WAV files, to answer
// "where is there sound in the recording that has no transcript?" (`pma coverage`). Pure reading; never writes or records.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MIX_FILE, TIMELINE_FILE } from './audio.js';

export type TimelineEvent = { t: string; type: string; [key: string]: any };
export type Range = { from: number; to: number };  // epoch milliseconds
export type Segment = { seg: number; channel: string; rate: number; openMs: number; ticks: { ms: number; samples: number }[]; samples: number };

// One JSON per line; a line cut off by a crash or a foreign line is skipped, never fatal.
export function readTimeline(dir: string): TimelineEvent[] {
  let text = ''; try { text = readFileSync(join(dir, TIMELINE_FILE), 'utf8'); } catch { return []; }
  const events: TimelineEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const event = JSON.parse(line); if (event && typeof event.type === 'string' && Number.isFinite(Date.parse(event.t))) events.push(event); } catch {}
  }
  return events;
}

export function segmentsOf(events: TimelineEvent[]): Segment[] {
  const found = new Map<string, Segment>();
  for (const event of events) {
    if (!Number.isInteger(event.seg) || typeof event.channel !== 'string') continue;
    const key = event.seg + '/' + event.channel; const ms = Date.parse(event.t);
    if (event.type === 'open') found.set(key, { seg: event.seg, channel: event.channel, rate: Number(event.rate) || 16000, openMs: ms, ticks: [], samples: 0 });
    const segment = found.get(key); if (!segment) continue;
    if ((event.type === 'tick' || event.type === 'close') && Number.isFinite(event.samples)) { segment.ticks.push({ ms, samples: event.samples }); segment.samples = Math.max(segment.samples, event.samples); }
  }
  return [...found.values()].sort((a, b) => a.openMs - b.openMs || a.seg - b.seg);
}

// Real time of a sample of a segment. A tick says "this many samples were recorded when the clock read t", so the
// first tick at or after the sample dates it; the rate alone would drift over a 10-minute segment.
export function wallOfSample(segment: Segment, sample: number) {
  const after = segment.ticks.find(tick => tick.samples >= sample);
  if (after) return after.ms - (after.samples - sample) / segment.rate * 1000;
  const last = segment.ticks.at(-1);
  return last ? last.ms + (sample - last.samples) / segment.rate * 1000 : segment.openMs + sample / segment.rate * 1000;
}

export const segmentFile = (segment: Segment) => `seg-${String(segment.seg).padStart(4, '0')}-${segment.channel}.wav`;

// PCM16 mono data of a WAV: where it starts and how many samples it holds. The header is patched after each write by the
// recorder, but a crash can leave it stale, so the size is bounded by the real file size.
function wavLayout(fd: number, fileSize: number) {
  const head = Buffer.alloc(Math.min(4096, fileSize)); readSync(fd, head, 0, head.length, 0);
  if (head.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not a WAV');
  let rate = 16000; let offset = 12;
  while (offset + 8 <= head.length) {
    const id = head.toString('latin1', offset, offset + 4); const size = head.readUInt32LE(offset + 4);
    if (id === 'fmt ') rate = head.readUInt32LE(offset + 12);
    if (id === 'data') { const start = offset + 8; return { start, rate, samples: Math.floor(Math.min(size || Infinity, fileSize - start) / 2) }; }
    offset += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

// RMS of every `seconds`-long window of a PCM16 mono WAV (every 4th sample is enough to tell sound from silence).
export function windowRms(path: string, seconds = 1): { rate: number; rms: number[] } {
  const fd = openSync(path, 'r');
  try {
    const { start, rate, samples } = wavLayout(fd, fstatSync(fd).size); const size = Math.max(1, Math.round(rate * seconds));
    const buffer = Buffer.alloc(size * 2); const rms: number[] = [];
    for (let done = 0; done < samples; done += size) {
      const count = Math.min(size, samples - done); const got = readSync(fd, buffer, 0, count * 2, start + done * 2);
      let sum = 0; let n = 0;
      for (let i = 0; i + 1 < got; i += 8) { const value = buffer.readInt16LE(i) / 32768; sum += value * value; n++; }
      rms.push(n ? Math.sqrt(sum / n) : 0);
    }
    return { rate, rms };
  } finally { closeSync(fd); }
}

// Merges windows that carry sound into ranges; a pause shorter than joinMs does not split one, and a burst shorter than
// minMs (a click, a chair) is not worth a recheck.
export function soundRanges(windows: { ms: number; rms: number }[], windowMs = 1000, threshold = 0.006, joinMs = 2000, minMs = 3000): Range[] {
  const loud = windows.filter(w => w.rms >= threshold).sort((a, b) => a.ms - b.ms); const ranges: Range[] = [];
  for (const w of loud) {
    const last = ranges.at(-1);
    if (last && w.ms - last.to <= joinMs) last.to = Math.max(last.to, w.ms + windowMs); else ranges.push({ from: w.ms, to: w.ms + windowMs });
  }
  return ranges.filter(range => range.to - range.from >= minMs);
}

// What is left of `ranges` once `covers` are taken out; pieces shorter than minMs are dropped.
export function uncovered(ranges: Range[], covers: Range[], minMs = 3000): Range[] {
  const sorted = [...covers].sort((a, b) => a.from - b.from); const out: Range[] = [];
  for (const range of ranges) {
    let from = range.from;
    for (const cover of sorted) {
      if (cover.to <= from) continue; if (cover.from >= range.to) break;
      if (cover.from > from) out.push({ from, to: cover.from });
      from = Math.max(from, cover.to);
    }
    if (from < range.to) out.push({ from, to: range.to });
  }
  return out.filter(piece => piece.to - piece.from >= minMs);
}

// Windows with sound over the whole recording. After the session ended the 16 kHz mix is the better judge (the
// microphone is in it only where it is the user's own voice); while it still records only the speaker segments exist.
export function soundWindows(dir: string, events: TimelineEvent[], useMix: boolean) {
  const segments = segmentsOf(events); const windows: { ms: number; rms: number }[] = []; const mixPath = join(dir, MIX_FILE);
  if (useMix && existsSync(mixPath) && segments.length && statSync(mixPath).size > 44) {
    try {
      const anchor = Math.min(...segments.map(s => s.openMs)); const { rms } = windowRms(mixPath);
      rms.forEach((value, k) => windows.push({ ms: anchor + k * 1000, rms: value }));
      return { basis: 'mix' as const, windows };
    } catch {}
  }
  for (const segment of segments.filter(s => s.channel === 'speaker')) {
    try {
      const { rate, rms } = windowRms(join(dir, segmentFile(segment)));
      rms.forEach((value, k) => windows.push({ ms: wallOfSample(segment, k * rate), rms: value }));
    } catch {}
  }
  return { basis: 'speaker-segments' as const, windows };
}
