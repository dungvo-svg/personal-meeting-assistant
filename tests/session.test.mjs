// The 0.11 lifecycle "sống theo phiên họp": recorder and ASR worker supervised by the host, stop = drain then mix then exit, a new host
// taking a session over, recheck and coverage. Child processes are the fakes of fakes.mjs; nothing is recorded and no model is loaded.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MeetingRuntime } from '../dist/runtime.js';
import { markAudioDir } from '../dist/audio.js';
import { test, withFakes, openSession, until, sleep, readLog } from './fakes.mjs';

const spawns = (audio, file) => readLog(audio, file).filter(entry => entry.what === 'spawn');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('no 7200 s cap anywhere, and the source grant is for the whole session', async () => {
  for (const file of ['src/runtime.ts', 'src/daemon.ts', 'src/cli.ts']) assert.doesNotMatch(readFileSync(file, 'utf8'), /7200/, file);
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    assert.equal(r.armedDevice.expiresAt, null); r.armedDevice.expiresAt = new Date(0).toISOString();  // an old record of a grant is ignored
    await r.start(id); await until(() => r.captureState === 'LISTENING', 'listening');
    for (const argv of [spawns(audio, 'worker-log.jsonl')[0].argv, spawns(audio, 'recorder-log.jsonl')[0].argv]) assert.ok(!argv.includes('--max-seconds'));
    assert.equal(r.captureDeadline, undefined, 'no timer ends the listening');
  });
});

test('select starts the recorder in the session folder and remembers the speaker; listen resumes the warm worker, which reads from the first second', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    const [recorder] = spawns(audio, 'recorder-log.jsonl'); const argv = recorder.argv;
    assert.equal(after(argv, '--dir'), audio); assert.equal(after(argv, '--speaker-device'), '13'); assert.equal(after(argv, '--speaker-name'), 'Loop');
    assert.ok(argv.includes('--mic-auto')); assert.ok(!argv.includes('--parent'), 'the recorder must not depend on the host');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).speaker, { name: 'Loop' });
    assert.equal(r.compact().recorder.micDevice, 'Mic'); assert.equal(r.compact().captureInfo.micDevice, 'Mic', 'status reads as before for `pma follow`');
    assert.equal(r.registry().recorderPid, recorder.pid); assert.equal(r.registry().sessionId, id);
    // ASR: spawned at prepare, loaded, and kept paused: no text before `listen`
    const worker = spawns(audio, 'worker-log.jsonl'); assert.equal(worker.length, 1); assert.equal(after(worker[0].argv, '--follow'), audio); assert.ok(!worker[0].argv.includes('--from-wall'));
    assert.equal(r.captureState, 'WARM_READY'); assert.equal(r.sources(id).length, 0); assert.equal(r.registry().asr, 'paused');

    await r.start(id); await until(() => r.sources(id).length === 1, 'first text');
    assert.equal(spawns(audio, 'worker-log.jsonl').length, 1, 'the same worker is resumed, not started again');
    assert.equal(r.captureState, 'LISTENING'); assert.equal(r.registry().asr, 'listening');
    const [row] = r.sources(id); assert.equal(row.seg, 1); assert.ok(Math.abs(Date.parse(row.wall) - Date.now()) < 5000, 'real time of the audio is kept');
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), new RegExp(`\\[${new Date(row.wall).toLocaleTimeString('vi-VN', { hour12: false })}\\] #${row.id}`));
  });
});

test('select without the microphone, and a microphone chosen later, restart the recorder into the same folder with new segments', async () => {
  await withFakes(async (r, dir) => {
    r.prepare('Họp'); const id = r.session.id; const audio = join(dir, 'audio', id);
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }, { index: 12, name: 'Mic', kind: 'microphone' }];
    await r.select(id, 13, false); await until(() => r.recorder.state === 'RECORDING', 'recorder');
    assert.ok(!spawns(audio, 'recorder-log.jsonl')[0].argv.includes('--mic-auto'));
    await r.selectMic(id, 12); await until(() => spawns(audio, 'recorder-log.jsonl').length === 2 && r.recorder.state === 'RECORDING', 'restart');
    const second = spawns(audio, 'recorder-log.jsonl')[1].argv; assert.equal(after(second, '--mic-device'), '12'); assert.equal(after(second, '--mic-name'), 'Mic');
    assert.deepEqual(readFileSync(join(audio, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).type), ['open', 'end', 'open'], 'a stop of the old recorder, then new segments');
    assert.ok(!existsSync(join(audio, 'STOP')), 'the STOP file does not outlive the restart');
    await assert.rejects(r.selectMic(id, 13), /NOT_A_MICROPHONE/);
  });
});

test('start finds the speaker and microphone remembered in profile.json and records at once; a missing device records nothing', async () => {
  await withFakes(async (r, dir) => {
    r.prepare('Họp'); const id = r.session.id; const audio = join(dir, 'audio', id);
    await until(() => r.recorder.state === 'RECORDING', 'recorder started by itself');
    const argv = spawns(audio, 'recorder-log.jsonl')[0].argv; assert.equal(after(argv, '--speaker-device'), '13'); assert.equal(after(argv, '--mic-device'), '12'); assert.equal(after(argv, '--mic-name'), 'Mic');
    assert.equal(r.armedDevice.name, 'Loop'); assert.equal(r.armedDevice.expiresAt, null);
    await r.start(id); await until(() => r.captureState === 'LISTENING', 'listening');  // no select needed
  }, { profile: { speaker: { name: 'Loop' }, mic: { name: 'Mic' } } });
  await withFakes(async (r, dir) => {
    r.prepare('Họp'); await sleep(700); assert.equal(r.recorder.state, 'OFF'); assert.equal(r.armedDevice, null);
    await assert.rejects(r.start(r.session.id), /SELECT_SOURCE_FIRST/);
  }, { profile: { speaker: { name: 'Loa đã rút' } } });
});

test('pause stops the ASR only: the recorder keeps recording, a temporary mix is made, listen catches up; no answer from the worker is not an error', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    await r.start(id); await until(() => r.sources(id).length === 1, 'first text');
    const child = r.capture; const recorderPid = r.recorder.pid; const mixes = []; r.mixer = (python, args) => { mixes.push(args); };
    await r.pause();
    assert.equal(r.captureState, 'WARM_READY'); assert.equal(r.capture, child); assert.equal(child.exitCode, null); assert.equal(r.recorder.state, 'RECORDING'); assert.equal(r.recorder.pid, recorderPid); assert.ok(alive(recorderPid));
    assert.deepEqual(mixes, [[join(r.root, 'tools', 'mix_audio.py'), audio]], 'a temporary meeting-mix.wav while ASR rests'); assert.equal(r.registry().asr, 'paused');
    await r.start(id); await until(() => r.sources(id).length === 2 && r.captureState === 'LISTENING', 'text after resume'); assert.equal(spawns(audio, 'worker-log.jsonl').length, 1);
    r.mixer = () => { throw new Error('spawn EPERM'); };  // a failing mix spawner never breaks a pause
    writeFileSync(join(audio, 'no-pause-ack'), '');
    await r.pause(80); assert.equal(r.captureState, 'WARM_READY'); assert.equal(r.lastError, null); assert.ok(r.capture);
  });
});

test('the ASR worker dies: it is started again from where it got to, the skipped audio becomes a "[KHOẢNG TRỐNG ASR]" row, and it is not stopped for good', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'crash-worker'), '');
    await r.start(id);
    await until(() => spawns(audio, 'worker-log.jsonl').length === 2, 'second worker');
    const rows = r.sources(id); const first = rows.find(row => row.origin === 'local_asr_unverified'); const gap = rows.find(row => row.origin === 'system_gap');
    const position = Date.parse(first.wall) + 3000;
    assert.match(gap.text, /^\[KHOẢNG TRỐNG ASR\]/); assert.equal(gap.boundary, 'ASR_RESTARTED'); assert.equal(Date.parse(gap.wall), position); assert.match(gap.text, /pma recheck --from/);
    const restart = spawns(audio, 'worker-log.jsonl')[1].argv;
    assert.equal(after(restart, '--follow'), audio); assert.equal(Date.parse(after(restart, '--from-wall')), position + 10000, 'continues after the skipped stretch, never from 0');
    await until(() => r.captureState === 'LISTENING' && r.sources(id).length >= 3, 'the new worker listens'); assert.equal(r.compact().asr.restarts, 1); assert.equal(r.recorder.state, 'RECORDING');
    assert.equal(r.lastError, null, 'cleared once listening again');
  });
});

test('the ASR worker keeps dying: 3 restarts in 10 minutes, then ERROR with a clear text; the recording goes on and listen tries again', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'crash-worker'), 'always');
    await r.start(id);
    await until(() => r.captureState === 'ERROR', 'give up');
    assert.equal(spawns(audio, 'worker-log.jsonl').length, 4, 'the first worker and 3 restarts'); assert.equal(r.capture, null);
    assert.match(r.lastError, /chết 4 lần trong 10 phút/); assert.match(r.lastError, /pma coverage/); assert.match(r.lastError, /boom/);
    assert.equal(r.sources(id).filter(row => row.origin === 'system_gap').length, 3); assert.equal(r.recorder.state, 'RECORDING'); assert.equal(r.registry().asr, 'paused');
    rmSync(join(audio, 'crash-worker')); await r.start(id); await until(() => r.captureState === 'LISTENING', 'listening again'); assert.ok(r.capture);
  });
});

test('the recorder dies: it is started again into the same folder (new segment); the session stays open', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir); const firstPid = r.recorder.pid;
    writeFileSync(join(audio, 'crash-recorder'), '');
    await until(() => spawns(audio, 'recorder-log.jsonl').length === 2 && r.recorder.state === 'RECORDING', 'restarted');
    assert.equal(after(spawns(audio, 'recorder-log.jsonl')[1].argv, '--dir'), audio); assert.notEqual(r.recorder.pid, firstPid); assert.equal(r.recorder.restarts.length, 1); assert.equal(r.session.ended, null);
    assert.deepEqual(readFileSync(join(audio, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'open').map(event => event.seg), [1, 2]);
    await r.finish(id); assert.equal(r.recorder.state, 'OFF'); assert.equal(r.recorder.pid, null);
  });
});

test('a new host takes over a session whose recorder is still alive (nothing marked ended), continues the ASR from the stored position, and stops that recorder; a dead recorder means the session ended', async () => {
  await withFakes(async (r, dir, root) => {
    process.env.PMA_WARM = '0';
    r.prepare('Họp dài'); const id = r.session.id; const audio = join(dir, 'audio', id);
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }]; await r.select(id, 13); await until(() => r.recorder.state === 'RECORDING', 'recorder');
    const wall = new Date(Date.now() - 60000).toISOString(); r.ingest('đã nghe trước khi host chết', 'local_asr_unverified', 0, 4, '', 'cap', 'vi', wall, 1);
    const recorderPid = r.recorder.pid;
    // The host dies: no handler runs, the database is simply abandoned; the recorder is a separate process and goes on.
    r.closing = true; r.db.close();
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 999999, token: 'x', version: 't', startedAt: new Date().toISOString(), sessionId: id, recorderPid, workerPid: null, asr: 'listening', speaker: 'Loop' }));
    delete process.env.PMA_WARM;
    const next = new MeetingRuntime(root, dir, false); next.restartDelayMs = 30; next.mixer = () => {};
    try {
      assert.equal(next.session.id, id); assert.equal(next.session.ended, null); assert.equal(next.history(id).session.ended, null); assert.deepEqual(next.session.languages, ['vi', 'lo', 'th']);
      assert.equal(next.recorder.attached, true); assert.equal(next.recorder.pid, recorderPid); assert.equal(next.recorder.state, 'RECORDING'); assert.equal(next.registry().recorderPid, recorderPid);
      await until(() => spawns(audio, 'worker-log.jsonl').length === 1, 'worker started by the new host');
      const argv = spawns(audio, 'worker-log.jsonl')[0].argv; assert.equal(after(argv, '--follow'), audio); assert.equal(Date.parse(after(argv, '--from-wall')), Date.parse(wall) + 4000);
      await until(() => next.captureState === 'LISTENING', 'ASR was on, so it is on again');
      const done = await next.finish(id);
      assert.ok(!alive(recorderPid), 'the recorder of the dead host was stopped through its STOP file'); assert.ok(next.session.ended); assert.ok(done.raw.path);
      assert.equal(readLog(audio, 'recorder-log.jsonl').filter(entry => entry.what === 'stop-file').length, 1);
    } finally { await next.close(); }

    // Same folder, but the recorder is gone: this is the old rule, the session ended at its last text.
    const other = new MeetingRuntime(root, dir, true); other.prepare('Họp khác'); const otherId = other.session.id; other.ingest('đoạn cuối', 'operator_text'); other.closing = true; other.db.close();
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: 999999, sessionId: otherId, recorderPid, asr: 'paused' }));
    const again = new MeetingRuntime(root, dir, true);
    try { assert.equal(again.session, null); assert.ok(again.history(otherId).session.ended); } finally { await again.close(); }
  });
});

test('a host that takes over a live meeting resumes each follow role at its stored cursor; no heartbeat or lease survives, so the still-running follow takes its role back at once', async () => {
  await withFakes(async (r, dir, root) => {
    process.env.PMA_WARM = '0';
    r.prepare('Họp dài'); const id = r.session.id;
    r.devices = [{ index: 13, name: 'Loop', kind: 'speaker_loopback_all_device_audio' }]; await r.select(id, 13); await until(() => r.recorder.state === 'RECORDING', 'recorder');
    const [a, b, c] = ['một', 'hai', 'ba'].map(text => r.ingest(text, 'operator_text'));
    await r.next(id, b, 0, 12, true, 'chinh', { lease: 'chinhaaaa' });
    await r.next(id, c, 0, 12, true, 'dich', { ack: a, lease: 'dichbbbbb' });
    await r.next(id, c, 0, 12, true, 'dich', { lease: 'dichbbbbb' }); assert.deepEqual(r.release(id, 'dich', 'dichbbbbb', c), { released: true });
    const recorderPid = r.recorder.pid;
    r.closing = true; r.db.close();
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: 999999, sessionId: id, recorderPid, workerPid: null, asr: 'paused', speaker: 'Loop' }));
    const next = new MeetingRuntime(root, dir, false); next.mixer = () => {};
    try {
      assert.equal(next.session.id, id);
      assert.deepEqual(next.followers, { chinh: { cursor: b, at: null }, dich: { cursor: c, at: null } });
      assert.equal(next.agentCursor, b); assert.equal(next.lastFollowAt, null, 'no reader is presumed alive');
      const roles = next.compact().followers; assert.equal(roles.chinh.cursor, b); assert.equal(roles.chinh.unread, 1); assert.equal(roles.dich.unread, 0);
      // The follow process of the dead host is still running with its own lease: nothing holds the role here, so it is not FOLLOWER_BUSY.
      await next.next(id, c, 0, 12, true, 'chinh', { lease: 'chinhaaaa' }); assert.equal(next.followers.chinh.cursor, c);
      await next.finish(id);
    } finally { delete process.env.PMA_WARM; await next.close(); }
    // A new meeting starts with no roles, whatever the last one stored.
    const fresh = new MeetingRuntime(root, dir, true);
    try { fresh.prepare('Họp sau', true); assert.deepEqual(fresh.followers, {}); assert.equal(fresh.agentCursor, 0); assert.deepEqual(fresh.compact().followers, {}); } finally { await fresh.close(); }
  });
});

test('status says the ASR worker is stalled when a listening worker has sent nothing for 90 s; a quiet paused worker is not stalled', async () => {
  await withFakes(async r => {
    r.prepare('Họp', false, undefined, undefined, { warm: false }); r.captureState = 'LISTENING';
    r.lastWorkerEventAt = Date.now() - 5000; assert.equal(r.compact().captureInfo.asrStalledSeconds, undefined);
    r.lastWorkerEventAt = Date.now() - 120000; assert.ok(r.compact().captureInfo.asrStalledSeconds >= 120);
    r.captureState = 'WARM_READY'; assert.equal(r.compact().captureInfo.asrStalledSeconds, undefined);
  });
});

test('committed: a role is done with a row only when its work is saved, over a gap-free run; printing is not enough and a failed save advances nothing', async () => {
  await withFakes(async r => {
    r.prepare('Họp', false, undefined, undefined, { warm: false }); const id = r.session.id; const live = 'SOURCE_LIVE_FOLLOW';
    const [a, b, c, d, e] = [['xin chào', 'vi', live], ['ສະບາຍດີ', 'lo', live], ['ສ່ວນຕົວ', 'lo', live + '; CHANNEL_MIC'], ['สวัสดี', 'th', live], ['cảm ơn', 'vi', live]]
      .map(([text, language, boundary]) => r.ingest(text, 'local_asr_unverified', 0, 3, boundary, 'cap', language));
    await r.next(id, e, 0, 12, true, 'dich', { lease: 'dichcommit1' });   // everything printed (ack e)
    assert.equal(r.committedOf(id, 'dich'), a, 'the Lao row b is printed but not translated');
    assert.throws(() => r.translate(id, [{ sourceId: e, text: 'thanks' }]));   // a Vietnamese row cannot be "translated": nothing saved
    assert.equal(r.committedOf(id, 'dich'), a);
    r.translate(id, [{ sourceId: b, text: 'xin chào (Lào)' }]);
    assert.equal(r.committedOf(id, 'dich'), c, 'b saved; c is hidden from the role (mic without MIC_SHARE_OK), so it needs nothing; d still waits');
    r.translate(id, [{ sourceId: d, text: 'xin chào (Thái)' }]);
    assert.equal(r.committedOf(id, 'dich'), e);
    // chinh: the saved picture is its work, and it covers the rows up to the highest source it cites, never past what was handed over.
    await r.next(id, c, 0, 12, true, 'chinh', { lease: 'chinhcommit1' });
    assert.equal(r.committedOf(id, 'chinh'), 0, 'no picture yet');
    r.savePicture(id, 'Bức tranh', [b]); assert.equal(r.committedOf(id, 'chinh'), b);
    r.savePicture(id, 'Bức tranh 2', [e]); assert.equal(r.committedOf(id, 'chinh'), c, 'capped at what chinh was handed');
    const roles = r.compact().followers; assert.equal(roles.dich.committed, e); assert.equal(roles.dich.cursor, e); assert.equal(roles.chinh.committed, c);
    assert.equal(r.db.prepare('SELECT committed FROM followers WHERE session_id=? AND name=?').get(id, 'dich').committed, e, 'stored for a host that takes over');
  });
});

test('the machine lock is kept while anything of the host still runs: recorder, worker, unconfirmed cleanup or a recheck; rechecks take it one after the other', async () => {
  const saved = process.env.PMA_LOCK_DIR; process.env.PMA_LOCK_DIR = mkdtempSync(join(tmpdir(), 'pma-lock-session-'));
  const lock = await import('../dist/machine_lock.js');
  try {
    await withFakes(async (r, dir) => {
      r.machine = { token: 'tokn', port: null };
      const { id } = await openSession(r, dir); r.claim(id); assert.equal(lock.readLock().token, 'tokn');
      const wall = new Date(Date.now() - 20000).toISOString(); const heard = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, '', 'cap', 'lo', wall, 1);
      await r.finish(id); assert.equal(lock.readLock(), null, 'all stopped and confirmed: given back');
      r.claim(id); r.captureState = 'CLEANUP_UNCONFIRMED'; assert.equal(r.releaseWhenIdle(), false); assert.equal(lock.readLock().token, 'tokn', 'kept while a worker exit is not confirmed');
      r.captureState = 'OFF'; r.recorder.attached = true; r.recorder.pid = process.pid; assert.equal(r.releaseWhenIdle(), false, 'kept while the recorder is alive');
      r.recorder.attached = false; r.recorder.pid = null; r.rechecking = 1; assert.equal(r.releaseWhenIdle(), false, 'kept while a recheck runs'); r.rechecking = 0;
      assert.equal(r.releaseWhenIdle(), true); assert.equal(lock.readLock(), null);
      // Two rechecks asked together after the meeting: each takes the machine and gives it back before the next one starts.
      const events = []; const claim = r.claim.bind(r), unclaim = r.unclaim.bind(r);
      r.claim = sid => { events.push('claim'); return claim(sid); }; r.unclaim = () => { events.push('give back'); return unclaim(); };
      await Promise.all([r.recheck(id, { sourceId: heard }), r.recheck(id, { sourceId: heard })]);
      assert.deepEqual(events, ['claim', 'give back', 'claim', 'give back']); assert.equal(lock.readLock(), null);
    });
  } finally { if (saved === undefined) delete process.env.PMA_LOCK_DIR; else process.env.PMA_LOCK_DIR = saved; }
});

test('stop: the recorder ends first, the ASR worker delivers what is left, the mix is made, and only then are RAW written and the host told it may leave', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'tail.json'), JSON.stringify(['câu cuối cùng sau khi dừng']));
    await r.start(id); await until(() => r.sources(id).length === 1, 'first text');
    const order = []; const mixArgs = []; let mixStarted = 0;
    r.mixer = async (python, args) => { mixStarted = Date.now(); order.push('mix-start'); mixArgs.push(args); await sleep(150); writeFileSync(join(args[1], 'meeting-mix.wav'), Buffer.alloc(100)); order.push('mix-end'); };
    r.on('finished', () => order.push('finished'));
    const done = r.finish(id).then(result => { order.push('finish-returned'); return result; });
    await sleep(120);
    assert.equal(r.session.ended, null, 'followers keep receiving text while the worker drains'); assert.equal(r.captureState, 'STOPPING');
    const result = await done;
    assert.deepEqual(order, ['mix-start', 'mix-end', 'finished', 'finish-returned']); assert.deepEqual(mixArgs, [[join(r.root, 'tools', 'mix_audio.py'), audio]]);
    const recorderEnd = readLog(audio, 'recorder-log.jsonl').find(entry => entry.what === 'end'); assert.ok(recorderEnd.at <= mixStarted, 'mixed after the recorder ended');
    const worker = readLog(audio, 'worker-log.jsonl'); const stop = worker.find(entry => entry.what === 'stop'); const exit = worker.find(entry => entry.what === 'exit');
    assert.ok(stop && exit && exit.at - stop.at >= 250, 'the worker was waited for while it delivered the tail');
    assert.ok(r.sources(id).some(row => row.text === 'câu cuối cùng sau khi dừng'), 'text delivered during the drain is kept');
    const raw = readFileSync(result.raw.path, 'utf8'); assert.ok(raw.includes('câu cuối cùng sau khi dừng')); assert.ok(raw.includes(join(audio, 'meeting-mix.wav') + '.'), 'RAW names the finished mix, not a pending one');
    assert.ok(r.session.ended); assert.equal(r.capture, null); assert.equal(r.captureState, 'OFF'); assert.equal(r.recorder.state, 'OFF'); assert.ok(!existsSync(join(audio, 'STOP')));
  });
});

test('stop without ever listening does not wait for the idle worker to read the whole recording', async () => {
  await withFakes(async (r, dir) => {
    const { id } = await openSession(r, dir); r.drainIdleMs = 60000;
    const started = Date.now(); await r.finish(id); assert.ok(Date.now() - started < 3000, 'a worker that never listened is not drained for minutes');
  });
});

test('the session host exits after stop (once nothing is left to do), a later command starts one only for history, and that one leaves when idle; default idle is 2 minutes', async () => {
  assert.match(readFileSync('src/daemon.ts', 'utf8'), /PMA_IDLE_MINUTES \|\| 2\)/);
  const run = promisify(execFile); const dir = mkdtempSync(join(tmpdir(), 'pma-host-test-'));
  const env = { ...process.env, PMA_PORT: process.env.PMA_SESSION_TEST_PORT || '8815', PMA_TEST_MODE: '1', PMA_DATA_DIR: dir, PMA_STOP_HOOK: 'off', PMA_EXIT_AFTER_FINISH: '1', PMA_IDLE_MINUTES: '0.03' };
  const pma = async (...args) => JSON.parse((await run(process.execPath, [resolve('dist/cli.js'), ...args], { env })).stdout);
  const info = () => JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'));
  try {
    const started = await pma('start', '--title', 'Họp thử'); const first = info();
    assert.equal(first.sessionId, started.session.id); assert.equal(first.recorderPid, null); assert.equal(first.asr, 'paused'); assert.equal(started.rememberedSpeaker, null);
    await sleep(2500); assert.ok(alive(first.pid), 'an open session keeps its host alive past the idle time');
    const stopped = await pma('stop'); assert.ok(stopped.raw.path);
    await until(() => !alive(first.pid), 'host exit after stop', 12000); assert.ok(!existsSync(join(dir, 'daemon.json')), 'gone from daemon.json before the port is freed');
    const history = await pma('history'); assert.equal(history.length, 1); const second = info();
    assert.notEqual(second.pid, first.pid); assert.equal(second.sessionId, null, 'a history-only host has no session');
    await until(() => !alive(second.pid), 'idle host exit', 15000);
  } finally { await pma('shutdown').catch(() => {}); await sleep(600); rmSync(dir, { recursive: true, force: true }); }
});

test('recheck: the worker is asked for the stretch around a source (or a clock range), the answer is stored, the source tagged RECHECKED and RAW shows it', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    const wall = new Date(Date.now() - 20000).toISOString();
    const heard = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, 'LANG_UNSURE', 'cap', 'lo', wall, 1); const typed = r.ingest('ghi tay', 'operator_text');
    await assert.rejects(r.recheck(id, { sourceId: typed }), /SOURCE_HAS_NO_WALL_TIME/); await assert.rejects(r.recheck(id, { sourceId: 9999 }), /SOURCE_OUTSIDE_SESSION/);
    await assert.rejects(r.recheck(id, { sourceId: heard, channel: 'both' }), /INVALID_CHANNEL/); await assert.rejects(r.recheck(id, { from: '25:00:00', to: '25:01:00' }), /INVALID_TIME/);
    const result = await r.recheck(id, { sourceId: heard });
    const args = JSON.parse(readFileSync(join(audio, 'recheck-args.json'), 'utf8'));
    assert.equal(after(args, '--recheck'), audio); assert.equal(after(args, '--from'), new Date(Date.parse(wall) - 1000).toISOString()); assert.equal(after(args, '--to'), new Date(Date.parse(wall) + 4000).toISOString());
    assert.equal(after(args, '--channel'), 'speaker'); assert.equal(after(args, '--beam'), '8'); assert.equal(after(args, '--languages'), 'vi,lo,th');
    assert.equal(result.sourceId, heard); assert.equal(result.text, 'xin chào đã nghe lại'); assert.equal(result.language, 'lo'); assert.equal(result.alternatives[0].language, 'th'); assert.equal(result.silent, false);
    assert.equal(r.sources(id).find(row => row.id === heard).boundary, 'LANG_UNSURE; RECHECKED'); await r.recheck(id, { sourceId: heard, beam: 4 });
    assert.equal(r.sources(id).find(row => row.id === heard).boundary, 'LANG_UNSURE; RECHECKED', 'tagged once');
    // a clock range, answered with silence
    writeFileSync(join(audio, 'recheck-result.json'), JSON.stringify({ text: '', language: '', alternatives: [], silent: true }));
    const hms = ms => new Date(ms).toLocaleTimeString('en-GB'); const from = Date.now() - 90000;
    const range = await r.recheck(id, { from: hms(from), to: hms(from + 30000), channel: 'mic' });
    assert.equal(range.sourceId, null); assert.equal(range.silent, true); assert.ok(Math.abs(Date.parse(range.from) - from) < 1000); assert.equal(after(JSON.parse(readFileSync(join(audio, 'recheck-args.json'), 'utf8')), '--channel'), 'mic');
    await assert.rejects(r.recheck(id, { from: hms(from), to: hms(from - 60000) }), /INVALID_RANGE/, 'a range that would run past 30 minutes');
    const raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.ok(raw.includes(`#${heard} (nghe · lo · ngôn ngữ không chắc) ສະບາຍດີ\n  (đã nghe lại: [lo] xin chào đã nghe lại — phương án khác: [th] สวัสดี)`), 'the latest answer is under its source');
    assert.match(raw, /## Nghe lại theo khoảng thời gian[\s\S]*\(đã nghe lại: không thấy tiếng nói\)/);
    assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM rechecks').get().n, 3);
    await r.finish(id); await assert.rejects(r.recheck(id, { sourceId: typed }), /SOURCE_HAS_NO_WALL_TIME/); assert.equal((await r.recheck(id, { sourceId: heard })).sourceId, heard, 'works after the session ended');
  });
});

// A PCM16 mono WAV with a tone in the given second ranges.
function writeWav(path, rate, seconds, loud) {
  const samples = rate * seconds; const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (const [from, to] of loud) for (let i = from * rate; i < to * rate; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 7) * 0.2 * 32767), 44 + i * 2);
  writeFileSync(path, buffer);
}

test('coverage lists sound with no transcript, ASR gaps, doubted rows and recorder losses, from the timeline and the WAV; a recheck settles an item', async () => {
  await withFakes(async (r, dir) => {
    process.env.PMA_WARM = '0'; r.prepare('Họp', false, undefined, ['vi', 'lo']); const id = r.session.id; delete process.env.PMA_WARM;
    const audio = markAudioDir(dir, id).dir; const t0 = Math.floor(Date.now() / 1000) * 1000 - 120000; const at = k => new Date(t0 + k * 1000).toISOString();
    const events = [{ t: at(0), type: 'open', seg: 1, channel: 'speaker', rate: 16000, device: 'Loop' }, ...Array.from({ length: 40 }, (_, k) => ({ t: at(k + 1), type: 'tick', seg: 1, channel: 'speaker', samples: 16000 * (k + 1) })),
      { t: at(20), type: 'lost', seg: 1, channel: 'speaker', seconds: 2, reason: 'device removed' }, { t: at(40), type: 'close', seg: 1, channel: 'speaker', samples: 640000 }, { t: at(40), type: 'end' }];
    writeFileSync(join(audio, 'timeline.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\nnot json at all\n');
    const loud = [[5, 15], [25, 35]]; writeWav(join(audio, 'seg-0001-speaker.wav'), 16000, 40, loud);
    const doubted = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 10, 'LANG_UNSURE; LAO_LOW_CONFIDENCE', 'cap', 'lo', at(5), 1);
    const gap = r.ingest('[KHOẢNG TRỐNG ASR] lỗi', 'system_gap', 0, 4, 'ASR_ERROR', 'cap', '', at(16), 1);
    r.ingest('đoạn không có giờ', 'operator_text');

    let cov = r.coverage(id);
    assert.equal(cov.audio.basis, 'speaker-segments'); assert.ok(cov.audio.seconds >= 39);
    assert.deepEqual(cov.items.map(item => item.kind), ['UNSURE', 'ASR_GAP', 'RECORDER_LOST', 'NO_TRANSCRIPT']);
    assert.deepEqual(cov.counts, { UNSURE: 1, ASR_GAP: 1, RECORDER_LOST: 1, NO_TRANSCRIPT: 1 }); assert.equal(cov.total, 4); assert.equal(cov.open, 3, 'a loss in the recording cannot be rechecked');
    const [unsure, gapItem, lost, silent] = cov.items;
    assert.equal(unsure.sourceId, doubted); assert.match(unsure.why, /ngôn ngữ không chắc, tiếng Lào nhận dạng kém/); assert.equal(unsure.recheck, `pma recheck #${doubted}`); assert.equal(unsure.from, at(5)); assert.equal(unsure.seconds, 10);
    assert.equal(gapItem.sourceId, gap); assert.match(gapItem.why, /ASR lỗi/); assert.equal(lost.rechecked, true); assert.match(lost.why, /mất 2 giây/); assert.equal(Date.parse(lost.to), t0 + 20000);
    assert.equal(silent.from, at(25)); assert.equal(silent.to, at(35)); assert.match(silent.recheck, /^pma recheck --from \d\d:\d\d:\d\d --to \d\d:\d\d:\d\d$/); assert.match(silent.why, /có tiếng/);
    // 5–15 s has sound too, but it has a transcript: it is not reported as untranscribed.
    assert.ok(!cov.items.some(item => item.kind === 'NO_TRANSCRIPT' && Date.parse(item.from) < t0 + 20000));

    await r.recheck(id, { from: silent.from, to: silent.to }); await r.recheck(id, { sourceId: doubted });
    cov = r.coverage(id);
    assert.deepEqual(cov.items.map(item => item.kind), ['UNSURE', 'ASR_GAP', 'RECORDER_LOST']); assert.equal(cov.items[0].rechecked, true); assert.equal(cov.open, 1);

    // After the session ended the 16 kHz mix is the judge; the same stretches come out.
    writeWav(join(audio, 'meeting-mix.wav'), 16000, 40, loud); await r.finish(id);
    cov = r.coverage(id); assert.equal(cov.audio.basis, 'mix'); assert.equal(cov.total, 3);
    assert.equal(r.coverage(r.latestSessionId()).sessionId, id);
  });
});

test('coverage does not blame the ASR for audio it has not reached yet, and says so when rows have no real time', async () => {
  await withFakes(async (r, dir) => {
    process.env.PMA_WARM = '0'; r.prepare('Họp'); const id = r.session.id; delete process.env.PMA_WARM;
    const audio = markAudioDir(dir, id).dir; const t0 = Math.floor(Date.now() / 1000) * 1000 - 60000; const at = k => new Date(t0 + k * 1000).toISOString();
    writeFileSync(join(audio, 'timeline.jsonl'), [{ t: at(0), type: 'open', seg: 1, channel: 'speaker', rate: 16000 }, ...Array.from({ length: 30 }, (_, k) => ({ t: at(k + 1), type: 'tick', seg: 1, channel: 'speaker', samples: 16000 * (k + 1) }))].map(event => JSON.stringify(event)).join('\n') + '\n');
    writeWav(join(audio, 'seg-0001-speaker.wav'), 16000, 30, [[2, 10], [20, 28]]);
    assert.deepEqual(r.coverage(id).items.map(item => item.kind), ['NO_TRANSCRIPT', 'NO_TRANSCRIPT'], 'ASR never ran: all the sound is untranscribed');
    r.ingest('đã nghe', 'local_asr_unverified', 0, 8, '', 'cap', 'vi');  // from a worker that gave no real time
    const cov = r.coverage(id); assert.equal(cov.items.length, 0); assert.match(cov.note, /không có giờ thật/);
    r.ingest('đã nghe có giờ', 'local_asr_unverified', 0, 8, '', 'cap', 'vi', at(2), 1);
    assert.deepEqual(r.coverage(id).items.map(item => [item.kind, item.from]), [['NO_TRANSCRIPT', at(20)]], '2–10 s now has its transcript');
    // While the ASR is on and still catching up, sound beyond where it got to is not yet missing.
    r.asrWanted = true; r.capture = { pid: 1 }; r.asrPosition = at(12);
    try { assert.equal(r.coverage(id).items.length, 0); r.asrPosition = at(40); assert.equal(r.coverage(id).items.length, 1); } finally { r.capture = null; r.asrWanted = false; }
  });
});

test('replay still runs through the old per-listening worker, with no meeting-length cap and no recorder', async () => {
  await withFakes(async (r, dir) => {
    const file = join(dir, 'ghi-hinh.wav'); writeFileSync(file, Buffer.alloc(100));
    r.prepare('Phát lại', false, undefined, ['vi', 'lo'], { warm: false }); const id = r.session.id; assert.equal(r.capture, null, 'no warm follower for a replay');
    await r.replay(id, file, 4); await until(() => r.captureState === 'LISTENING', 'replay worker ready');
    const args = JSON.parse(readFileSync(join(dir, 'replay-args.json'), 'utf8'));
    assert.ok(args.includes('--capture')); assert.equal(after(args, '--replay'), file); assert.equal(after(args, '--speed'), '4'); assert.equal(after(args, '--max-seconds'), '86400'); assert.ok(!args.includes('--follow'));
    assert.equal(r.recorder.state, 'OFF'); assert.equal(r.recorder.pid, null);
    await r.finish(id); assert.equal(r.captureState, 'OFF'); assert.equal(r.capture, null);
  });
});

test('the follow worker\'s rows are stamped live by the host; what a recheck heard again and Claude\'s translations never reach what a share role (or anyone) reads through next/read', async () => {
  await withFakes(async (r, dir) => {
    const { id } = await openSession(r, dir); await r.start(id); await until(() => r.sources(id).length === 1, 'first text');
    const [heard] = r.sources(id); assert.equal(heard.boundary, 'SILENCE_BOUNDARY_HEURISTIC; SOURCE_LIVE_FOLLOW', 'the follow worker of this host: live');
    assert.deepEqual((await r.next(id, 0, 0, 100, true, 'dich')).items.map(item => item.id), [heard.id]);
    const wall = new Date(Date.now() - 20000).toISOString();
    const lo = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, 'SOURCE_LIVE_FOLLOW', 'cap', 'lo', wall, 1);
    const secret = r.ingest('ລັບ', 'local_asr_unverified', 0, 3, 'CHANNEL_MIC; MIC_STATE_OFF; SOURCE_LIVE_FOLLOW', 'cap', 'lo', wall, 1);
    r.translate(id, [{ sourceId: lo, text: 'bản dịch công khai' }, { sourceId: secret, text: 'bản dịch dòng riêng' }]);
    for (const sourceId of [lo, secret]) assert.equal((await r.recheck(id, { sourceId })).text, 'xin chào đã nghe lại');
    assert.match(r.sources(id).find(row => row.id === secret).boundary, /RECHECKED$/);
    const outputs = [await r.next(id, 0, 0, 100, true, 'dich'), await r.next(id, 0, 0, 100, true, 'chinh'), r.read(id, 0, 100, 'dich'), r.read(id, 0, 100), r.read(id, 0, 100, 'chinh')];
    for (const output of outputs) { const text = JSON.stringify(output); assert.ok(!text.includes('đã nghe lại') && !text.includes('สวัสดี'), 'recheck answers live in their own table and RAW only'); }
    // Translations never go back into what a role is handed (next) nor to a share role; the owner's read shows them (0.12.1, OWN-031).
    for (const output of outputs.slice(0, 3)) assert.ok(!JSON.stringify(output).includes('bản dịch'), 'no translation in next or in a share role read');
    for (const output of outputs.slice(3)) assert.equal(output.items.find(item => item.id === lo).translation, 'bản dịch công khai');
    assert.deepEqual(outputs[0].items.map(item => item.id), [heard.id, lo], 'the mic-off row stays out, rechecked or not'); assert.deepEqual(outputs[2].items.map(item => item.id), [heard.id, lo]);
    const raw = readFileSync(r.writeRaw(id).path, 'utf8'); assert.ok(raw.includes('(đã nghe lại: [lo] xin chào đã nghe lại') && raw.includes('bản dịch dòng riêng'), 'RAW keeps them for the owner');
  });
});
