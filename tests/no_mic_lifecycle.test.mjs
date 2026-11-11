// No-mic across a host takeover and a recorder retry (04/11, privacy fix of the mic lifecycle). Everything is fake and owned by this
// test: one temp base (root with the fake recorder/worker scripts of fakes.mjs, data, lock), every parent PMA_* removed and restored,
// PMA_WARM=0 so the takeover starts no ASR worker, a MeetingRuntime with no machine lock. The "previous host" is simulated by writing
// its daemon.json and starting the fake recorder ourselves (a node child of this test, killed only through its own handle if it did
// not stop). The runtime's process seams (alive, killPid, startedAt) are injected through its constructor before the takeover runs:
// they answer only for that child, kill only through its handle, and the recorder's OS start time (its identity) is a fake string.
// No OS process query, no system or random pid. No device, no audio, no model, no network, no real host. What is checked is the recorder's launch arguments and what
// status reports about them: a launch argument is not a physical measurement of the microphone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FAKE_RECORDER, FAKE_WORKER, readLog, until, withFakes } from './fakes.mjs';
import { MeetingRuntime } from '../dist/runtime.js';

const micArgs = argv => argv.filter(a => a === '--mic-auto' || a === '--mic-device');
const opens = audio => { try { return readFileSync(join(audio, 'timeline.jsonl'), 'utf8').split('\n').filter(l => l.includes('"open"')).length; } catch { return 0; } };

// A takeover world: the previous host left `registry` in daemon.json and its recorder (started with `mic`) is still running. The
// recorder's start time as the OS would report it is `now`; the previous host wrote `writtenStart` (undefined = an older host).
async function takeover({ mic, registryMic, writtenStart, now = 'start-T1', contextMicOff }, fn) {
  const base = mkdtempSync(join(tmpdir(), 'pma-fakes-takeover-'));
  const root = join(base, 'root'), data = join(base, 'data'), lock = join(base, 'lock');
  for (const d of [join(root, 'tools'), data, lock]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'tools', 'recorder.py'), FAKE_RECORDER); writeFileSync(join(root, 'tools', 'audio_worker.py'), FAKE_WORKER);
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PMA_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, { PMA_PYTHON: process.execPath, PMA_LOCK_DIR: lock, PMA_DATA_DIR: data, PMA_STOP_HOOK: 'off', PMA_WARM: '0' });
  const id = randomUUID(); const audio = join(data, 'audio', id); mkdirSync(audio, { recursive: true });
  const db = new DatabaseSync(join(data, 'history.sqlite3'));
  db.exec('CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, ended TEXT, mode TEXT NOT NULL, context TEXT NOT NULL)');
  db.prepare("INSERT INTO sessions VALUES(?,?,?,NULL,'live',?)").run(id, 'Họp thử tiếp quản', new Date().toISOString(), JSON.stringify(contextMicOff ? { micOff: true } : {}));
  db.close();
  const child = spawn(process.execPath, [join(root, 'tools', 'recorder.py'), '--dir', audio, '--speaker-device', '13', '--speaker-name', 'Loop', ...(mic ? ['--mic-auto'] : [])], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise(r => child.once('exit', r));
  const running = () => child.exitCode === null && child.signalCode === null;
  assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'the test recorder has a pid of its own');
  // The only process the runtime may look at or stop is this child, and only through its handle.
  const hooks = {
    alive: pid => pid === child.pid && running(),
    killPid: pid => { if (pid !== child.pid || !(pid > 0)) throw new Error('KILL_REFUSED: pid ' + pid + ' is not this test\'s recorder'); child.kill(); },
    startedAt: pid => (pid === child.pid ? now : null),
  };
  const errors = []; let r = null;
  try {
    await until(() => opens(audio) === 1, 'the previous host\'s recorder is recording');
    const registry = { sessionId: id, recorderPid: child.pid, workerPid: null, asr: 'paused', speaker: 'Loop', ...(registryMic === undefined ? {} : { recorderMic: registryMic }), ...(writtenStart === undefined ? {} : { recorderStartedAt: writtenStart }) };
    writeFileSync(join(data, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:9', pid: null, token: 'previous-host', version: 'test', ...registry }));
    r = new MeetingRuntime(root, data, false, undefined, hooks); r.mixer = () => {}; r.recorderStopMs = 3000;
    await fn(r, { id, audio, child });
  } finally {
    // Every cleanup failure is kept and reported; the temp folder stays unless the recorder is proven to have exited.
    try { await r?.close(); } catch (error) { errors.push('close: ' + String(error?.message ?? error)); }
    if (running()) { await Promise.race([exited, new Promise(res => setTimeout(res, 3000))]); if (running()) { child.kill(); await Promise.race([exited, new Promise(res => setTimeout(res, 3000))]); } }
    for (const k of Object.keys(process.env)) if (k.startsWith('PMA_')) delete process.env[k];
    Object.assign(process.env, saved);
    if (running()) errors.push('the test recorder pid ' + child.pid + ' is still alive');
    if (errors.length) throw new Error('TAKEOVER_CLEANUP_FAILED: ' + errors.join('; ') + '; ' + base + ' left in place');
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('takeover of a recorder known to run without the mic (same pid, same start time): OFF, the same session and recorder', async () => {
  await takeover({ mic: false, registryMic: false, writtenStart: 'start-T1', contextMicOff: true }, async (r, { id, child }) => {
    assert.equal(r.session.id, id); assert.equal(r.recorder.attached, true); assert.equal(r.recorder.pid, child.pid);
    assert.equal(r.compact().micMode, 'OFF');
    assert.equal(r.registry().recorderMic, false); assert.equal(r.registry().recorderStartedAt, 'start-T1', 'passed on with its identity');
  });
});

// Review of 4c21d07 (finding b): a live PID whose identity is not proven is neither controlled nor replaced (fail closed).
const unverified = (r, child) => {
  assert.equal(r.recorder.state, 'UNVERIFIED'); assert.equal(r.recorder.unverifiedPid, child.pid); assert.equal(r.recorder.attached, false);
  assert.equal(r.compact().micMode, 'UNKNOWN'); assert.equal(r.registry().recorderMic, null); assert.match(r.lastError, /RECORDER_UNVERIFIED/);
};
test('the same pid with another start time (a reused pid or a stale daemon.json): not taken, not signalled, no second recorder', async () => {
  await takeover({ mic: false, registryMic: false, writtenStart: 'start-T0', now: 'start-T1', contextMicOff: true }, async (r, { child }) => {
    unverified(r, child);
    await r.start(r.session.id);  // listening reads the files; it starts no recorder beside the unproven one
    assert.equal(r.recorder.child, null, 'no recorder of its own was started'); assert.equal(r.recorder.state, 'UNVERIFIED'); assert.ok(child.exitCode === null, 'the process was not signalled');
  });
});

test('start time unknown now (the OS answered nothing): not taken either', async () => {
  await takeover({ mic: false, registryMic: false, writtenStart: 'start-T1', now: null, contextMicOff: true }, async (r, { child }) => {
    unverified(r, child);
  });
});

test('takeover of the proven recorder without a recorded mic mode (older host): UNKNOWN, never OFF, and start --no-mic is refused, not reported as applied', async () => {
  await takeover({ mic: false, registryMic: undefined, writtenStart: 'start-T1', contextMicOff: true }, async r => {
    assert.equal(r.recorder.attached, true, 'identity proven: taken over');
    assert.equal(r.compact().micMode, 'UNKNOWN', 'the session wants no mic, but nothing attests what the running recorder does');
    assert.throws(() => r.prepare('Họp', false, undefined, undefined, { mic: false }), /MIC_OFF_NOT_APPLIED/);
  });
});

test('conflict: the session wants no mic but the recorder taken over runs with it: ON, not OFF', async () => {
  await takeover({ mic: true, registryMic: true, writtenStart: 'start-T1', contextMicOff: true }, async r => {
    assert.equal(r.micFor(r.session.id), false, 'the session choice is no mic');
    assert.equal(r.compact().micMode, 'ON', 'status reports the recorder, not the wish');
  });
});

test('a no-mic recorder that crashes is started again without the mic, and the speaker recording goes on in a new segment', async () => {
  await withFakes(async (r, dir) => {
    r.prepare('Họp', false, undefined, undefined, { warm: false, mic: false }); const id = r.session.id;
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }, { index: 12, name: 'Mic', kind: 'microphone' }];
    await r.select(id, 13); await until(() => r.recorder.state === 'RECORDING', 'recorder');
    const audio = `${dir}/audio/${id}`; const spawns = () => readLog(audio, 'recorder-log.jsonl').filter(e => e.what === 'spawn');
    writeFileSync(join(audio, 'crash-recorder'), '');
    await until(() => spawns().length === 2 && r.recorder.state === 'RECORDING', 'restarted after the crash');
    assert.deepEqual(spawns().map(s => micArgs(s.argv)), [[], []], 'neither launch asked for a microphone');
    assert.ok(spawns().every(s => s.argv.includes('--speaker-device')), 'both launches record the speaker output');
    assert.equal(opens(audio), 2, 'the speaker recording continued in a new segment');
    assert.equal(r.compact().micMode, 'OFF'); assert.equal(existsSync(join(audio, 'crash-recorder')), false);
  });
});
