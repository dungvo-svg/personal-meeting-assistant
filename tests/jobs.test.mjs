// Jobs, owner questions and degraded conditions (0.12.1, docs/EXCEPTIONS_0_12.md): the host's durable "what is still running /
// pending" record. In-memory database and a fake clock: no files, no spawn, no network, no real timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CANCEL_NOTE, Ledger } from '../dist/jobs.js';

const MIN = 60_000;
function make() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: minutes => { t += minutes * MIN; } };
  const db = new DatabaseSync(':memory:');
  return { db, clock, ledger: new Ledger(db, clock.now) };
}

test('job lifecycle: start -> running, finish -> done with result and sources; the same finish again is a no-op', () => {
  const { ledger, clock } = make();
  const id = ledger.jobs.start('s1', 'analysis', 'So sánh hai báo giá');
  assert.equal(ledger.jobs.get(id).status, 'running');
  clock.advance(3);
  assert.equal(ledger.jobs.finish(id, 'Kết quả A', [7, 3, 7]), true);
  const done = ledger.jobs.get(id);
  assert.equal(done.status, 'done'); assert.equal(done.result, 'Kết quả A'); assert.deepEqual(done.sourceIds, [3, 7]);
  const stamp = done.updated;
  clock.advance(1);
  assert.equal(ledger.jobs.finish(id, 'Kết quả A', [3, 7]), false, 'same result again changes nothing');
  assert.equal(ledger.jobs.get(id).updated, stamp);
  assert.throws(() => ledger.jobs.finish(id, 'Kết quả khác'), /JOB_NOT_RUNNING/, 'a different result for a closed job is refused, the first stays');
  assert.equal(ledger.jobs.get(id).result, 'Kết quả A');
  assert.throws(() => ledger.jobs.finish(999, 'x'), /JOB_NOT_FOUND/);
  assert.throws(() => ledger.jobs.start('s1', 'bogus', 'x'), /INVALID_JOB_KIND/);
  assert.throws(() => ledger.jobs.start('s1', 'other', '  '), /INVALID_JOB_TITLE/);
  assert.throws(() => ledger.jobs.finish(ledger.jobs.start('s1', 'other', 'y'), 'r', [0]), /INVALID_SOURCE_IDS/);
});

test('fail: only a running job fails, with its note; list filters by status and keeps history', () => {
  const { ledger } = make();
  const a = ledger.jobs.start('s1', 'translation', 'Dịch lô 1'), b = ledger.jobs.start('s1', 'other', 'Việc khác');
  assert.equal(ledger.jobs.fail(a, 'Hết hạn mức'), true);
  assert.equal(ledger.jobs.fail(a, 'lần hai'), false, 'a closed job is not failed again');
  assert.equal(ledger.jobs.get(a).note, 'Hết hạn mức');
  assert.deepEqual(ledger.jobs.list('s1').map(j => j.id), [a, b], 'nothing is deleted');
  assert.deepEqual(ledger.jobs.list('s1', { status: 'running' }).map(j => j.id), [b]);
  assert.deepEqual(ledger.jobs.list('s1', { status: 'failed' }).map(j => j.id), [a]);
  assert.deepEqual(ledger.jobs.list('other-session'), []);
});

test('cancelRunning at stop returns exactly the running jobs of that session; done/failed and other sessions are untouched', () => {
  const { ledger, clock } = make();
  const running1 = ledger.jobs.start('s1', 'analysis', 'Phân tích dài');
  const done = ledger.jobs.start('s1', 'analysis', 'Đã xong'); ledger.jobs.finish(done, 'ok', [1]);
  const failed = ledger.jobs.start('s1', 'translation', 'Đã lỗi'); ledger.jobs.fail(failed, 'lỗi');
  const running2 = ledger.jobs.start('s1', 'translation', 'Dịch tiếp');
  const elsewhere = ledger.jobs.start('s2', 'analysis', 'Phiên khác');
  clock.advance(5);
  const cancelled = ledger.jobs.cancelRunning('s1');
  assert.deepEqual(cancelled.map(j => j.id), [running1, running2]);
  assert.ok(cancelled.every(j => j.status === 'cancelled' && j.note === CANCEL_NOTE));
  assert.equal(CANCEL_NOTE, 'Dừng khi kết thúc họp');
  assert.equal(ledger.jobs.get(done).status, 'done'); assert.equal(ledger.jobs.get(failed).status, 'failed'); assert.equal(ledger.jobs.get(elsewhere).status, 'running');
  assert.deepEqual(ledger.jobs.cancelRunning('s1'), [], 'a second stop finds nothing running');
  assert.throws(() => ledger.jobs.finish(running1, 'muộn'), /JOB_NOT_RUNNING/, 'a cancelled job does not come back to life');
  // "Chưa làm xong": the cancelled and the failed ones, not the done one and not the other session's.
  assert.deepEqual(ledger.jobs.unfinished('s1').map(j => j.id), [running1, failed, running2]);
  const lines = ledger.unfinishedLines('s1');
  assert.equal(lines.length, 3); assert.match(lines[0], /Phân tích dài.*đã dừng: Dừng khi kết thúc họp/);
});

test('question: asked -> no reminder before the ttl, ONE reminder after it, never a second', () => {
  const { ledger, clock } = make();
  const q = ledger.questions.ask('s1', 'Chốt giá 120 hay 125?', [11, 12], 10);
  clock.advance(9);
  assert.deepEqual(ledger.questions.due('s1'), [], 'not yet 10 minutes');
  clock.advance(1);
  const due = ledger.questions.due('s1');
  assert.deepEqual(due.map(x => x.id), [q]); assert.deepEqual(due[0].sourceIds, [11, 12]); assert.notEqual(due[0].reminded, null);
  assert.deepEqual(ledger.questions.due('s1'), [], 'reminded exactly once');
  clock.advance(5);
  assert.deepEqual(ledger.questions.due('s1'), [], 'still once, however long we wait');
  assert.equal(ledger.questions.get(q).status, 'open');
  assert.deepEqual(ledger.questions.open('s1').map(x => x.id), [q]);
});

test('question: parked after expiry with its provenance; silence is never an answer; a late real answer still closes it', () => {
  const { ledger, clock } = make();
  const q = ledger.questions.ask('s1', 'Ai phụ trách việc này?', [5], 10);
  clock.advance(10); ledger.questions.due('s1');
  clock.advance(9);
  assert.deepEqual(ledger.questions.park('s1'), [], 'inside the grace window it is still open');
  clock.advance(1);
  const parked = ledger.questions.park('s1');
  assert.deepEqual(parked.map(x => x.id), [q]); assert.equal(parked[0].status, 'parked'); assert.deepEqual(parked[0].sourceIds, [5]);
  assert.equal(parked[0].answer, null, 'parked has no answer');
  assert.deepEqual(ledger.questions.open('s1'), []); assert.deepEqual(ledger.questions.parked('s1').map(x => x.id), [q]);
  assert.deepEqual(ledger.questions.park('s1'), [], 'parking twice parks nothing new');
  assert.deepEqual(ledger.questions.due('s1'), [], 'a parked question is not reminded');
  assert.equal(ledger.summaryOf('s1').questions.parked, 1);
  assert.match(ledger.unfinishedLines('s1')[0], /Câu hỏi chưa được trả lời: Ai phụ trách việc này\? \(nguồn #5\)/);
  assert.equal(ledger.questions.answer(q, 'Anh Nam'), true, 'the owner may answer later');
  const closed = ledger.questions.get(q); assert.equal(closed.status, 'answered'); assert.equal(closed.answer, 'Anh Nam');
  assert.equal(ledger.questions.answer(q, 'Anh Hùng'), false, 'the first answer stays'); assert.equal(ledger.questions.get(q).answer, 'Anh Nam');
  assert.deepEqual(ledger.unfinishedLines('s1'), []);
});

test('question: an answer closes an open one so it is never reminded or parked; park({all}) at the end parks what is still open', () => {
  const { ledger, clock } = make();
  const a = ledger.questions.ask('s1', 'Câu A?'), b = ledger.questions.ask('s1', 'Câu B?', [2]), c = ledger.questions.ask('s2', 'Phiên khác?');
  assert.equal(ledger.questions.answer(a, 'Có'), true);
  clock.advance(30);
  assert.deepEqual(ledger.questions.due('s1').map(x => x.id), [b], 'only the unanswered one is reminded');
  assert.deepEqual(ledger.questions.park('s1').map(x => x.id), [b]);
  const d = ledger.questions.ask('s1', 'Câu D?');
  assert.deepEqual(ledger.questions.park('s1', { all: true }).map(x => x.id), [d], 'at stop, still-open becomes parked whatever its clock');
  assert.equal(ledger.questions.get(a).status, 'answered'); assert.equal(ledger.questions.get(c).status, 'open', 'another session is untouched');
});

test('degraded: mark reports once per episode; repeats are false; clear keeps the row; it can be reported again after recovery', () => {
  const { ledger, clock } = make();
  assert.equal(ledger.degraded.mark('s1', 'save-denied', 'Không lưu được bản dịch'), true);
  clock.advance(2);
  assert.equal(ledger.degraded.mark('s1', 'save-denied', 'Vẫn không lưu được'), false, 'report once');
  assert.equal(ledger.degraded.list('s1')[0].detail, 'Không lưu được bản dịch', 'the first detail is kept');
  assert.equal(ledger.degraded.mark('s1', 'listener-stalled', 'Bộ nghe đứng'), true, 'another kind is its own report');
  assert.equal(ledger.degraded.mark('s2', 'save-denied', 'phiên khác'), true, 'per session');
  assert.deepEqual(ledger.degraded.list('s1').map(d => d.kind).sort(), ['listener-stalled', 'save-denied']);
  assert.equal(ledger.degraded.clear('s1', 'save-denied'), true);
  assert.equal(ledger.degraded.clear('s1', 'save-denied'), false, 'already cleared');
  assert.equal(ledger.degraded.clear('s1', 'never-marked'), false);
  assert.deepEqual(ledger.degraded.list('s1').map(d => d.kind), ['listener-stalled']);
  assert.equal(ledger.degraded.list('s1', { all: true }).length, 2, 'history is kept');
  assert.equal(ledger.degraded.mark('s1', 'save-denied', 'Lại không lưu được'), true, 'a new episode is reported again');
  assert.equal(ledger.degraded.list('s1').find(d => d.kind === 'save-denied').detail, 'Lại không lưu được');
});

test('summaryOf counts jobs by status, open/parked questions, and the active degraded kinds', () => {
  const { ledger, clock } = make();
  const j1 = ledger.jobs.start('s1', 'analysis', 'a'), j2 = ledger.jobs.start('s1', 'analysis', 'b'), j3 = ledger.jobs.start('s1', 'other', 'c'), j4 = ledger.jobs.start('s1', 'other', 'd');
  ledger.jobs.finish(j1, 'ok'); ledger.jobs.fail(j2, 'lỗi'); ledger.jobs.cancelRunning('s1'); const j5 = ledger.jobs.start('s1', 'other', 'e');
  assert.deepEqual(ledger.summaryOf('s1').jobs, { running: 1, done: 1, failed: 1, cancelled: 2 });
  assert.ok(j3 && j4 && j5);
  ledger.questions.ask('s1', 'Mở 1?'); ledger.questions.ask('s1', 'Mở 2?', [], 5);
  clock.advance(10); ledger.questions.park('s1');
  ledger.questions.ask('s1', 'Mở 3?');
  assert.deepEqual(ledger.summaryOf('s1').questions, { open: 2, parked: 1 });
  ledger.degraded.mark('s1', 'recorder', 'x'); ledger.degraded.mark('s1', 'asr', 'y'); ledger.degraded.clear('s1', 'recorder');
  assert.deepEqual(ledger.summaryOf('s1').degraded, ['asr']);
  assert.deepEqual(ledger.summaryOf('empty'), { jobs: { running: 0, done: 0, failed: 0, cancelled: 0 }, questions: { open: 0, parked: 0 }, degraded: [] });
});

test('a second Ledger on the same database reuses the tables (CREATE IF NOT EXISTS) and sees the same rows', () => {
  const { db, ledger, clock } = make();
  const id = ledger.jobs.start('s1', 'analysis', 'bền');
  const again = new Ledger(db, clock.now);
  assert.equal(again.jobs.get(id).title, 'bền');
});
