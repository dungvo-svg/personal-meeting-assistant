// Fake child processes for the 0.11 lifecycle tests: no device is opened, no model is loaded, nothing is recorded. They are small Node
// scripts placed under a temp root as tools/audio_worker.py and tools/recorder.py (PMA_PYTHON points at node), and speak the same JSON
// lines as the real ones (docs/PLAN_0_11.md, Q-1 and Q-2). Behaviour is steered by marker files in the session's audio folder:
//   crash-recorder        recorder exits with code 5 once (the file is removed)
//   crash-worker          worker emits one source and exits with code 3 (removed; with the text "always" it stays, so every run crashes)
//   no-pause-ack          worker does not answer `pause`
//   tail.json             sources the worker still delivers after `stop` (JSON array of texts), 300 ms later
//   recheck-result.json   what `--recheck` prints
// Every spawn is logged to worker-log.jsonl / recorder-log.jsonl next to them (argv, stop, exit), with a timestamp.
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';

export const FAKE_WORKER = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const emit = event => console.log(JSON.stringify(event));
if (args.includes('--list')) { console.log(JSON.stringify([{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio', isDefaultOutput: true }, { index: 12, name: 'Mic', kind: 'microphone' }])); process.exit(0); }
if (flag('--recheck')) {
  const dir = flag('--recheck'); fs.writeFileSync(path.join(dir, 'recheck-args.json'), JSON.stringify(args));
  const control = path.join(dir, 'recheck-result.json');
  console.log(fs.existsSync(control) ? fs.readFileSync(control, 'utf8') : JSON.stringify({ text: 'xin chào đã nghe lại', language: 'lo', alternatives: [{ language: 'th', text: 'สวัสดี', score: -0.4 }], silent: false }));
  process.exit(0);
}
if (flag('--replay')) {  // the old per-listening worker, used for pma replay only
  fs.writeFileSync(path.join(path.dirname(flag('--replay')), 'replay-args.json'), JSON.stringify(args));
  emit({ type: 'ready', device: 'replay' });
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => { if (line === 'stop') process.exit(0); });
} else (() => {
const dir = flag('--follow'); const log = (what, extra) => fs.appendFileSync(path.join(dir, 'worker-log.jsonl'), JSON.stringify({ at: Date.now(), what, ...extra }) + '\\n');
log('spawn', { argv: args });
let paused = false; let n = 0; let started = false;
const speak = text => emit({ type: 'source', text: text ?? 'xin chào ' + (++n), start: 0, end: 3, boundary: 'SILENCE_BOUNDARY_HEURISTIC', language: 'vi', channel: 'speaker', wall: new Date().toISOString(), seg: 1 });
const crashFile = path.join(dir, 'crash-worker');
const run = () => {
  emit({ type: 'ready', device: 'Fake' }); speak();
  if (fs.existsSync(crashFile)) { if (fs.readFileSync(crashFile, 'utf8') !== 'always') fs.unlinkSync(crashFile); console.error('boom'); log('crash'); process.exit(3); }
};
setTimeout(() => { emit({ type: 'warm', asr: { device: 'cuda' }, modelLoadSeconds: 15.3 }); if (!paused && !started) { started = true; run(); } }, 60);
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  if (line === 'pause') { paused = true; log('pause'); if (!fs.existsSync(path.join(dir, 'no-pause-ack'))) emit({ type: 'warm', asr: { device: 'cuda' }, modelLoadSeconds: 15.3, resumed: true }); }
  if (line === 'resume') { paused = false; log('resume'); started = true; run(); }
  if (line === 'stop') {
    log('stop');
    const tail = path.join(dir, 'tail.json'); const texts = fs.existsSync(tail) ? JSON.parse(fs.readFileSync(tail, 'utf8')) : [];
    setTimeout(() => { for (const text of texts) speak(text); log('exit'); process.exit(0); }, 300);
  }
});
})();
`;

export const FAKE_RECORDER = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const dir = flag('--dir'); const timeline = path.join(dir, 'timeline.jsonl');
const write = event => fs.appendFileSync(timeline, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\\n');
const log = (what, extra) => fs.appendFileSync(path.join(dir, 'recorder-log.jsonl'), JSON.stringify({ at: Date.now(), what, ...extra }) + '\\n');
log('spawn', { argv: args, pid: process.pid });
const seg = (fs.existsSync(timeline) ? fs.readFileSync(timeline, 'utf8').split('\\n').filter(l => l.includes('"open"')).length : 0) + 1;
write({ type: 'open', seg, channel: 'speaker', rate: 16000, device: flag('--speaker-name') });
console.log(JSON.stringify({ type: 'recording', speaker: flag('--speaker-name'), micDevice: 'Mic', micSelectedBy: 'windows_default' }));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; write({ type: 'end' }); log('end'); setTimeout(() => process.exit(0), 50); };
process.stdin.on('data', data => { if (String(data).includes('stop')) { log('stop-line'); stop(); } });
setInterval(() => {
  if (!stopping && fs.existsSync(path.join(dir, 'STOP'))) { log('stop-file'); stop(); }
  const crash = path.join(dir, 'crash-recorder'); if (fs.existsSync(crash)) { fs.unlinkSync(crash); log('crash'); process.exit(5); }
}, 40);
`;

export async function until(condition, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) throw new Error('timeout: ' + what); await new Promise(resolve => setTimeout(resolve, 20)); }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const readLog = (dir, name) => { try { return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

// A MeetingRuntime over a temp root that holds the fakes (not a test runtime: warm-up and the remembered source are on).
// Short timings so supervision and drain tests run in well under a second each.
export async function withFakes(fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pma-fake-root-')); const dir = mkdtempSync(join(tmpdir(), 'pma-session-test-'));
  mkdirSync(join(root, 'tools')); writeFileSync(join(root, 'tools', 'audio_worker.py'), FAKE_WORKER); writeFileSync(join(root, 'tools', 'recorder.py'), FAKE_RECORDER);
  for (const [name, value] of Object.entries(options.profile ? { 'profile.json': JSON.stringify(options.profile) } : {})) writeFileSync(join(dir, name), value);
  const before = { PMA_PYTHON: process.env.PMA_PYTHON, PMA_WARM: process.env.PMA_WARM, PMA_MIC: process.env.PMA_MIC };
  process.env.PMA_PYTHON = process.execPath; delete process.env.PMA_WARM; delete process.env.PMA_MIC;
  const r = new MeetingRuntime(root, dir, false);
  r.restartDelayMs = 30; r.mixer = () => {};
  try { await fn(r, dir, root); } finally {
    await r.close(); for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
}
// Opens a session on the fake worker and recorder: prepared, speaker armed (recorder spawned), models "loaded".
export async function openSession(r, dir, title = 'Họp') {
  r.prepare(title); const id = r.session.id;
  await until(() => r.captureState === 'WARM_READY', 'warm');
  r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }, { index: 12, name: 'Mic', kind: 'microphone' }];
  await r.select(id, 13);
  await until(() => r.recorder.state === 'RECORDING', 'recorder');
  return { id, audio: join(dir, 'audio', id) };
}
export { test, existsSync };
