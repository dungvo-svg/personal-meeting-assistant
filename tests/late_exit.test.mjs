// Late exits and races at the runtime's process seams (0.12.x). Review demand: a fake process or thread keeps its owner until it has REALLY
// ended; a stale record, a refused or ignored kill, or a timeout is never read as "the worker is dead". The machine lock (machine_lock.ts)
// is therefore kept while anything of the host still runs (releaseWhenIdle), however late that thing exits.
//
// Everything is in process: tests/fake_process.mjs fakes the PIDs (runtime.alive / runtime.killPid) and the child objects (recorder.child,
// capture) and a clock the test advances by hand; no process is spawned, no device opened, no model loaded, runtime.python() throws if
// anything tries. The assertions are the SAFE behaviour. Where the runtime of 7a02d74 behaves otherwise the case is marked GAP in its title
// comment and will fail until the runtime is changed; the test is not bent to the runtime.
// Timing note: stopRecorder waits 3000 ms and drainWorker 3000 ms in real time after a kill (runtime.ts:722, :978, constants), so the
// cases that go through finish() take about 3 s per stuck process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeClock, fakeProc, fakeChild, attachFakeRecorder, attachFakeWorker, installSeams, guardOsKill } from './fake_process.mjs';

const lockDir = mkdtempSync(join(tmpdir(), 'pma-lateexit-lock-')); process.env.PMA_LOCK_DIR = lockDir;   // before the lock module is loaded
const lock = await import('../dist/machine_lock.js');
const { MeetingRuntime } = await import('../dist/runtime.js');
after(() => rmSync(lockDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, what, ms = 8000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error('timeout: ' + what); await sleep(10); } };

// A test-mode runtime holding a machine lock of its own, over a temp data folder, a fake clock, and the fake process seams.
async function withRuntime(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pma-lateexit-'));
  const r = new MeetingRuntime(resolve('.'), dir, true); r.mixer = () => {};
  const clock = fakeClock(); r.now = clock.now;
  const spawnAttempts = [];
  r.python = () => { spawnAttempts.push(new Error('spawn attempt').stack); throw new Error('TEST: no real process may be spawned'); };
  r.recorderStopMs = 60; r.drainIdleMs = 100; r.drainMaxMs = 400; r.restartDelayMs = 20;
  const token = 'lateexit-' + Math.random().toString(36).slice(2, 10); r.machine = { token, port: null };
  const osKill = guardOsKill(); const fakes = []; const seam = installSeams(r, []);
  const h = {
    dir, token, clock, spawnAttempts, osKill, seam, fakes,
    proc(options = {}) { const proc = fakeProc({ clock, ...options }); fakes.push(proc); return proc; },
    child(options = {}) { const child = fakeChild({ clock, ...options }); fakes.push(child); return child; },
    useSeams(...procs) { for (const proc of procs) seam.add(proc); },
  };
  try {
    assert.equal(lock.readLock(), null, 'no machine lock at the start of a case');
    await fn(r, h);
    assert.deepEqual(osKill.violations, [], 'no fake PID ever reached process.kill: only the seams were used');
    assert.deepEqual(seam.stray, [], 'the runtime only asked the seams about the fake PIDs');
    for (const fake of fakes) assert.deepEqual(fake.foreign ?? [], [], 'the fake was only asked about its own PID');
    assert.deepEqual(spawnAttempts, [], 'nothing tried to spawn a process');
  } finally {
    // Every fake ends now (closing is set so that no crash handling restarts anything), then the runtime closes quickly.
    r.closing = true;
    for (const fake of fakes) { try { fake.known?.(); fake.exit(); } catch {} }
    r.closing = false;
    try { await r.close(); } catch {}
    osKill.restore(); lock.releaseMachine(token); lock.releaseMachine('contender');
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
const open = r => { r.prepare('Họp', false, undefined, undefined, { warm: false }); return r.session.id; };
const held = h => lock.readLock()?.token === h.token;
// Another host (another data folder) trying to take the machine: it must be refused. If it got in, take its lock back out and fail.
const assertBusy = (h, why) => {
  try { lock.claimMachine({ token: 'contender', dataDir: join(h.dir, 'elsewhere'), root: '.', port: 9 }); }
  catch (error) { assert.match(String(error.message), /RUNTIME_BUSY/, why); return; }
  lock.releaseMachine('contender'); assert.fail('another host got the machine: ' + why);
};
const contenderTakes = h => { const taken = lock.claimMachine({ token: 'contender', dataDir: join(h.dir, 'elsewhere'), root: '.', port: 9 }); assert.equal(taken.token, 'contender'); return () => lock.releaseMachine('contender'); };
const stops = child => child.stdin.lines.filter(entry => entry.line.trim() === 'stop');

// ---- a) the recorder exits LATE: after recorderStopMs and after the kill attempt ----
// What the host sees after finish(): STOP sent, then recorderStopMs, then a kill attempt, then 3 s more; the process is still there.
// Until it really exits: lock held, state STOP_UNCONFIRMED, PID kept, another host refused, however long it takes. After: released.
const lateRecorder = (title, make) => test(title, async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const x = make(r, h);
    const began = Date.now(); await r.finish(id);
    assert.ok(Date.now() - began >= r.recorderStopMs, 'finish waited for the recorder at least recorderStopMs');
    assert.equal(x.kills().length, 1, 'one kill attempt, on the fake only');
    if (x.stopLines) { assert.equal(x.stopLines().length, 1, 'one stop on its stdin'); assert.ok(x.kills()[0].at - x.stopLines()[0].at >= r.recorderStopMs, 'the kill came after recorderStopMs'); }
    assert.ok(r.session.ended, 'the meeting itself is ended');
    assert.equal(x.alive(), true, 'refused, ignored or pending: the process is still alive');
    assert.equal(r.recorder.state, 'STOP_UNCONFIRMED'); assert.equal(r.recorder.pid, x.pid, 'the unconfirmed recorder keeps its PID'); assert.equal(r.recorderAlive(), true);
    assert.ok(held(h), 'the machine lock is held'); assert.equal(r.releaseWhenIdle(), false); assert.ok(held(h), 'still held after releaseWhenIdle');
    assertBusy(h, 'another host while the recorder has not exited');
    // Time passing is not an exit: the same state after more real time and after the fake clock got close to the scheduled exit.
    await sleep(150); assert.equal(r.releaseWhenIdle(), false); assert.equal(r.recorder.state, 'STOP_UNCONFIRMED');
    if (x.lateMs !== null) { assert.equal(h.clock.pending(), 1, 'the late exit is scheduled, not done'); h.clock.advance(x.lateMs - 1); assert.equal(x.alive(), true); assert.equal(r.releaseWhenIdle(), false); assert.ok(held(h)); }
    // The late exit.
    if (x.lateMs !== null) h.clock.advance(1); else x.exit();
    assert.equal(x.alive(), false, 'now it has really exited');
    assert.equal(r.recorderAlive(), false); assert.equal(r.releaseWhenIdle(), true, 'released once the exit is seen'); assert.equal(lock.readLock(), null);
    contenderTakes(h)();   // the machine is free for another host now
  });
});
lateRecorder('a) a child recorder that ignores STOP and exits late after the kill attempt: lock held and STOP_UNCONFIRMED until the exit, then released', (r, h) => {
  const child = h.child({ kill: 'late', lateMs: 5000 }); attachFakeRecorder(r, child);
  return { pid: child.pid, kills: () => child.kills, stopLines: () => stops(child), lateMs: 5000, alive: () => child.exitCode === null && child.signalCode === null, exit: () => child.exit(0) };
});
lateRecorder('a) a child recorder whose kill() throws EPERM (swallowed) exits late by itself: same', (r, h) => {
  const child = h.child({ kill: 'throw' }); attachFakeRecorder(r, child);
  return { pid: child.pid, kills: () => child.kills, stopLines: () => stops(child), lateMs: null, alive: () => child.exitCode === null && child.signalCode === null, exit: () => child.exit(0) };
});
lateRecorder('a) an attached recorder (PID only) whose killPid schedules a late exit on the fake clock: same, through the seams', (r, h) => {
  const proc = h.proc({ kill: 'late', lateMs: 5000 }); h.useSeams(proc); r.attachRecorder(proc.pid);
  return { pid: proc.pid, kills: () => proc.kills, lateMs: 5000, alive: () => proc.alive(proc.pid), exit: () => proc.exit(0) };
});
lateRecorder('a) an attached recorder whose killPid refuses (EPERM) and that exits only later: same', (r, h) => {
  const proc = h.proc({ kill: 'refuse' }); h.useSeams(proc); r.attachRecorder(proc.pid);
  return { pid: proc.pid, kills: () => proc.kills, lateMs: null, alive: () => proc.alive(proc.pid), exit: () => proc.exit(0) };
});

// ---- b) the ASR worker is in CLEANUP_UNCONFIRMED, then exits late ----
test('b) finish with a worker that ignores stop and kill: CLEANUP_UNCONFIRMED keeps the lock; only the late exit lets it go', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const worker = h.child({ kill: 'late', lateMs: 5000 }); attachFakeWorker(r, worker);
    await r.finish(id);
    assert.equal(stops(worker).length, 1, 'stop was sent on its stdin'); assert.ok(worker.kills.length >= 1, 'it was killed (asked) and is still there');
    assert.equal(r.captureState, 'CLEANUP_UNCONFIRMED'); assert.equal(r.capture, worker, 'the host still owns the worker'); assert.match(r.lastError ?? '', /not yet confirmed/);
    assert.ok(held(h)); assert.equal(r.releaseWhenIdle(), false); assert.ok(held(h));
    assertBusy(h, 'another host while the worker exit is unconfirmed');
    assert.throws(() => r.prepare('Họp 2'), /PREVIOUS_CAPTURE_NOT_CLOSED/, 'no new meeting over a worker that may still be running');
    await sleep(150); h.clock.advance(4999);
    assert.equal(r.captureState, 'CLEANUP_UNCONFIRMED', 'time passing does not confirm anything'); assert.equal(r.capture, worker); assert.equal(r.releaseWhenIdle(), false); assert.ok(held(h));
    h.clock.advance(1);   // the late exit (killed by signal)
    assert.equal(worker.signalCode, 'SIGKILL'); assert.equal(r.capture, null, 'the runtime saw it gone'); assert.notEqual(r.captureState, 'CLEANUP_UNCONFIRMED');
    assert.equal(r.releaseWhenIdle(), true); assert.equal(lock.readLock(), null);
  });
});

// GAP (runtime.ts:981 resets workerStopping while the worker is still alive; :796 then reads its late exit as a crash; :893-903 restarts it):
// a worker that was stopped on purpose and exits late, with the session still open (stopCapture without finish), must not be "restarted".
test('b) stopCapture on an open session, worker exits late: that is not a crash, nothing is restarted, no gap row, no new worker', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const worker = h.child({ kill: 'late', lateMs: 5000 }); attachFakeWorker(r, worker);
    await r.stopCapture();
    assert.equal(r.captureState, 'CLEANUP_UNCONFIRMED'); assert.equal(r.capture, worker); assert.ok(held(h)); assert.equal(r.releaseWhenIdle(), false);
    await assert.rejects(r.start(id), /CAPTURE_STOP_IN_PROGRESS/, 'listening cannot start over an unconfirmed worker');
    h.clock.advance(5000); await sleep(120);   // restartDelayMs is 20 ms: a (wrong) restart would have fired by now
    assert.equal(r.capture, null);
    assert.deepEqual(h.spawnAttempts, [], 'a worker that was asked to stop is never started again by its own late exit');
    assert.equal(r.workerRetry, null, 'no restart timer'); assert.equal(r.captureState, 'OFF', 'not ASR_RESTARTING'); assert.equal(r.sources(id).length, 0, 'no ASR gap row for a stop that was asked for');
  });
});

test('b) recorder and worker both late: the lock is kept until the LAST one has really exited, whichever order', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r);
    const recorder = h.child({ kill: 'late', lateMs: 9000 }); attachFakeRecorder(r, recorder);
    const worker = h.child({ kill: 'late', lateMs: 5000 }); attachFakeWorker(r, worker);
    await r.finish(id);   // recorder first (3 s), then the worker (3 s)
    assert.equal(r.recorder.state, 'STOP_UNCONFIRMED'); assert.equal(r.captureState, 'CLEANUP_UNCONFIRMED'); assert.ok(held(h)); assert.equal(r.releaseWhenIdle(), false);
    h.clock.advance(5000);   // the worker goes first; the recorder is still there
    assert.equal(worker.signalCode, 'SIGKILL'); assert.equal(r.capture, null); assert.equal(recorder.exitCode, null);
    assert.equal(r.recorderAlive(), true); assert.equal(r.releaseWhenIdle(), false, 'the recorder is still alive: kept'); assert.ok(held(h)); assertBusy(h, 'worker gone, recorder not');
    h.clock.advance(4000);   // the recorder at last
    assert.equal(r.recorderAlive(), false); assert.equal(r.releaseWhenIdle(), true); assert.equal(lock.readLock(), null);
  });
});

// ---- c) a lease older than 90 s while the old follow PROCESS is still alive by the seam ----
// The lease rule moves the ROLE by heartbeat age only; it neither asks nor kills the old process, and it must not move the machine lock,
// the capture or the recorder, nor start anything.
test('c) a role lease older than 90 s passes to a new lease while the old follow process is alive; machine lock, capture and recorder do not move; no second worker', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const A = 'leaseaaa1', B = 'leasebbb2';
    const recorder = h.child({ kill: 'ignore' }); attachFakeRecorder(r, recorder);
    const worker = h.child({ kill: 'ignore' }); attachFakeWorker(r, worker, { state: 'LISTENING' });
    const follow = h.proc({ kill: 'ignore' }); h.useSeams(follow);   // the old `pma follow` process: alive until the test ends it
    const nx = (lease) => r.next(id, 0, 0, 100, true, 'chinh', { lease });
    const ownership = () => ({ lock: lock.readLock(), capture: r.capture === worker, recorder: r.recorder.child === recorder, captureState: r.captureState, recorderState: r.recorder.state, workerKills: worker.kills.length, recorderKills: recorder.kills.length });
    const before = ownership(); assert.ok(held(h));
    await nx(A); assert.equal(r.followers.chinh.lease, A);
    h.clock.advance(60_000); await assert.rejects(nx(B), /FOLLOWER_BUSY/, 'at 60 s A still holds the role');
    h.clock.advance(31_000);   // 91 s since A's heartbeat; A's process is alive by the seam all along
    assert.equal(follow.alive(follow.pid), true);
    await nx(B); assert.equal(r.followers.chinh.lease, B, 'the lease rule: a stale lease gives the role to the new one');
    const roles = JSON.stringify([r.followers.chinh, r.agentCursor, r.lastFollowAt]);
    await assert.rejects(nx(A), /FOLLOWER_BUSY/, 'the old process, still alive, cannot take it back while B is fresh');
    assert.equal(JSON.stringify([r.followers.chinh, r.agentCursor, r.lastFollowAt]), roles, 'a refused call writes nothing');
    assert.deepEqual(r.release(id, 'chinh', A, 0), { released: false }, 'a late release by the old lease changes nothing'); assert.equal(r.followers.chinh.lease, B);
    assert.deepEqual(ownership(), before, 'machine lock (token, since, pids), worker and recorder did not move');
    assertBusy(h, 'the role changed hands, the machine did not');
    assert.equal(follow.kills.length, 0, 'the runtime did not touch the old follow process'); assert.equal(follow.alive(follow.pid), true);
    assert.deepEqual(h.spawnAttempts, [], 'no second worker, no second recorder');
    // And back: B goes stale too and A (alive) takes the role again; still the same machine ownership.
    h.clock.advance(91_000); await nx(A); assert.equal(r.followers.chinh.lease, A); assert.deepEqual(ownership(), before); assert.deepEqual(h.spawnAttempts, []);
  });
});

// ---- d) a racing finish() twice plus a late exit ----
const bookkeeping = (r, h) => {
  const finished = []; r.on('finished', sid => finished.push(sid));
  const releases = []; const unclaim = r.unclaim.bind(r);
  r.unclaim = () => { releases.push({ recorderAlive: r.recorderAlive(), lockHeld: held(h) }); return unclaim(); };
  return { finished, releases };
};
test('d) two finish() at once and a late recorder exit: nothing is released before the exit, the lock comes off once, finish is idempotent', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const recorder = h.child({ kill: 'late', lateMs: 5000 }); attachFakeRecorder(r, recorder);
    const { finished, releases } = bookkeeping(r, h);
    await Promise.all([r.finish(id), r.finish(id)]);
    assert.equal(releases.length, 0, 'no release while the recorder is alive'); assert.ok(held(h));
    assert.equal(stops(recorder).length, 1, 'one stop'); assert.equal(recorder.kills.length, 1, 'one kill attempt for the two finishes');
    assert.equal(r.recorder.state, 'STOP_UNCONFIRMED'); assert.equal(finished.length, 1, '"finished" is announced once');
    const ended = r.session.ended; assert.ok(ended); const stored = () => r.db.prepare('SELECT ended FROM sessions WHERE id=?').get(id).ended; assert.equal(stored(), ended);
    await r.finish(id);   // a third one while the recorder is still unconfirmed
    assert.equal(releases.length, 0); assert.equal(r.session.ended, ended); assert.equal(stored(), ended); assert.equal(finished.length, 1); assert.equal(recorder.kills.length, 1, 'no second kill'); assert.ok(held(h));
    h.clock.advance(5000);   // the late exit, and two more finishes right behind it
    await Promise.all([r.finish(id), r.finish(id)]);
    assert.ok(releases.length >= 1); assert.ok(releases.every(entry => !entry.recorderAlive), 'never released before the exit');
    assert.equal(releases.filter(entry => entry.lockHeld).length, 1, 'the lock was taken off exactly once');
    assert.equal(lock.readLock(), null); assert.equal(finished.length, 1); assert.equal(r.session.ended, ended); assert.equal(stored(), ended);
    // Another host has the machine now: a further finish or release of ours must not touch its lock.
    const giveBack = contenderTakes(h); await r.finish(id); assert.equal(r.releaseWhenIdle(), true);
    assert.equal(lock.readLock()?.token, 'contender', 'our late release did not remove the other host\'s lock'); giveBack();
  });
});
test('d) the exit comes inside the 3 s grace after the kill, two finish() racing: the lock comes off once and only after the exit', async () => {
  await withRuntime(async (r, h) => {
    const id = open(r); const recorder = h.child({ kill: 'ignore' }); attachFakeRecorder(r, recorder);
    const { finished, releases } = bookkeeping(r, h);
    const run = Promise.all([r.finish(id), r.finish(id)]);
    await until(() => recorder.kills.length >= 1, 'the kill attempt'); assert.equal(releases.length, 0); assert.ok(held(h));
    recorder.exit(1); await run;
    assert.equal(recorder.kills.length, 1); assert.equal(r.recorder.state, 'OFF'); assert.equal(r.recorderAlive(), false);
    assert.ok(releases.length >= 1 && releases.every(entry => !entry.recorderAlive), 'released only after the exit');
    assert.equal(releases.filter(entry => entry.lockHeld).length, 1, 'the lock was taken off exactly once'); assert.equal(lock.readLock(), null); assert.equal(finished.length, 1);
  });
});

// ---- e) unknown liveness is ALIVE: fail closed ----
// The reading of a PID can fail (the seam throws) or give no answer (undefined). Neither is evidence that the process is gone.
// GAP (runtime.ts:540): recorderAlive() lets the throw through, so releaseWhenIdle() throws (the lock is kept, but a host interval calling it, daemon.ts:199, would die)
// and finish() rejects; an unreadable answer (undefined) is read as dead through `!!`, so the lock is RELEASED.
const attachedUnreadable = (r, h, how) => {
  const id = open(r); const proc = h.proc({ kill: 'refuse' }); h.useSeams(proc);
  r.recorder.attached = true; r.recorder.pid = proc.pid; r.recorder.state = 'RECORDING';   // by hand: attachRecorder would start a timer polling the seam
  proc.unknown(how); return { id, proc };
};
for (const how of ['throw', 'undefined']) test(`e) liveness unreadable (${how}): the recorder counts as alive, releaseWhenIdle keeps the lock and does not throw`, async () => {
  await withRuntime(async (r, h) => {
    const { proc } = attachedUnreadable(r, h, how);
    let outcome; try { outcome = r.releaseWhenIdle(); } catch (error) { outcome = 'threw ' + (error.code ?? error.message); }
    assert.ok(held(h), 'the lock is kept while the reading is unknown');
    assert.equal(outcome, false, 'an unknown reading is a plain "not idle": no release, no throw');
    assertBusy(h, 'unknown liveness');
    proc.known(); assert.equal(r.releaseWhenIdle(), false, 'readable and alive: kept'); assert.ok(held(h));
    proc.exit(); assert.equal(r.releaseWhenIdle(), true, 'readable and gone: released'); assert.equal(lock.readLock(), null);
  });
});
test('e) finish() while the recorder liveness cannot be read: it still ends the meeting, ends in STOP_UNCONFIRMED and holds the lock', async () => {
  await withRuntime(async (r, h) => {
    const { id, proc } = attachedUnreadable(r, h, 'throw');
    let failure = null; try { await r.finish(id); } catch (error) { failure = error; }
    assert.equal(failure, null, 'finish does not reject because a PID could not be read');
    assert.ok(r.session.ended, 'the meeting is ended'); assert.ok(held(h), 'the lock is kept'); assert.equal(r.recorder.state, 'STOP_UNCONFIRMED');
    proc.known(); proc.exit(); assert.equal(r.releaseWhenIdle(), true);
  });
});
