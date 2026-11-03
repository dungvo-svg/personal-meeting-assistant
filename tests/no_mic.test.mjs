// Explicit no-microphone choice reaches the recorder before anything can open a microphone (Codex review of f6d5dc8). Fake recorder
// and worker of fakes.mjs (test-owned node children, no device, no audio, no model): only their logged argv is checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, withFakes, until, readLog } from './fakes.mjs';

const micArgs = argv => argv.filter(a => a === '--mic-auto' || a === '--mic-device');
const recorderSpawns = audio => readLog(audio, 'recorder-log.jsonl').filter(e => e.what === 'spawn');

test('PMA_MIC travels to a launched host: it is in the client list and in the host allow-list', () => {
  assert.match(readFileSync(resolve('src/client.ts'), 'utf8'), /DAEMON_ENV = \[[^\]]*'PMA_MIC'/, 'read as text: no client module is loaded');
  assert.match(readFileSync(resolve('src/daemon.ts'), 'utf8'), /ALLOWED_ENV = \[[^\]]*'PMA_MIC'/);
});

test('prepare(mic:false): the remembered speaker starts the recorder with zero microphone arguments', async () => {
  // The remembered speaker (profile) makes prepare() start the recorder by itself, before any select: the choice must already hold.
  await withFakes(async (r, dir) => {
    r.prepare('Họp', false, undefined, undefined, { mic: false }); const id = r.session.id;
    await until(() => r.recorder.state === 'RECORDING', 'recorder started from the remembered speaker');
    const spawns = recorderSpawns(`${dir}/audio/${id}`); assert.ok(spawns.length >= 1);
    for (const s of spawns) assert.deepEqual(micArgs(s.argv), [], 'no microphone was ever asked for');
  }, { profile: { speaker: { name: 'Loop' } } });
});

test('select --no-mic after the recorder started with the microphone restarts it without, at once', async () => {
  await withFakes(async (r, dir) => {
    r.prepare('Họp', false, undefined, undefined, { warm: false }); const id = r.session.id;
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }, { index: 12, name: 'Mic', kind: 'microphone' }];
    await r.select(id, 13); await until(() => r.recorder.state === 'RECORDING', 'recorder');
    const audio = `${dir}/audio/${id}`; assert.deepEqual(micArgs(recorderSpawns(audio)[0].argv), ['--mic-auto'], 'default unchanged: the mic is recorded (OWN-027)');
    await r.select(id, 13, false); await until(() => recorderSpawns(audio).length === 2 && r.recorder.state === 'RECORDING', 'restarted');
    assert.deepEqual(micArgs(recorderSpawns(audio).at(-1).argv), [], 'the new recorder has no microphone');
  });
});
