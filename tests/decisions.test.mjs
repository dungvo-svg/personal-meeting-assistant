// Decision -> action -> result/rollback ledger (src/decisions.ts): proposal vs decision by someone the OWNER gave authority to,
// supersession, parking instead of guessing. In-memory database and a fake clock: no files, no spawn, no network, no real timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DecisionLedger } from '../dist/decisions.js';

const MIN = 60_000;
function make() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: minutes => { t += minutes * MIN; } };
  const db = new DatabaseSync(':memory:');
  return { db, clock, ledger: new DecisionLedger(db, clock.now) };
}
// A decision that is clearly made: Hùng holds '*' (given by the owner), decides with evidence.
function decidedBy(ledger, session, body, sources = [1]) {
  ledger.grant(session, 'Hùng', '*', 'Dũng', 'owner nói trong chat');
  const id = ledger.propose(session, body, sources);
  assert.equal(ledger.decide(id, 'Hùng', sources).decided, true);
  return id;
}

test('decision by someone with granted authority becomes decided, with evidence and who decided', () => {
  const { ledger, clock } = make();
  assert.equal(ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói: anh Hùng chốt được mọi việc hôm nay'), true);
  const id = ledger.propose('s1', 'Giao hàng thứ Sáu', [7]);
  assert.equal(ledger.get(id).status, 'proposed');
  assert.equal(ledger.get(id).authority, 'unknown');
  clock.advance(2);
  const r = ledger.decide(id, 'hùng', [8]);
  assert.deepEqual({ ...r }, { id, decided: true, authority: 'granted' });
  const d = ledger.get(id);
  assert.equal(d.status, 'decided');
  assert.equal(d.decidedBy, 'hùng');
  assert.equal(d.authority, 'granted');
  assert.deepEqual(d.sourceIds, [7, 8]);
  assert.equal(d.updated - d.created, 2 * MIN);
});

test('decision by someone without authority stays proposed and returns park info naming who could decide', () => {
  const { ledger } = make();
  ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói');
  const id = ledger.propose('s1', 'Đổi nhà cung cấp', [3]);
  const r = ledger.decide(id, 'Lan', [4]);
  assert.equal(r.decided, false);
  assert.equal(r.authority, 'not_granted');
  assert.deepEqual(r.park.who, ['Hùng']);
  assert.match(r.park.why, /Lan/);
  assert.match(r.park.why, /Hùng/);
  const d = ledger.get(id);
  assert.equal(d.status, 'proposed');
  assert.equal(d.authority, 'not_granted');
  assert.equal(d.decidedBy, null);
  assert.deepEqual(d.sourceIds, [3, 4]);
  // The person with authority can still confirm it later.
  assert.equal(ledger.decide(id, 'Hùng', [5]).decided, true);
  assert.equal(ledger.get(id).decidedBy, 'Hùng');
});

test('no authority list at all: authority unknown, stays proposed, park points at the owner', () => {
  const { ledger } = make();
  const id = ledger.propose('s1', 'Tăng giá 3%', [2]);
  const r = ledger.decide(id, 'Hùng', [2]);
  assert.equal(r.decided, false);
  assert.equal(r.authority, 'unknown');
  assert.deepEqual(r.park.who, []);
  assert.match(r.park.why, /owner/);
  assert.equal(ledger.get(id).status, 'proposed');
  assert.equal(ledger.get(id).authority, 'unknown');
});

test('a decision needs evidence: no source ids, or invalid ones, are refused', () => {
  const { ledger } = make();
  ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói');
  const id = ledger.propose('s1', 'Chốt lịch', []);
  assert.throws(() => ledger.decide(id, 'Hùng', []), /EVIDENCE_REQUIRED/);
  assert.throws(() => ledger.decide(id, 'Hùng', [0]), /INVALID_SOURCE_IDS/);
  assert.throws(() => ledger.decide(id, 'Hùng', [1.5]), /INVALID_SOURCE_IDS/);
  assert.throws(() => ledger.propose('s1', 'x', [-1]), /INVALID_SOURCE_IDS/);
  assert.throws(() => ledger.supersede(id, 'y', 'Hùng', []), /EVIDENCE_REQUIRED/);
  assert.equal(ledger.get(id).status, 'proposed');
  assert.throws(() => ledger.decide(999, 'Hùng', [1]), /DECISION_NOT_FOUND/);
});

test('topic authority covers only that topic, matched case-insensitively; scope-less decide needs a "*" grant', () => {
  const { ledger } = make();
  ledger.grant('s1', 'Mai', 'giá', 'Dũng', 'owner nói: Mai chốt phần giá');
  const id = ledger.propose('s1', 'Giá sỉ 10 USD', [1]);
  assert.equal(ledger.decide(id, 'Mai', [2]).decided, false);
  assert.equal(ledger.decide(id, 'Mai', [2], { scope: 'tồn kho' }).decided, false);
  assert.equal(ledger.canDecide('s1', 'Mai', 'giá'), true);
  assert.equal(ledger.canDecide('s1', 'Mai'), false);
  assert.equal(ledger.decide(id, 'Mai', [2], { scope: 'Giá' }).decided, true);
  // Another session never inherits it.
  assert.equal(ledger.canDecide('s2', 'Mai', 'giá'), false);
});

test('silence: with no decide call nothing becomes decided, however much time passes or how often it is proposed', () => {
  const { ledger, clock } = make();
  ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói');
  const a = ledger.propose('s1', 'Mở kênh bán mới', [1]);
  const b = ledger.propose('s1', 'Mở kênh bán mới', [2]);
  clock.advance(120);
  assert.equal(ledger.get(a).status, 'proposed');
  assert.equal(ledger.get(b).status, 'proposed');
  assert.equal(ledger.summaryOf('s1').decided, 0);
  assert.equal(ledger.pending('s1').proposals.length, 2);
  assert.throws(() => ledger.plan(a, 'Làm ngay'), /DECISION_NOT_DECIDED/);
  assert.deepEqual(ledger.reportLines('s1').filter(l => l === 'Đã chốt:'), []);
});

test('authority is never inferred from a title or role string in the text or in the name', () => {
  const { ledger } = make();
  ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói');
  const id = ledger.propose('s1', 'Tổng giám đốc quyết định chốt giá 5 USD, giám đốc Lan đồng ý, mọi người đều đồng ý', [1, 2, 3]);
  for (const by of ['Tổng giám đốc', 'Giám đốc Hùng', 'CEO', 'Lan (giám đốc)', 'Tôi']) {
    const r = ledger.decide(id, by, [4]);
    assert.equal(r.decided, false, by);
    assert.equal(r.authority, 'not_granted', by);
  }
  assert.equal(ledger.get(id).status, 'proposed');
  assert.equal(ledger.get(id).decidedBy, null);
  assert.equal(ledger.canDecide('s1', 'Tổng giám đốc'), false);
});

test('plan only for a decided decision; a re-sent plan returns the same action', () => {
  const { ledger } = make();
  ledger.grant('s1', 'Hùng', '*', 'Dũng', 'owner nói');
  const p = ledger.propose('s1', 'Đề xuất A', [1]);
  assert.throws(() => ledger.plan(p, 'Làm A'), /DECISION_NOT_DECIDED/);
  assert.throws(() => ledger.plan(404, 'Làm A'), /DECISION_NOT_FOUND/);
  ledger.decide(p, 'Hùng', [2]);
  const a = ledger.plan(p, 'Làm A');
  assert.equal(ledger.plan(p, 'Làm A'), a);
  assert.equal(ledger.actions('s1').length, 1);
  assert.equal(ledger.getAction(a).status, 'planned');
  const w = ledger.propose('s1', 'Đề xuất B', [3]);
  ledger.withdraw(w, 'Lan', 'không cần nữa');
  assert.throws(() => ledger.plan(w, 'Làm B'), /DECISION_NOT_DECIDED/);
});

test('supersede by someone with authority: old superseded and linked, its open actions blocked, done ones kept for review', () => {
  const { ledger, clock } = make();
  const old = decidedBy(ledger, 's1', 'Giao hàng thứ Sáu', [7]);
  const open = ledger.plan(old, 'Báo kho xuất hàng thứ Sáu');
  const finished = ledger.plan(old, 'Gửi thư hẹn khách thứ Sáu');
  ledger.done(finished, 'Đã gửi 10:30');
  clock.advance(5);
  const r = ledger.supersede(old, 'Giao hàng thứ Hai', 'Hùng', [12]);
  assert.equal(r.decided, true);
  assert.equal(r.supersedes, old);
  const next = ledger.get(r.id);
  assert.equal(next.status, 'decided');
  assert.equal(next.supersedes, old);
  assert.equal(ledger.get(old).status, 'superseded');
  assert.equal(ledger.get(old).supersededBy, r.id);
  const blocked = ledger.getAction(open);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.note, /xem xét/);
  assert.equal(ledger.getAction(finished).status, 'done');
  // Never silently kept: the old decision no longer shows as pending, the new one needs actions.
  assert.deepEqual(ledger.pending('s1').decided.map(x => x.decision.id), [r.id]);
  assert.ok(ledger.reportLines('s1').some(l => l.includes('Gửi thư hẹn khách thứ Sáu') && l.includes('cần xem xét hoàn tác')));
  // Nothing was deleted.
  assert.equal(ledger.list('s1').length, 2);
  assert.equal(ledger.actions('s1').length, 2);
  // Changing it again extends the chain.
  const third = ledger.supersede(r.id, 'Giao hàng thứ Ba', 'Hùng', [15]);
  assert.deepEqual(ledger.chain(old).map(d => d.id), [old, r.id, third.id]);
  assert.deepEqual(ledger.chain(third.id).map(d => d.id), [old, r.id, third.id]);
  assert.deepEqual(ledger.chain(r.id).map(d => d.status), ['superseded', 'superseded', 'decided']);
});

test('supersede by someone without authority only proposes: the old decision stays in force until an authorised person confirms', () => {
  const { ledger } = make();
  const old = decidedBy(ledger, 's1', 'Giá sỉ 10 USD', [7]);
  const act = ledger.plan(old, 'Cập nhật bảng giá');
  const r = ledger.supersede(old, 'Giá sỉ 9 USD', 'Lan', [9]);
  assert.equal(r.decided, false);
  assert.equal(r.authority, 'not_granted');
  assert.deepEqual(r.park.who, ['Hùng']);
  assert.equal(ledger.get(r.id).status, 'proposed');
  assert.equal(ledger.get(r.id).supersedes, old);
  assert.equal(ledger.get(old).status, 'decided');
  assert.equal(ledger.get(old).supersededBy, null);
  assert.match(ledger.get(old).note, new RegExp('QĐ' + r.id));
  assert.equal(ledger.getAction(act).status, 'planned');
  assert.deepEqual(ledger.chain(old).map(d => d.id), [old, r.id]);
  assert.deepEqual(ledger.pending('s1').proposals.map(d => d.id), [r.id]);
  // The authorised person confirms the replacement: now the old one is superseded and its action blocked.
  assert.equal(ledger.decide(r.id, 'Hùng', [10]).decided, true);
  assert.equal(ledger.get(old).status, 'superseded');
  assert.equal(ledger.get(old).supersededBy, r.id);
  assert.equal(ledger.getAction(act).status, 'blocked');
  assert.deepEqual(ledger.chain(r.id).map(d => d.id), [old, r.id]);
});

test('supersede re-sent with the same text makes no duplicate; a closed decision cannot be superseded', () => {
  const { ledger } = make();
  const old = decidedBy(ledger, 's1', 'Họp lúc 9h', [1]);
  const first = ledger.supersede(old, 'Họp lúc 10h', 'Hùng', [2]);
  const again = ledger.supersede(old, 'Họp lúc 10h', 'Hùng', [2]);
  assert.equal(again.id, first.id);
  assert.equal(again.decided, true);
  assert.equal(ledger.list('s1').length, 2);
  assert.throws(() => ledger.supersede(old, 'Họp lúc 11h', 'Hùng', [3]), /DECISION_CLOSED/);
  assert.throws(() => ledger.supersede(404, 'z', 'Hùng', [3]), /DECISION_NOT_FOUND/);
});

test('done / fail / rollback are recorded, idempotent on the same text, and refuse to overwrite a different first record', () => {
  const { ledger, clock } = make();
  const d = decidedBy(ledger, 's1', 'Đặt hàng 50 thùng', [1]);
  const a = ledger.plan(d, 'Gửi đơn cho nhà cung cấp');
  clock.advance(1);
  assert.equal(ledger.done(a, 'Đơn PO-12 đã gửi'), true);
  assert.equal(ledger.done(a, 'Đơn PO-12 đã gửi'), false);
  assert.throws(() => ledger.done(a, 'Kết quả khác'), /ACTION_NOT_OPEN/);
  assert.equal(ledger.getAction(a).result, 'Đơn PO-12 đã gửi');
  assert.throws(() => ledger.fail(a, 'lỗi muộn'), /ACTION_NOT_OPEN/);
  assert.equal(ledger.rollback(a, 'Huỷ đơn PO-12 qua email'), true);
  assert.equal(ledger.rollback(a, 'Huỷ đơn PO-12 qua email'), false);
  assert.throws(() => ledger.rollback(a, 'cách khác'), /ACTION_NOT_DONE/);
  const done = ledger.getAction(a);
  assert.equal(done.status, 'rolled_back');
  assert.equal(done.rollback, 'Huỷ đơn PO-12 qua email');
  assert.equal(done.result, 'Đơn PO-12 đã gửi');

  const b = ledger.plan(d, 'Báo kế toán');
  assert.throws(() => ledger.rollback(b, 'chưa làm gì'), /ACTION_NOT_DONE/);
  assert.equal(ledger.fail(b, 'Kế toán nghỉ phép'), true);
  assert.equal(ledger.fail(b, 'Kế toán nghỉ phép'), false);
  assert.equal(ledger.getAction(b).status, 'failed');
  assert.equal(ledger.getAction(b).note, 'Kế toán nghỉ phép');
  // A failed action can be retried (done) or undone if it applied half-way.
  assert.equal(ledger.rollback(b, 'Không cần hoàn tác, chưa ghi sổ'), true);
  assert.throws(() => ledger.done(999, 'x'), /ACTION_NOT_FOUND/);
});

test('withdraw: a proposal by anyone; a decided one only by authority (else parked); planned actions get blocked; repeat is a no-op', () => {
  const { ledger } = make();
  const p = ledger.propose('s1', 'Ý kiến thử', [1]);
  assert.equal(ledger.withdraw(p, 'Lan', 'tôi rút ý này').withdrawn, true);
  assert.equal(ledger.withdraw(p, 'Lan', 'tôi rút ý này').withdrawn, true);
  assert.equal(ledger.get(p).status, 'withdrawn');

  const d = decidedBy(ledger, 's1', 'Khuyến mãi tháng 11', [2]);
  const a = ledger.plan(d, 'Đăng thông báo khuyến mãi');
  const no = ledger.withdraw(d, 'Lan', 'không đồng ý');
  assert.equal(no.withdrawn, false);
  assert.deepEqual(no.park.who, ['Hùng']);
  assert.equal(ledger.get(d).status, 'decided');
  assert.equal(ledger.getAction(a).status, 'planned');
  assert.equal(ledger.withdraw(d, 'Hùng', 'hoãn khuyến mãi').withdrawn, true);
  assert.equal(ledger.get(d).status, 'withdrawn');
  assert.match(ledger.get(d).note, /hoãn khuyến mãi/);
  assert.equal(ledger.getAction(a).status, 'blocked');
  assert.throws(() => ledger.decide(d, 'Hùng', [3]), /DECISION_CLOSED/);
  assert.equal(ledger.list('s1').length, 2);
});

test('pending: decided decisions without finished actions and every proposal; finished ones drop off', () => {
  const { ledger } = make();
  const d1 = decidedBy(ledger, 's1', 'Việc một', [1]);
  const d2 = decidedBy(ledger, 's1', 'Việc hai', [2]);
  const d3 = decidedBy(ledger, 's1', 'Việc ba', [3]);
  const p = ledger.propose('s1', 'Chờ duyệt', [4]);
  const a1 = ledger.plan(d1, 'Làm một');
  const a2 = ledger.plan(d2, 'Làm hai');
  const a3 = ledger.plan(d3, 'Làm ba');
  ledger.done(a1, 'xong');
  ledger.fail(a2, 'lỗi');
  ledger.done(a3, 'xong'); ledger.rollback(a3, 'đã hoàn tác');
  const pend = ledger.pending('s1');
  assert.deepEqual(pend.decided.map(x => x.decision.id), [d2]);
  assert.deepEqual(pend.decided[0].actions.map(a => a.status), ['failed']);
  assert.deepEqual(pend.proposals.map(x => x.id), [p]);
  // A decided decision with no action yet is pending too.
  const d4 = decidedBy(ledger, 's1', 'Việc bốn', [5]);
  assert.deepEqual(ledger.pending('s1').decided.map(x => x.decision.id), [d2, d4]);
});

test('summaryOf counts decisions and actions per status', () => {
  const { ledger } = make();
  const a = decidedBy(ledger, 's1', 'Giá A', [1]);
  const act1 = ledger.plan(a, 'Việc 1');
  const act2 = ledger.plan(a, 'Việc 2');
  const act3 = ledger.plan(a, 'Việc 3');
  ledger.done(act1, 'ok');
  ledger.fail(act2, 'hỏng');
  const sup = ledger.supersede(a, 'Giá B', 'Hùng', [2]);
  ledger.propose('s1', 'Còn bàn', [3]);
  ledger.propose('s1', 'Rút', [4]);
  ledger.withdraw(ledger.list('s1', { status: 'proposed' })[1].id, 'Lan', 'bỏ');
  assert.ok(sup.id);
  assert.deepEqual(ledger.summaryOf('s1'), { decided: 1, proposed: 1, superseded: 1, withdrawn: 1, actions: { planned: 0, done: 1, failed: 1, rolled_back: 0, blocked: 1 } });
  assert.equal(ledger.getAction(act3).status, 'blocked');
  assert.deepEqual(ledger.summaryOf('empty'), { decided: 0, proposed: 0, superseded: 0, withdrawn: 0, actions: { planned: 0, done: 0, failed: 0, rolled_back: 0, blocked: 0 } });
});

test('reportLines: Vietnamese groups, each line with its sources; empty groups and empty sessions give nothing', () => {
  const { ledger } = make();
  assert.deepEqual(ledger.reportLines('none'), []);
  const d1 = decidedBy(ledger, 's1', 'Giao hàng thứ Sáu', [7]);
  ledger.decide(d1, 'Hùng', [8]);
  const a1 = ledger.plan(d1, 'Báo kho xuất hàng');
  ledger.done(a1, 'Kho xác nhận');
  const a2 = ledger.plan(d1, 'Gửi thư khách');
  ledger.done(a2, 'Đã gửi'); ledger.rollback(a2, 'Gửi thư đính chính');
  const d2 = ledger.propose('s1', 'Giảm giá 5%', [9]);
  const a3 = ledger.plan(d1, 'In phiếu giao');
  const lines = ledger.reportLines('s1');
  assert.ok(lines.includes('Đã chốt:'));
  assert.ok(lines.includes('- QĐ1 Giao hàng thứ Sáu — Hùng chốt (nguồn #7)'));
  assert.ok(lines.includes('Đề xuất chờ người có thẩm quyền:'));
  assert.ok(lines.includes('- QĐ' + d2 + ' Giảm giá 5% — chờ Hùng chốt (nguồn #9)'));
  assert.ok(lines.includes('Việc đã làm / bị chặn / đã hoàn tác:'));
  assert.ok(lines.includes('- [đã làm] V' + a1 + ' Báo kho xuất hàng — kết quả: Kho xác nhận · QĐ1 (nguồn #7)'));
  assert.ok(lines.includes('- [đã hoàn tác] V' + a2 + ' Gửi thư khách — kết quả: Đã gửi; hoàn tác: Gửi thư đính chính · QĐ1 (nguồn #7)'));
  assert.ok(lines.includes('Việc chưa xong (đã lên kế hoạch / lỗi):'));
  assert.ok(lines.includes('- [chưa làm] V' + a3 + ' In phiếu giao · QĐ1 (nguồn #7)'));
  // After a change: blocked and superseded appear.
  const next = ledger.supersede(d1, 'Giao hàng thứ Hai', 'Hùng', [12]);
  const after = ledger.reportLines('s1');
  assert.ok(after.includes('Đã bị thay thế hoặc rút:'));
  assert.ok(after.includes('- QĐ1 Giao hàng thứ Sáu — đã bị thay bằng QĐ' + next.id + ' (nguồn #7)'));
  assert.ok(after.some(l => l.startsWith('- [bị chặn] V' + a3 + ' In phiếu giao')));
  assert.ok(after.every(l => !l.startsWith('- [chưa làm]')));
  // Without anyone given authority the proposal line says to ask the owner.
  const fresh = make().ledger;
  fresh.propose('s2', 'Mua xe', [3]);
  assert.ok(fresh.reportLines('s2').includes('- QĐ1 Mua xe — chưa ai được owner giao thẩm quyền, cần hỏi owner (nguồn #3)'));
});

test('grant: idempotent (first record kept), validated, per session; sessions do not see each other', () => {
  const { ledger, clock } = make();
  assert.equal(ledger.grant('s1', 'Hùng', '*', 'Dũng', 'lần một'), true);
  clock.advance(1);
  assert.equal(ledger.grant('s1', 'Hùng', '*', 'Người khác', 'lần hai'), false);
  const g = ledger.grants('s1');
  assert.equal(g.length, 1);
  assert.equal(g[0].grantedBy, 'Dũng');
  assert.equal(g[0].source, 'lần một');
  assert.throws(() => ledger.grant('s1', '', '*', 'Dũng', 'x'), /INVALID_PERSON/);
  assert.throws(() => ledger.grant('s1', 'Lan', '', 'Dũng', 'x'), /INVALID_SCOPE/);
  assert.throws(() => ledger.grant('s1', 'Lan', '*', '', 'x'), /INVALID_GRANTED_BY/);
  assert.throws(() => ledger.grant('s1', 'Lan', '*', 'Dũng', ' '), /INVALID_GRANT_SOURCE/);
  assert.deepEqual(ledger.grants('s2'), []);
  const other = ledger.propose('s2', 'Việc ở phiên khác', [1]);
  assert.equal(ledger.decide(other, 'Hùng', [1]).decided, false);
  assert.deepEqual(ledger.list('s1'), []);
});

test('joins an open transaction instead of failing, so a rolled-back batch leaves nothing', () => {
  const { ledger, db } = make();
  db.exec('BEGIN');
  ledger.propose('s1', 'Trong giao dịch', [1]);
  db.exec('ROLLBACK');
  assert.deepEqual(ledger.list('s1'), []);
});
