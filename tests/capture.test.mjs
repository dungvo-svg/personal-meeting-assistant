// Saved audio (0.11: the black box of the whole meeting): it does not expire, only `pma audio purge` deletes it, and RAW and status say
// where it is and which file is the mix. The lifecycle around it (recorder, ASR worker, stop) is in session.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { audioInfo, isExpired, listAudio, markAudioDir, purgeAudio } from '../dist/audio.js';

test('saved audio does not expire: expires.json says null, and nothing but an explicit purge removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-test-')); const day = 86400000;
  try {
    const make = (id, savedDaysAgo, legacyExpiry) => {
      const now = Date.now() - savedDaysAgo * day; const marked = markAudioDir(dir, id, now);
      if (legacyExpiry) writeFileSync(join(marked.dir, 'expires.json'), JSON.stringify({ keepDays: 7, savedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * day).toISOString() }));
      writeFileSync(join(marked.dir, 'seg-0001-speaker.wav'), Buffer.alloc(1000));
      const when = new Date(now); utimesSync(join(marked.dir, 'seg-0001-speaker.wav'), when, when); return marked;
    };
    const ancient = '11111111-1111-4111-8111-111111111111', fresh = '22222222-2222-4222-8222-222222222222', live = '33333333-3333-4333-8333-333333333333', legacy = '44444444-4444-4444-8444-444444444444';
    const marked = make(ancient, 400, false); make(fresh, 2, false); make(live, 30, false); make(legacy, 10, true);
    assert.deepEqual(JSON.parse(readFileSync(join(marked.dir, 'expires.json'), 'utf8')).expiresAt, null, 'the stored format is kept, with no expiry');
    assert.equal(audioInfo(dir, ancient).expiresAt, null);
    mkdirSync(join(dir, 'audio', 'not-a-session')); writeFileSync(join(dir, 'audio', 'not-a-session', 'x.wav'), 'x');
    const info = audioInfo(dir, fresh); assert.equal(info.files, 1); assert.equal(info.bytes, 1000); assert.equal(audioInfo(dir, 'missing'), null);

    // Without arguments only a folder from 0.10 whose own (legacy) date has passed goes; a 400-day-old folder with no expiry stays.
    const first = purgeAudio(dir, { keep: [live] });
    assert.deepEqual(first.removed.map(item => item.sessionId), [legacy]); assert.equal(first.kept, 3);
    assert.ok(existsSync(join(dir, 'audio', ancient)) && existsSync(join(dir, 'audio', 'not-a-session')));
    const older = purgeAudio(dir, { olderThanDays: 5, keep: [live] });  // the user's explicit request, by age
    assert.deepEqual(older.removed.map(item => item.sessionId), [ancient]);
    const all = purgeAudio(dir, { olderThanDays: 0, keep: [live] });
    assert.deepEqual(all.removed.map(item => item.sessionId), [fresh]); assert.ok(existsSync(join(dir, 'audio', live)), 'the session being recorded stays');
    assert.equal(purgeAudio(join(dir, 'nowhere')).removed.length, 0);
    assert.ok(!isExpired(null, Date.now() - 800 * day, Date.now()), 'no record, no expiry');
    assert.ok(isExpired(null, Date.now() - 8 * day, Date.now(), 7));
  } finally { rmSync(dir, { recursive: true }); }
});

test('RAW and status say where saved audio is, that it stays until the user deletes it, and which file to replay; with nothing saved they say so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-raw-')); const r = new MeetingRuntime(resolve('.'), dir, true);
  try {
    r.prepare('Họp'); const id = r.session.id;
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), /Không có audio lưu lại/); assert.equal(r.compact().audio, null); assert.equal(r.snapshot().audioStorage, 'NO_AUDIO_FILES');
    const marked = markAudioDir(dir, id); writeFileSync(join(marked.dir, 'seg-0001-mic.wav'), Buffer.alloc(2048));
    let raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.ok(raw.includes(`Âm thanh đã lưu trên máy tại ${marked.dir} (1 file`)); assert.match(raw, /giữ cho tới khi bạn tự xoá/); assert.doesNotMatch(raw, /tự xoá sau/);
    assert.equal(r.snapshot().audioStorage, 'WAV_SAVED_LOCALLY_UNTIL_USER_DELETES');
    // The mix is written before RAW at stop, but a mix that is not there yet is named as pending.
    assert.ok(raw.includes(`dùng với pma replay: ${join(marked.dir, 'meeting-mix.wav')} (đang ghép, chưa xong)`));
    writeFileSync(join(marked.dir, 'meeting-mix.wav'), Buffer.alloc(512)); writeFileSync(join(marked.dir, 'meeting-mix.part'), Buffer.alloc(512));
    raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.ok(raw.includes(`dùng với pma replay: ${join(marked.dir, 'meeting-mix.wav')}.`)); assert.ok(!raw.includes('đang ghép'));
    assert.equal(r.compact().audio.dir, marked.dir); assert.equal(r.audioList()[0].title, 'Họp'); assert.equal(r.audioList()[0].expiresAt, null);
    assert.deepEqual(r.audioList()[0].mix, [join(marked.dir, 'meeting-mix.wav')]); assert.deepEqual(r.audioList()[0].mixing, []);
    assert.equal(r.purgeAudio().removed.length, 0, 'no expiry: nothing to purge without being told how old'); assert.equal(r.purgeAudio(0).removed.length, 0, 'the open session is never purged');
    await r.finish(id); assert.equal(r.purgeAudio(0).removed.length, 1);
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), /Không có audio lưu lại/);
  } finally { await r.close(); rmSync(dir, { recursive: true }); }
});

test('audio list: finished mix files, and the mix the segments are still waiting for (0.10 per-listening mixes still count)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-mix-')); const id = '77777777-7777-4777-8777-777777777777';
  try {
    const { dir: folder } = markAudioDir(dir, id); const put = name => writeFileSync(join(folder, name), Buffer.alloc(100));
    put('a-speaker.wav'); put('a-mic.wav'); put('a-mix.wav'); put('b-speaker.wav'); put('c-mic.wav'); put('c-mix.part'); put('d-speaker.wav'); put('d-mix.wav');
    let [item] = listAudio(dir);
    assert.deepEqual(item.mix.map(path => path.slice(folder.length + 1)), ['a-mix.wav', 'd-mix.wav']);
    assert.deepEqual(item.mixing.map(path => path.slice(folder.length + 1)), ['b-mix.wav', 'c-mix.wav'], 'a half-written .part is not a finished mix');
    rmSync(folder, { recursive: true }); markAudioDir(dir, id); put('seg-0001-speaker.wav'); put('seg-0001-mic.wav'); put('seg-0002-speaker.wav');
    [item] = listAudio(dir); assert.deepEqual(item.mix, []); assert.deepEqual(item.mixing.map(path => path.slice(folder.length + 1)), ['meeting-mix.wav'], 'one mix for the whole session');
    put('meeting-mix.wav'); [item] = listAudio(dir); assert.deepEqual(item.mix.map(path => path.slice(folder.length + 1)), ['meeting-mix.wav']); assert.deepEqual(item.mixing, []); assert.equal(item.files, 4);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the daemon never deletes audio by itself; `pma audio` lists and purges on request only', async () => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), 'pma-audio-cli-')); const day = 86400000;
  const env = { ...process.env, PMA_PORT: process.env.PMA_CAPTURE_TEST_PORT || '8814', PMA_TEST_MODE: '1', PMA_DATA_DIR: dir, PMA_STOP_HOOK: 'off' };
  const pma = async (...args) => JSON.parse((await run(process.execPath, [resolve('dist/cli.js'), ...args], { env })).stdout);
  const wavIn = (id, now) => { const marked = markAudioDir(dir, id, now); const file = join(marked.dir, 'seg-0001-speaker.wav'); writeFileSync(file, Buffer.alloc(3 * 1048576)); utimesSync(file, new Date(now), new Date(now)); };
  const ancient = '55555555-5555-4555-8555-555555555555', current = '66666666-6666-4666-8666-666666666666';
  wavIn(ancient, Date.now() - 400 * day); wavIn(current, Date.now() - day);
  try {
    await pma('status');  // starts the daemon; the old purge-at-start is gone
    assert.ok(existsSync(join(dir, 'audio', ancient)) && existsSync(join(dir, 'audio', current)));
    const listed = await pma('audio'); assert.equal(listed.length, 2); assert.equal(listed.find(item => item.session === current).mb, 3);
    assert.equal(listed[0].expiresAt, 'không hết hạn'); assert.deepEqual(listed.find(item => item.session === current).mix, ['đang ghép'], 'only segments so far');
    writeFileSync(join(dir, 'audio', current, 'meeting-mix.wav'), Buffer.alloc(1048576));
    assert.deepEqual(listed.length && (await pma('audio')).find(item => item.session === current).mix, [join(dir, 'audio', current, 'meeting-mix.wav')]);
    assert.deepEqual(await pma('audio', 'purge'), { removed: 0, kept: 2, freedMb: 0 });
    assert.deepEqual(await pma('audio', 'purge', '--older-than', '30'), { removed: 1, kept: 1, freedMb: 3 });
    assert.deepEqual(await pma('audio', 'purge', '--older-than', '0'), { removed: 1, kept: 0, freedMb: 4 });
  } finally { await pma('shutdown').catch(() => {}); await new Promise(resolve => setTimeout(resolve, 600)); rmSync(dir, { recursive: true, force: true }); }
});
