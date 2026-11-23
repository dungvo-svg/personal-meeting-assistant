// 0.13.0 item 4 (ENG-50): a recheck this host runs for another session yields the GPU when a meeting opens or starts listening, is
// recorded as unfinished with its range, and runs again after that meeting's stop. The recheck worker is a fake child injected through
// runtime.spawnRecheck: nothing is spawned or signalled here, and guardOsKill proves no fake PID ever reached process.kill.
import assert from 'node:assert/strict';
import { test, withFakes, openSession, until } from './fakes.mjs';
import { fakeChild, guardOsKill } from './fake_process.mjs';

const RESULT = JSON.stringify({ text: 'đã nghe lại', language: 'vi', alternatives: [], silent: false });
// A recheck worker that the test ends by hand: `finish()` prints the result and exits 0.
function recheckFactory() {
  const made = [];
  const spawn = () => { const child = fakeChild(); made.push(child); return child; };
  const finish = child => { child.stdout.emit('data', RESULT + '\n'); child.exit(0); };
  return { made, spawn, finish };
}

test('a recheck of an earlier meeting is stopped when the next meeting opens, listed as unfinished with its range, and runs again after stop', async () => {
  const guard = guardOsKill();
  try {
    await withFakes(async (r, dir) => {
      const factory = recheckFactory(); r.spawnRecheck = factory.spawn;
      const first = await openSession(r, dir, 'OTC');
      const wall = new Date(Date.now() - 20000).toISOString();
      const heard = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, 'LANG_UNSURE', 'cap', 'lo', wall, 1);
      await r.finish(first.id);

      const running = r.recheck(first.id, { sourceId: heard }); const outcome = running.then(() => 'done', error => String(error.message));
      await until(() => factory.made.length === 1, 'the recheck worker was spawned');
      assert.equal(r.heavyPending(), true);
      // The next meeting opens: the host stops the worker it spawned for the other session.
      const opening = openSession(r, dir, 'Họp thầu'); const second = r.session.id;   // prepare runs synchronously, so the stop is already sent
      assert.equal(factory.made[0].kills.length, 1, 'one stop for the recheck of the other session');
      factory.made[0].exit(null, 'SIGTERM');   // the worker really ends (the fake ignores kill until told)
      assert.match(await outcome, /^RECHECK_YIELDED: .*nhường GPU/);
      assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM rechecks').get().n, 0, 'nothing of the stopped worker is stored');
      const lines = r.ledger.unfinishedLines(first.id); assert.equal(lines.length, 1); assert.match(lines[0], /Nghe lại \d\d:\d\d:\d\d–\d\d:\d\d:\d\d \(#\d+\) của buổi "OTC" — lỗi: đã dừng giữa chừng/);
      assert.match(lines[0], /pma recheck --from/);
      assert.equal(r.heavyPending(), true, 'the host must not leave while a recheck is owed');

      // While that meeting is open, a new recheck of the other session is not started either (it would take the GPU the same way).
      await assert.rejects(r.recheck(first.id, { sourceId: heard }), /RECHECK_YIELDED: .*hoãn/);
      assert.equal(factory.made.length, 1, 'no second worker was spawned during the meeting');
      assert.equal(r.ledger.jobs.unfinished(first.id).length, 2);

      // The meeting ends: the owed rechecks run again, one after the other.
      await opening; await r.finish(second);
      await until(() => factory.made.length === 2, 'the first owed recheck runs again');
      factory.finish(factory.made[1]);
      await until(() => factory.made.length === 3, 'the second owed recheck runs');
      factory.finish(factory.made[2]);
      await until(() => !r.heavyPending(), 'nothing left to do');
      assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM rechecks WHERE session_id=?').get(first.id).n, 2);
      assert.deepEqual(r.ledger.unfinishedLines(first.id), [], 'both owed rechecks are done');
      assert.match(r.sources(first.id).find(row => row.id === heard).boundary, /RECHECKED/);
    });
  } finally { guard.restore(); }
  assert.deepEqual(guard.violations, [], 'no fake PID reached process.kill');
});

test('yieldHeavyJobs (what prepare and listen call) leaves a recheck of the live meeting itself alone and stops any other', async () => {
  const guard = guardOsKill();
  try {
    await withFakes(async (r, dir) => {
      const factory = recheckFactory(); r.spawnRecheck = factory.spawn;
      const { id } = await openSession(r, dir, 'Họp');
      const wall = new Date(Date.now() - 20000).toISOString();
      const heard = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, 'LANG_UNSURE', 'cap', 'lo', wall, 1);
      const own = r.recheck(id, { sourceId: heard }); await until(() => factory.made.length === 1, 'spawned');
      r.yieldHeavyJobs(id); assert.equal(factory.made[0].kills.length, 0, 'the live meeting\'s own recheck is not stopped');
      // The same call for any other session id does stop it (this is what `listen` does for the meeting it starts).
      const other = '00000000-0000-4000-8000-000000000000';
      r.yieldHeavyJobs(other); assert.equal(factory.made[0].kills.length, 1);
      factory.made[0].exit(null, 'SIGTERM'); await assert.rejects(own, /RECHECK_YIELDED/);
    });
  } finally { guard.restore(); }
  assert.deepEqual(guard.violations, []);
});

test('a worker that ignores the stop keeps the host from leaving and the range stays owed: only a real exit settles it', async () => {
  await withFakes(async (r, dir) => {
    const factory = recheckFactory(); r.spawnRecheck = factory.spawn;
    const first = await openSession(r, dir, 'OTC'); const wall = new Date(Date.now() - 20000).toISOString();
    const heard = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, '', 'cap', 'lo', wall, 1); await r.finish(first.id);
    const running = r.recheck(first.id, { sourceId: heard }).catch(error => String(error.message));
    await until(() => factory.made.length === 1, 'spawned'); const opening = openSession(r, dir, 'Họp mới');
    assert.equal(r.rechecking, 1, 'still counted: the machine lock is kept while the worker is alive');
    assert.equal(r.ledger.unfinishedLines(first.id).length, 0, 'nothing is claimed as stopped before it really exited');
    factory.made[0].exit(null, 'SIGKILL'); assert.match(await running, /RECHECK_YIELDED/);
    assert.equal(r.ledger.unfinishedLines(first.id).length, 1); await opening;
  });
});
