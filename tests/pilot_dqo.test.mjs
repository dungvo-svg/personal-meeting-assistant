// Synthetic pilot, the Dũng–Quân–Oanh case (owner 03/11: the meeting tool facilitates; decisions made in real time with the two most
// senior people are set up at once). Scripted rows in a test-mode runtime in this process: no host, no child process, no audio, no
// model, no network. It is the host-side contract the central session relies on, NOT native central-agent E2E and NOT a real meeting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'pma-pilot-dqo-'));
  const r = new MeetingRuntime(resolve('.'), directory, true); r.mixer = () => {};
  try { await fn(r); } finally { await r.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
const say = (r, text) => r.ingest(text, 'synthetic_fixture');

test('pilot D–Q–O: authority from the owner only; a proposal waits for the right person; a decision becomes actions; a change blocks the open action; questions and jobs stay answerable; the end reports everything', async () => {
  await withRuntime(async r => {
    r.prepare('Thiết lập quy trình thầu (thử)', true); const id = r.session.id;
    // The owner, in chat, gives authority (never read from the transcript): Quân for pricing, Oanh for everything.
    r.decisions.grant(id, 'Quân', 'giá', 'owner', 'chủ nói trong chat: Quân chốt phần giá');
    r.decisions.grant(id, 'Oanh', '*', 'owner', 'chủ nói trong chat: Oanh chốt mọi phần');
    const s1 = say(r, 'Phet: em đề xuất gửi báo giá trước thứ Sáu.');
    const s2 = say(r, 'Quân: chốt, gửi báo giá trước thứ Sáu.');
    const s3 = say(r, 'Oanh: đổi lại, gửi trước thứ Năm.');
    // A proposal from someone without authority is recorded, not decided; one owner question for the right person.
    const p = r.decisions.propose(id, 'Gửi báo giá trước thứ Sáu', [s1]);
    const byPhet = r.decide(id, p, 'Phet', [s1], { scope: 'giá' });
    assert.equal(byPhet.decided, false); assert.ok(byPhet.park.who.includes('Quân') && byPhet.park.who.includes('Oanh')); assert.ok(byPhet.question > 0);
    assert.equal(r.ledger.questions.open(id).length, 1);
    // Quân decides within his scope, with the row that says so; an action follows.
    const byQuan = r.decide(id, p, 'Quân', [s2], { scope: 'giá' }); assert.equal(byQuan.decided, true);
    const act = r.decisions.plan(p, 'Tạo việc gửi báo giá, hạn thứ Sáu');
    // A long analysis runs in the background meanwhile; the central session can still answer.
    const job = r.ledger.jobs.start(id, 'analysis', 'So sánh giá 5 gói');
    const now = r.decisions.summaryOf(id); assert.equal(now.decided, 1);
    assert.equal(r.ledger.summaryOf(id).jobs.running, 1, 'the foreground read does not wait for the job');
    // Oanh changes the decision: the old one is superseded and its open action blocked for review.
    const change = r.decide(id, p, 'Oanh', [s3], { change: 'Gửi báo giá trước thứ Năm' }); assert.equal(change.decided, true);
    assert.equal(r.decisions.get(p).status, 'superseded'); assert.equal(r.decisions.getAction(act).status, 'blocked');
    const act2 = r.decisions.plan(change.id, 'Tạo việc gửi báo giá, hạn thứ Năm'); r.decisions.done(act2, 'Đã tạo việc, hạn thứ Năm');
    assert.deepEqual(r.decisions.chain(change.id).map(d => d.id), [p, change.id]);
    // Nobody answered the question; silence never decides anything. The end: the job is stopped, the question parked, all reported.
    const done = await r.finish(id);
    assert.equal(r.ledger.jobs.get(job).status, 'cancelled'); assert.equal(r.ledger.questions.open(id).length, 0); assert.equal(r.ledger.questions.parked(id).length, 1);
    assert.ok(done.unfinished.some(line => line.includes('So sánh giá 5 gói')));
    const report = done.decisions.join('\n');
    assert.match(report, /Gửi báo giá trước thứ Năm/); assert.match(report, new RegExp(`#${s3}`));
  });
});
