// Capture flow: pause that keeps the worker warm, model load time (audit 30/10 A4, A9) and opt-in audio saving (B3).
// The worker here is a tiny Node script that speaks the same JSON lines as tools/audio_worker.py; no device is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { MeetingRuntime } from '../dist/runtime.js';
import { audioInfo, isExpired, keepDaysOf, markAudioDir, purgeAudio } from '../dist/audio.js';

const FAKE_WORKER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const emit = event => console.log(JSON.stringify(event));
const asr = { device: 'cuda' };
let listening = 0;
emit({ type: 'warm', asr, modelLoadSeconds: 15.3 });
rl.on('line', line => {
  if (line === 'stop') process.exit(0);
  if (line === 'pause') {
    emit({ type: 'source', text: 'câu cuối trước khi tạm dừng', start: 5, end: 6, boundary: 'FLUSHED_ON_PAUSE', language: 'vi', channel: 'speaker' });
    return emit({ type: 'warm', asr, modelLoadSeconds: 15.3, resumed: true });
  }
  const request = JSON.parse(line); listening++;
  emit({ type: 'prepared', modelReady: true });
  // An old worker counted the wait for the source as model load; the runtime must keep the number from "warm".
  emit({ type: 'ready', device: 'Fake', micDevice: 'Mic', micSelectedBy: 'windows_default', modelLoadSeconds: 1273, waitedForSourceSeconds: 1273, audioStorage: request.saveAudioDir ? 'WAV_ON_DISK' : 'RAM_ONLY', request });
  emit({ type: 'source', text: 'xin chào lần ' + listening, start: 0, end: 2, boundary: 'SILENCE_BOUNDARY_HEURISTIC', language: 'vi', channel: 'speaker' });
});
`;

async function until(condition, what, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) assert.fail('timeout: ' + what); await new Promise(resolve => setTimeout(resolve, 20)); }
}

async function withFakeWorker(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pma-fake-root-')); const dir = mkdtempSync(join(tmpdir(), 'pma-capture-test-'));
  mkdirSync(join(root, 'tools')); writeFileSync(join(root, 'tools', 'audio_worker.py'), FAKE_WORKER);
  const before = { PMA_PYTHON: process.env.PMA_PYTHON, PMA_WARM: process.env.PMA_WARM }; process.env.PMA_PYTHON = process.execPath; delete process.env.PMA_WARM;
  const r = new MeetingRuntime(root, dir, false);
  try { await fn(r, dir); } finally {
    await r.close(); for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true }); rmSync(dir, { recursive: true });
  }
}

test('pause keeps the worker and its models; the next listen has text at once under a new capture ID', async () => {
  await withFakeWorker(async (r, dir) => {
    let saves = 0; const save = r.saveProfile.bind(r); r.saveProfile = change => { saves++; return save(change); };
    r.prepare('Họp'); const id = r.session.id;
    await until(() => r.captureState === 'WARM_READY', 'warm');
    assert.equal(r.captureInfo.modelLoadSeconds, 15.3); assert.equal(saves, 1);
    const child = r.capture;
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }]; r.arm(id, 13);

    await r.start(id, true, { saveAudio: true, keepDays: 3 });
    await until(() => r.captureState === 'LISTENING' && r.sources(id).length === 1, 'first listening');
    const first = r.captureId;
    // A4: the ready event of the worker may carry the wait for the source; the load time stays the one from "warm".
    assert.equal(r.captureInfo.modelLoadSeconds, 15.3); assert.equal(r.captureInfo.waitedForSourceSeconds, 1273);
    assert.equal(r.captureInfo.request.captureId, first); assert.equal(r.captureInfo.request.micAuto, true);
    assert.equal(r.captureInfo.request.saveAudioDir, join(dir, 'audio', id));
    assert.equal(r.compact().audio.keepDays, 3);

    await r.pause();
    assert.equal(r.captureState, 'WARM_READY'); assert.equal(r.capture, child); assert.equal(child.exitCode, null);
    assert.equal(saves, 1, 'a resumed warm is not a model load');
    assert.equal(r.sources(id).length, 2); assert.equal(r.sources(id)[1].text, 'câu cuối trước khi tạm dừng');

    await r.start(id, true);
    await until(() => r.captureState === 'LISTENING' && r.sources(id).length === 3, 'second listening');
    const [a, b, c] = r.sources(id); assert.equal(a.captureId, first); assert.equal(b.captureId, first);
    assert.notEqual(c.captureId, first); assert.equal(c.captureId, r.captureId);
    assert.equal(r.captureInfo.request.captureId, undefined, 'no audio saving this time: no capture ID needed by the worker');

    await r.finish(id);
    assert.equal(r.capture, null); assert.equal(r.captureState, 'OFF');
  });
});

test('pause falls back to a stop when the worker cannot pause or does not answer', async () => {
  await withFakeWorker(async r => {
    const fakeChild = (answers) => { const written = []; const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.kill = () => {};
      child.stdin = { write: line => { written.push(line); if (line === 'stop\n') setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 10); if (line === 'pause\n' && answers) setTimeout(() => { r.captureState = 'WARM_READY'; r.ping(); }, 10); } };
      r.capture = child; r.captureState = 'LISTENING'; return written; };
    r.testMode = true; r.prepare('Họp');
    let written = fakeChild(true); r.resumable = true; await r.pause(); assert.deepEqual(written, ['pause\n']); assert.equal(r.captureState, 'WARM_READY'); assert.ok(r.capture);
    r.capture = null;
    written = fakeChild(false); r.resumable = true; await r.pause(50); assert.deepEqual(written, ['pause\n', 'stop\n']); assert.equal(r.capture, null);
    written = fakeChild(true); r.resumable = false; await r.pause(); assert.deepEqual(written, ['stop\n'], 'a cold worker cannot pause');
    assert.equal(r.capture, null); assert.equal(r.captureState, 'OFF');
  });
});

test('saved audio: expiry never shortens, only expired session folders go, a session being recorded stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-test-')); const day = 86400000;
  try {
    assert.equal(keepDaysOf(undefined), 7); assert.equal(keepDaysOf(0), 1); assert.equal(keepDaysOf(500), 90); assert.equal(keepDaysOf(3.7), 3);
    const make = (id, savedDaysAgo, keepDays) => {
      const now = Date.now() - savedDaysAgo * day; const marked = markAudioDir(dir, id, keepDays, now);
      writeFileSync(join(marked.dir, 'cap-speaker.wav'), Buffer.alloc(1000));
      const when = new Date(now); utimesSync(join(marked.dir, 'cap-speaker.wav'), when, when); return marked;
    };
    const old = '11111111-1111-4111-8111-111111111111', fresh = '22222222-2222-4222-8222-222222222222', live = '33333333-3333-4333-8333-333333333333', extended = '44444444-4444-4444-8444-444444444444';
    make(old, 10, 7); make(fresh, 2, 7); make(live, 30, 7);
    make(extended, 10, 7); markAudioDir(dir, extended, 30, Date.now());  // a later, longer listening keeps the folder longer
    mkdirSync(join(dir, 'audio', 'not-a-session')); writeFileSync(join(dir, 'audio', 'not-a-session', 'x.wav'), 'x');
    const info = audioInfo(dir, fresh); assert.equal(info.files, 1); assert.equal(info.bytes, 1000);
    assert.ok(Math.abs(Date.parse(info.expiresAt) - (Date.now() + 5 * day)) < 60000);
    assert.equal(audioInfo(dir, 'missing'), null);

    const first = purgeAudio(dir, { keep: [live] });
    assert.deepEqual(first.removed.map(item => item.sessionId), [old]); assert.equal(first.freedBytes, 1000); assert.equal(first.kept, 3);
    assert.ok(!existsSync(join(dir, 'audio', old))); assert.ok(existsSync(join(dir, 'audio', 'not-a-session')));
    const older = purgeAudio(dir, { olderThanDays: 5, keep: [live] });  // by age, whatever the expiry says
    assert.deepEqual(older.removed.map(item => item.sessionId), [extended]);
    const all = purgeAudio(dir, { olderThanDays: 0, keep: [live] });
    assert.deepEqual(all.removed.map(item => item.sessionId), [fresh]); assert.ok(existsSync(join(dir, 'audio', live)));
    assert.equal(purgeAudio(join(dir, 'nowhere')).removed.length, 0);
    assert.ok(isExpired(null, Date.now() - 8 * day, Date.now()) && !isExpired(null, Date.now() - 6 * day, Date.now()));
  } finally { rmSync(dir, { recursive: true }); }
});

test('RAW and status say where saved audio is and when it is deleted; without the flag it stays RAM only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-raw-')); const r = new MeetingRuntime(resolve('.'), dir, true);
  try {
    r.prepare('Họp'); const id = r.session.id;
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), /Không có audio lưu lại/); assert.equal(r.compact().audio, null); assert.equal(r.snapshot().audioStorage, 'RAM_ONLY_NO_AUDIO_FILES');
    const marked = markAudioDir(dir, id, 7); writeFileSync(join(marked.dir, 'cap-mic.wav'), Buffer.alloc(2048));
    const raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.ok(raw.includes(`Âm thanh đã lưu trên máy tại ${marked.dir} (1 file`)); assert.match(raw, /tự xoá sau \d/);
    assert.equal(r.compact().audio.dir, marked.dir); assert.equal(r.audioList()[0].title, 'Họp');
    assert.equal(r.purgeAudio().removed.length, 0); assert.equal(r.purgeAudio(0).removed.length, 1);
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), /Không có audio lưu lại/);
  } finally { await r.close(); rmSync(dir, { recursive: true }); }
});

test('daemon deletes expired audio when it starts; `pma audio` lists and purges', async () => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-cli-')); const day = 86400000;
  const env = { ...process.env, PMA_PORT: '8814', PMA_TEST_MODE: '1', PMA_DATA_DIR: dir, PMA_STOP_HOOK: 'off' };
  const pma = async (...args) => JSON.parse((await run(process.execPath, [resolve('dist/cli.js'), ...args], { env })).stdout);
  const wavIn = (id, now) => { const marked = markAudioDir(dir, id, 7, now); const file = join(marked.dir, 'cap-speaker.wav'); writeFileSync(file, Buffer.alloc(3 * 1048576)); utimesSync(file, new Date(now), new Date(now)); };
  const expired = '55555555-5555-4555-8555-555555555555', current = '66666666-6666-4666-8666-666666666666';
  wavIn(expired, Date.now() - 9 * day); wavIn(current, Date.now() - day);
  try {
    await pma('status');  // starts the daemon, which purges expired folders first
    assert.ok(!existsSync(join(dir, 'audio', expired))); assert.ok(existsSync(join(dir, 'audio', current)));
    const listed = await pma('audio'); assert.equal(listed.length, 1); assert.equal(listed[0].session, current); assert.equal(listed[0].mb, 3);
    assert.deepEqual(await pma('audio', 'purge'), { removed: 0, kept: 1, freedMb: 0 });
    assert.deepEqual(await pma('audio', 'purge', '--older-than', '0'), { removed: 1, kept: 0, freedMb: 3 });
    await assert.rejects(pma('listen', '--keep-days', '0'), /./);
  } finally { await pma('shutdown').catch(() => {}); await new Promise(resolve => setTimeout(resolve, 600)); rmSync(dir, { recursive: true, force: true }); }
});
