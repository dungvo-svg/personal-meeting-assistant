// Measure the machine's own hearing against the Google Meet captions of a real meeting (OWN-036: captions are a reference to measure
// the ASR with, not a substitute for fixing it). Reads one meeting through the installed `pma read --json` and its screen/meet_text.jsonl,
// pairs every caption line with the transcript line(s) that say the same words, and counts:
//   - language: lines the ASR showed as Lao whose Vietnamese reading is what the caption says (a Vietnamese line picked as Lao), and the
//     other way round;
//   - lost: caption lines (5+ syllables) with no transcript line saying most of them;
//   - words: per pair, the share of caption syllables the shown line has (a rough recall, captions are not ground truth either).
// Pairing is by words in order, not by time: captions read late (a hidden Meet tab, 26/11) carry the time they were read.
// Usage: node tools/eval_vs_captions.mjs <session id> [--data <data dir>] [--json <out.json>]
// Prints numbers and line ids only; the lines themselves go to --json (keep it out of git: meeting content).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const session = args.find(a => /^[0-9a-f-]{36}$/.test(a));
if (!session) { console.error('usage: node tools/eval_vs_captions.mjs <session id> [--data <data dir>] [--json <out.json>]'); process.exit(2); }
const dataDir = flag('--data') ?? process.env.PMA_DATA_DIR ?? join(ROOT, '.local', 'runtime');
const { parseMeetCaptions } = await import(pathToFileURL(join(ROOT, 'dist', 'screen.js')).href);

// Transcript: every line of the meeting, through the CLI (the host opens the history if the meeting is closed).
function readAll() {
  const items = []; let after = 0;
  for (;;) {
    const raw = execFileSync(process.execPath, [join(ROOT, 'dist', 'cli.js'), 'read', '--session', session, '--after', String(after), '--limit', '100', '--json'], { env: { ...process.env, PMA_DATA_DIR: dataDir }, encoding: 'utf8', maxBuffer: 1 << 28 });
    const page = JSON.parse(raw).items ?? [];
    if (!page.length) return items;
    items.push(...page); after = page.at(-1).id;
    if (page.length < 100) return items;
  }
}
const syllables = text => String(text ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const viReading = item => item.language === 'vi' ? item.text : (item.alternatives ?? []).find(a => a?.rv !== undefined && a.language === 'vi')?.text;
const isMic = item => String(item.boundary ?? '').includes('CHANNEL_MIC');
const ghost = item => String(item.boundary ?? '').includes('HALLUCINATION') || item.origin === 'system_gap';
// Share of `of` syllables found in `in` (a multiset: each word of `in` counts once).
function covered(of, inside) {
  const bag = new Map(); for (const w of inside) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0; for (const w of of) { const n = bag.get(w) ?? 0; if (n > 0) { hit++; bag.set(w, n - 1); } }
  return of.length ? hit / of.length : 0;
}

const everything = readAll().filter(item => !isMic(item) && item.origin !== 'system_gap');
const items = everything.filter(item => !ghost(item));
const file = join(dataDir, 'audio', session, 'screen', 'meet_text.jsonl');
if (!existsSync(file)) { console.error('no Meet captions for this meeting: ' + file); process.exit(1); }
const records = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).flatMap(l => { try { return l.trim() ? [JSON.parse(l.replace(/^﻿/, ''))] : []; } catch { return []; } });
const captions = parseMeetCaptions(records).lines.filter(line => !line.self && syllables(line.text).length >= 2);

// Pair: each caption line takes the transcript line(s) whose Vietnamese reading or shown text covers most of it. Captions and ASR cut
// sentences differently, so a caption line may pair with 1–3 consecutive lines. A caption with its own time looks at lines said from
// 25 s before it to 10 s after; captions read late in one batch (the time they share is the reading time) are paired in order instead,
// from where the last pair ended.
const WINDOW = 25; const MIN_TIMED = 0.3; const MIN_ORDER = 0.4;
const batch = new Map(); for (const line of captions) batch.set(line.first, (batch.get(line.first) ?? 0) + 1);
const wall = item => Date.parse(item.wall ?? item.createdAt);
const pairs = []; let cursor = 0;
for (const line of captions) {
  const said = syllables(line.text); let best = null;
  const timed = (batch.get(line.first) ?? 0) <= 5;
  const from = timed ? items.findIndex(item => wall(item) >= line.first - 25000) : Math.max(0, cursor - 3);
  const to = timed ? items.findLastIndex(item => wall(item) <= line.last + 10000) + 1 : Math.min(items.length, cursor + WINDOW);
  const MIN = timed ? MIN_TIMED : MIN_ORDER;
  for (let i = Math.max(0, from); i < to; i++) {
    for (let span = 1; span <= 3 && i + span <= items.length; span++) {
      const group = items.slice(i, i + span);
      const heard = group.flatMap(item => syllables(viReading(item) ?? item.text));
      const score = covered(said, heard) - 0.02 * (span - 1);
      if (!best || score > best.score) best = { score, i, span };
    }
  }
  if (best && best.score >= MIN) { pairs.push({ line, group: items.slice(best.i, best.i + best.span), score: best.score }); cursor = best.i + best.span; }
  else pairs.push({ line, group: [], score: best?.score ?? 0 });
}

const paired = pairs.filter(p => p.group.length);
const lost = pairs.filter(p => !p.group.length && syllables(p.line.text).length >= 5);
// A line shown as Lao, paired with a caption that its Vietnamese reading matches: the Vietnamese reading was right.
const viAsLao = new Map(); for (const p of paired) for (const item of p.group) if (item.language === 'lo' || item.language === 'th') {
  const vi = syllables(viReading(item)); if (vi.length >= 2 && covered(vi, syllables(p.line.text)) >= 0.5) viAsLao.set(item.id, { item, caption: p.line });
}
const shownRecall = paired.map(p => covered(syllables(p.line.text), p.group.flatMap(item => syllables(item.language === 'vi' ? item.text : '')))).filter(Number.isFinite);
const twoReadings = items.filter(item => (item.alternatives ?? []).some(a => a?.rv !== undefined));
const shownLao = items.filter(item => item.language === 'lo' || item.language === 'th');
// Speech the ASR turned into an invented sentence ("Hãy subscribe…"): the line (or its Vietnamese reading) is a ghost while a caption
// of 4+ syllables with its own time was on screen during it. The words are lost unless another reading has them.
const invented = item => ghost(item) || (item.alternatives ?? []).some(a => a?.rv !== undefined && a.language === 'vi' && a.status === 'invented');
const span = item => { const w = wall(item); return [w + Number(item.start ?? 0) * 1000 - 2500, w + Number(item.end ?? 0) * 1000 + 6000]; };
const inventedOnSpeech = everything.filter(item => invented(item) && captions.some(line => (batch.get(line.first) ?? 0) <= 5 && syllables(line.text).length >= 4 && line.first <= span(item)[1] && line.last >= span(item)[0]));
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const report = {
  session, transcriptLines: items.length, withTwoReadings: twoReadings.length, shownAsLaoOrThai: shownLao.length,
  captionLines: captions.length, paired: paired.length, lostCaptionLines: lost.length,
  inventedOnSpeech: inventedOnSpeech.length, inventedOnSpeechIds: inventedOnSpeech.map(item => item.id), inventedOnSpeechSeconds: Number(inventedOnSpeech.reduce((n, item) => n + Number(item.end ?? 0) - Number(item.start ?? 0), 0).toFixed(1)),
  vietnameseShownAsLao: viAsLao.size, vietnameseShownAsLaoIds: [...viAsLao.keys()],
  meanCaptionWordsInShownLine: Number(mean(shownRecall).toFixed(3)),
  captionTimesReadLate: captions.length ? Number((captions.filter(l => l.first === captions.at(-1).first).length / captions.length).toFixed(3)) : 0,
};
console.log(JSON.stringify(report, null, 1));
const out = flag('--json');
if (out) writeFileSync(out, JSON.stringify({ report, viAsLao: [...viAsLao.values()].map(({ item, caption }) => ({ id: item.id, shown: item.text, vi: viReading(item), caption: caption.text, speaker: caption.speaker })),
  lost: lost.map(p => ({ caption: p.line.text, speaker: p.line.speaker, best: Number(p.score.toFixed(2)) })) }, null, 1), 'utf8');
