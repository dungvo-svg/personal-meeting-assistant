// Co-working roles (src/cowork.ts): each person's Claude gets its own seat, role view and tasks; replies never decide; decision
// points converge into the central session. In-memory database and a fake clock: no files, no spawn, no network, no real timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CoworkLedger, roleView } from '../dist/cowork.js';
import { DecisionLedger } from '../dist/decisions.js';
import { Ledger } from '../dist/jobs.js';
import { bindRole, buildPack } from '../dist/context_pack.js';

const MIN = 60_000;
function make() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: minutes => { t += minutes * MIN; } };
  const db = new DatabaseSync(':memory:');
  return { db, clock, dl: new DecisionLedger(db, clock.now), board: new Ledger(db, clock.now), cw: new CoworkLedger(db, clock.now) };
}
const pack = buildPack({
  sessionId: 's1', title: 'Thiết lập thầu (thử)', me: 'Dũng', agenda: '- Giá\n- Tiến độ',
  participants: [{ name: 'Dũng', role: 'chủ' }, { name: 'Quân' }, { name: 'Oanh', variants: ['Oanh PT'] }],
  glossary: [{ name: 'NNC' }], createdAt: '2026-11-03T00:00:00.000Z',
});
const asQ = { consumerId: 'q1', generation: 1 }, asO = { consumerId: 'o1', generation: 1 };
// Quân: no role description (owner has not given one). Oanh: no scope (owner has not given one).
function seated(w) {
  w.cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 1, scope: 'giá' });
  w.cw.seat('s1', { person: 'Oanh', kind: 'simulated_role', consumerId: 'o1', generation: 1, roleDescription: 'Duyệt kế hoạch' });
}
const count = (db, table) => Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);

test('a remote seat without BOTH endpoint and consent is refused; with both it is recorded but never shown as live', () => {
  const { cw, db } = make();
  const endpoint = 'https://quan.example/pma', consentRef = 'owner chat 03/11 10:40: cho Quân dùng Claude riêng';
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'remote_claude' }), /REMOTE_NOT_CONSENTED/);
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'remote_claude', endpoint }), /REMOTE_NOT_CONSENTED/);
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'remote_claude', consentRef }), /REMOTE_NOT_CONSENTED/);
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'remote_claude', endpoint: '   ', consentRef: '  ' }), /REMOTE_NOT_CONSENTED/);
  assert.equal(count(db, 'cowork_seats'), 0, 'a refused seat leaves no row');
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'simulated_role', endpoint, consentRef }), /INVALID_SEAT/, 'a simulated role cannot carry remote credentials');
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'real_claude' }), /INVALID_SEAT_KIND/);

  const seat = cw.seat('s1', { person: 'Quân', kind: 'remote_claude', endpoint, consentRef });
  assert.equal(seat.kind, 'remote_claude'); assert.equal(seat.endpoint, endpoint); assert.equal(seat.consentRef, consentRef);
  const status = cw.status('s1');
  assert.equal(status.remote, 1); assert.equal(status.simulated, 0);
  assert.equal(status.liveRemote, 0, 'this module cannot verify a remote Claude, so it never counts one as live');
  assert.equal(status.seats[0].live, false);
  assert.equal(status.seats[0].simulated, false);
  assert.match(status.seats[0].label, /chưa kiểm được kết nối/);
});

test('a simulated seat is reported as simulated, never as the person\'s real Claude; a re-bind is idempotent', () => {
  const { cw, clock, db } = make();
  const first = cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 1 });
  clock.advance(5);
  const again = cw.seat('s1', { person: 'quân', kind: 'simulated_role', consumerId: 'q1', generation: 1 });
  assert.equal(again.boundAt, first.boundAt, 'the same seat again keeps the first record');
  assert.equal(count(db, 'cowork_seats'), 1);
  const s = cw.status('s1').seats[0];
  assert.equal(s.kind, 'simulated_role'); assert.equal(s.simulated, true); assert.equal(s.live, false);
  assert.match(s.label, /giả lập/); assert.match(s.label, /không phải Claude thật/);
  assert.equal(s.endpoint, null); assert.equal(s.consentRef, null);
  assert.equal(cw.status('s1').simulated, 1); assert.equal(cw.status('s1').remote, 0);
});

test('roleView shows a person their own roster entry, topics, items they hold or are assigned, and hides what is marked for someone else', () => {
  const w = make(); const { cw, dl, board } = w;
  seated(w);
  dl.grant('s1', 'Dũng', '*', 'Dũng', 'owner nói trong chat');
  dl.grant('s1', 'Quân', 'giá', 'Dũng', 'owner: Quân chốt phần giá');
  dl.grant('s1', 'Oanh', '*', 'Dũng', 'owner: Oanh chốt mọi phần');
  const decide = (text, by, src, opts) => { const id = dl.propose('s1', text, [src]); assert.equal(dl.decide(id, by, [src], opts).decided, true); return id; };
  const d1 = decide('Gửi báo giá trước thứ Sáu', 'Dũng', 1);            // topic "giá" is a whole word in the text
  const d2 = decide('Tăng lương tháng 11', 'Dũng', 2);                  // nothing to do with Quân
  const d3 = decide('Báo giá riêng cho khách X', 'Dũng', 3);            // matches "giá" but is marked for Oanh only
  const d4 = decide('Hẹn họp lại thứ Hai', 'Quân', 4, { scope: 'giá' }); // Quân decided it
  const d5 = decide('Làm hồ sơ thầu', 'Dũng', 5);                       // reaches Quân through an assignment
  cw.mark('s1', 'decision', d3, ['Oanh']);
  const act1 = dl.plan(d1, 'Gửi báo giá'), act2 = dl.plan(d2, 'Chuyển lương'), act3 = dl.plan(d3, 'Chuẩn bị báo giá X');
  const q1 = board.questions.ask('s1', 'Giá nào chốt?', [6]), q2 = board.questions.ask('s1', 'Lương ai duyệt?', [7]), q3 = board.questions.ask('s1', 'Câu hỏi chung của owner', [8]);
  board.questions.park('s1', { all: true });
  cw.mark('s1', 'question', q1, ['Quân']); cw.mark('s1', 'question', q2, ['Oanh']);
  const a1 = cw.assign('s1', 'Quân', 'Báo giá cho X', [9], d5), a2 = cw.assign('s1', 'Oanh', 'Soát kế hoạch', [10]);

  const data = { decisions: dl.list('s1'), actions: dl.actions('s1'), questions: board.questions.parked('s1') };
  const quan = cw.view(pack, 'Quân', dl.grants('s1'), data);
  assert.equal(quan.person, 'Quân'); assert.equal(quan.unknown, false);
  assert.equal(quan.roster.name, 'Quân'); assert.deepEqual(quan.topics, ['Giá', 'Tiến độ']);
  assert.deepEqual(quan.decisions.map(d => d.id), [d1, d4, d5], 'scope word, decided by Quân, and assigned from it; not d2, not d3 (marked for Oanh)');
  assert.deepEqual(quan.actions.map(a => a.id), [act1], 'the action of a hidden decision is hidden');
  assert.deepEqual(quan.questions.map(q => q.id), [q1], 'only the question addressed to Quân; not Oanh\'s, not the owner\'s unaddressed one');
  assert.deepEqual(quan.assignments.map(a => a.id), [a1]);
  assert.equal(quan.seat.kind, 'simulated_role');
  const dump = JSON.stringify(quan);
  for (const secret of ['lương', 'riêng', 'Soát kế hoạch', 'Câu hỏi chung', 'Oanh']) assert.equal(dump.includes(secret), false, secret + ' must not reach Quân');

  const oanh = cw.view(pack, 'Oanh', dl.grants('s1'), data);
  assert.deepEqual(oanh.decisions.map(d => d.id), [d1, d2, d3, d4, d5], 'holds authority on everything, and d3 is marked for her');
  assert.deepEqual(oanh.actions.map(a => a.id), [act1, act2, act3]);
  assert.deepEqual(oanh.questions.map(q => q.id), [q2]);
  assert.deepEqual(oanh.assignments.map(a => a.id), [a2]);
  assert.equal(oanh.roster.name, 'Oanh');
  void q3;
});

test('a reply by someone who is not the assignee is refused and leaves no trace', () => {
  const w = make(); const { cw } = w; seated(w);
  const a = cw.assign('s1', 'Quân', 'Gửi bảng giá', [1]);
  assert.throws(() => cw.reply(a, 'Oanh', 'Em làm hộ', [2], asO), /NOT_ASSIGNEE/);
  assert.throws(() => cw.reply(a, 'Phet', 'Em làm', [2]), /NOT_ASSIGNEE/, 'a person with no seat cannot answer either');
  assert.throws(() => cw.accept(a, 'Oanh', asO), /NOT_ASSIGNEE/);
  assert.throws(() => cw.decline(a, 'Oanh', 'Không phải việc của Quân', asO), /NOT_ASSIGNEE/);
  assert.throws(() => cw.reply(999, 'Quân', 'x', [], asQ), /ASSIGNMENT_NOT_FOUND/);
  assert.equal(cw.replies('s1').length, 0);
  assert.equal(cw.get(a).status, 'open');
});

test('a reply never decides: it returns a proposal payload, the decision ledger stays empty until the central session acts, and a simulated reply is marked simulated', () => {
  const w = make(); const { cw, dl } = w; seated(w);
  const a = cw.assign('s1', 'Quân', 'Chốt giá nhà cung cấp B', [5]);
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...asQ, decided: true }), /INVALID_REPLY_OPTION/, 'no way to pass a decision through a reply');
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...asQ, approved: true }), /INVALID_REPLY_OPTION/);

  const r = cw.reply(a, 'Quân', 'Tôi chốt giá B, đã được duyệt', [6, 6], { ...asQ, propose: 'Chọn nhà cung cấp B với giá 120' });
  assert.equal(r.decided, false);
  assert.equal(r.simulated, true); assert.equal(r.seatKind, 'simulated_role');
  assert.deepEqual({ ...r.proposal, provenance: undefined }, { sessionId: 's1', text: 'Chọn nhà cung cấp B với giá 120', sourceIds: [6], provenance: undefined });
  assert.equal(r.proposal.provenance.who, 'Quân'); assert.equal(r.proposal.provenance.simulated, true); assert.deepEqual(r.proposal.provenance.sourceIds, [6]);
  assert.equal(cw.get(a).status, 'answered');
  assert.equal(cw.replies('s1')[0].simulated, true);
  assert.equal(dl.list('s1').length, 0, 'nothing reached the decision ledger');
  assert.equal(dl.summaryOf('s1').decided, 0);

  // The central session proposes it through DecisionLedger. Nobody holds a grant yet, so even Quân cannot make it decided.
  const id = dl.propose(r.proposal.sessionId, r.proposal.text, r.proposal.sourceIds);
  const res = dl.decide(id, 'Quân', [6]);
  assert.equal(res.decided, false); assert.equal(res.authority, 'unknown'); assert.ok(res.park);
  assert.equal(dl.get(id).status, 'proposed');
  assert.equal(cw.linkProposal(r.id, id), true); assert.equal(cw.linkProposal(r.id, id), false);
  assert.equal(cw.provenanceOfDecision(id).simulated, true, 'the decision row keeps a pointer to a simulated origin');
  assert.equal(cw.convergeToCentral('s1').length, 0, 'once in DecisionLedger it is tracked there');

  // A reply without a proposal returns none.
  const b = cw.assign('s1', 'Oanh', 'Soát kế hoạch', [7]);
  const plain = cw.reply(b, 'Oanh', 'Đã soát, ổn', [8], asO);
  assert.equal(plain.proposal, undefined); assert.equal(plain.decided, false);
});

test('accept / decline follow the allowed transitions; a declined assignment takes no reply', () => {
  const w = make(); const { cw } = w; seated(w);
  const a = cw.assign('s1', 'Quân', 'Gửi bảng giá', [1]);
  assert.equal(cw.assign('s1', 'Quân', 'Gửi bảng giá', [1]), a, 'a re-sent assignment makes no duplicate');
  assert.equal(cw.accept(a, 'Quân', asQ), true); assert.equal(cw.accept(a, 'Quân', asQ), false);
  assert.equal(cw.decline(a, 'Quân', 'Tuần này em kẹt', asQ), true); assert.equal(cw.decline(a, 'Quân', 'lần hai', asQ), false);
  assert.equal(cw.get(a).status, 'declined'); assert.equal(cw.get(a).note, 'Tuần này em kẹt', 'the first reason stays');
  assert.throws(() => cw.accept(a, 'Quân', asQ), /ASSIGNMENT_CLOSED/);
  assert.throws(() => cw.reply(a, 'Quân', 'Thôi em làm', [2], asQ), /ASSIGNMENT_CLOSED/);
  // An assignment from a decision needs a decided decision of this session.
  const { dl } = w;
  const p = dl.propose('s1', 'Một đề xuất', [3]);
  assert.throws(() => cw.assign('s1', 'Quân', 'Làm theo đề xuất', [3], p), /DECISION_NOT_DECIDED/);
  assert.throws(() => cw.assign('s1', 'Quân', 'Làm theo QĐ ma', [3], 999), /DECISION_NOT_FOUND/);
  dl.grant('s1', 'Dũng', '*', 'Dũng', 'owner nói'); dl.decide(p, 'Dũng', [3]);
  assert.ok(cw.assign('s1', 'Quân', 'Làm theo đề xuất', [3], p) > a);
});

test('convergence lists proposals, declines, overdue and parked questions, each with provenance; handled and answered items drop out', () => {
  const w = make(); const { cw, clock, board, dl } = w; seated(w);
  const t0 = clock.now();
  const aOver = cw.assign('s1', 'Quân', 'Gửi bảng giá', [1], undefined, { dueAt: t0 + 10 * MIN });
  const aDecl = cw.assign('s1', 'Oanh', 'Soát kế hoạch', [2]);
  cw.decline(aDecl, 'Oanh', 'Tuần này em kẹt', asO);
  const aProp = cw.assign('s1', 'Quân', 'Đề xuất hạn giao', [3]);
  const rProp = cw.reply(aProp, 'Quân', 'Em đề xuất thứ Sáu', [4], { ...asQ, propose: 'Giao hàng thứ Sáu' });
  cw.assign('s1', 'Oanh', 'Việc không có hạn', [5]);
  const aDone = cw.assign('s1', 'Quân', 'Việc xong đúng hạn', [6], undefined, { dueAt: t0 + 5 * MIN });
  cw.reply(aDone, 'Quân', 'Xong', [7], asQ);
  const q = board.questions.ask('s1', 'Ai chốt giá?', [8]);
  board.questions.park('s1', { all: true });
  board.questions.ask('s1', 'Câu hỏi còn mở', [9]);
  cw.mark('s1', 'question', q, ['Quân']);
  assert.equal(cw.convergeToCentral('s1').filter(i => i.kind === 'overdue').length, 0, 'not overdue before the due time');
  clock.advance(11);

  const items = cw.convergeToCentral('s1');
  assert.deepEqual(items.map(i => i.kind).sort(), ['declined', 'overdue', 'parked_question', 'proposal']);
  for (const i of items) { assert.ok('who' in i.provenance && 'seatKind' in i.provenance && Array.isArray(i.provenance.sourceIds) && Number.isFinite(i.provenance.at), i.kind + ' carries who / seat kind / sources / time'); assert.ok(i.needs); }
  const by = kind => items.find(i => i.kind === kind);

  const proposal = by('proposal');
  assert.equal(proposal.provenance.who, 'Quân'); assert.equal(proposal.provenance.seatKind, 'simulated_role'); assert.equal(proposal.provenance.simulated, true);
  assert.deepEqual(proposal.provenance.sourceIds, [4]); assert.equal(proposal.provenance.at, t0);
  assert.equal(proposal.text, 'Giao hàng thứ Sáu'); assert.equal(proposal.proposal.text, 'Giao hàng thứ Sáu'); assert.match(proposal.needs, /chưa phải quyết định/);

  const declined = by('declined');
  assert.equal(declined.person, 'Oanh'); assert.equal(declined.detail, 'Tuần này em kẹt'); assert.deepEqual(declined.provenance.sourceIds, [2]); assert.equal(declined.provenance.seatKind, 'simulated_role');

  const overdue = items.filter(i => i.kind === 'overdue');
  assert.equal(overdue.length, 1, 'only the open assignment with a due date in the past; none without a due date, none already answered');
  assert.equal(overdue[0].assignmentId, aOver); assert.equal(overdue[0].provenance.at, t0 + 10 * MIN); assert.equal(overdue[0].person, 'Quân');

  const parked = by('parked_question');
  assert.equal(parked.text, 'Ai chốt giá?'); assert.deepEqual(parked.addressedTo, ['Quân']); assert.deepEqual(parked.provenance.sourceIds, [8]);
  assert.equal(parked.provenance.who, null, 'who asked is not recorded, so it is not invented'); assert.equal(parked.provenance.seatKind, null);
  assert.equal(items.length, 4, 'an open (not parked) question is not listed');
  for (let n = 1; n < items.length; n++) assert.ok(items[n - 1].provenance.at <= items[n].provenance.at, 'oldest first');

  // The central session deals with them. Rows stay; only the list shrinks.
  assert.equal(cw.handle('assignment', aDecl, 'Dũng', 'Giao lại cho Quân'), true); assert.equal(cw.handle('assignment', aDecl, 'Dũng', 'lần hai'), false);
  assert.throws(() => cw.handle('assignment', 999, 'Dũng', 'x'), /REF_NOT_FOUND/);
  assert.equal(cw.get(aDecl).status, 'declined', 'handling never rewrites history');
  const id = dl.propose('s1', proposal.proposal.text, proposal.proposal.sourceIds);
  cw.linkProposal(rProp.id, id);
  assert.equal(board.questions.answer(q, 'Chốt nhà cung cấp B'), true);
  assert.deepEqual(cw.convergeToCentral('s1').map(i => i.kind), ['overdue']);
  cw.decline(aOver, 'Quân', 'Quá tay', asQ);
  assert.deepEqual(cw.convergeToCentral('s1').map(i => i.kind), ['declined'], 'a declined assignment moves from overdue to declined');
});

test('an unknown speaker is never assigned, seated, marked or given a role view', () => {
  const w = make(); const { cw, db } = w; seated(w);
  for (const who of ['Tôi', 'tôi', 'Chưa xác định', 'unknown', 'Speaker 2', 'mic', '?', 'ຂ້ອຍ', 'ฉัน', '', '   ', 'Tôi (mic)']) {
    assert.throws(() => cw.assign('s1', who, 'Làm việc này', [1]), /UNKNOWN_SPEAKER/, JSON.stringify(who));
    assert.throws(() => cw.seat('s1', { person: who, kind: 'simulated_role' }), /UNKNOWN_SPEAKER/, JSON.stringify(who));
    assert.throws(() => cw.mark('s1', 'question', 1, [who]), /UNKNOWN_SPEAKER/, JSON.stringify(who));
    const view = roleView(pack, who, [], { decisions: [], actions: [], questions: [], assignments: [] });
    assert.equal(view.unknown, true); assert.equal(view.person, null); assert.equal(view.roster, null);
    assert.deepEqual([view.decisions, view.actions, view.questions, view.assignments, view.topics], [[], [], [], [], []]);
  }
  assert.equal(count(db, 'cowork_assignments'), 0);
  assert.throws(() => cw.assign('s1', 'Phet', 'Làm việc này', [1]), /NO_SEAT/, 'a real name without a seat is not assigned either');
  const status = cw.status('s1', { expect: ['Quân', 'Tôi', 'Phet'] });
  assert.ok(status.missing.includes('seat:Phet')); assert.equal(status.missing.some(m => /Tôi/.test(m)), false, 'an unknown speaker is not listed as someone who is missing');
});

test('missing role data is listed and left empty, never invented', () => {
  const w = make(); const { cw } = w; seated(w);
  cw.seat('s1', { person: 'Hà', kind: 'simulated_role', consumerId: 'h1', generation: 1 });
  const status = cw.status('s1', { pack, expect: ['Quân', 'Oanh', 'Hà', 'Phet'] });
  for (const m of ['role_description:Quân', 'scope:Oanh', 'roster:Hà', 'role_description:Hà', 'scope:Hà', 'seat:Phet']) assert.ok(status.missing.includes(m), m + ' is reported: ' + status.missing.join(', '));
  for (const m of ['scope:Quân', 'role_description:Oanh', 'roster:Quân', 'roster:Oanh']) assert.equal(status.missing.includes(m), false, m + ' was given');
  assert.equal(cw.seatFor('s1', 'Quân').roleDescription, null); assert.equal(cw.seatFor('s1', 'Oanh').scope, null);

  const quan = cw.view(pack, 'Quân', [], {});
  assert.equal(quan.roster.role, undefined, 'the roster had no role for Quân and none is made up');
  assert.ok(quan.missing.includes('role_description:Quân')); assert.equal(quan.missing.includes('scope:Quân'), false);
  const ha = cw.view(pack, 'Hà', [], {});
  assert.equal(ha.roster, null); assert.ok(ha.missing.includes('roster:Hà'));
  const noPack = cw.view(null, 'Quân', [], {});
  assert.deepEqual(noPack.topics, []); assert.equal(noPack.roster, null); assert.ok(noPack.missing.includes('pack'));

  // What the owner gave survives a re-bind that does not repeat it; new owner text replaces it.
  const rebound = cw.seat('s1', { person: 'Oanh', kind: 'simulated_role', consumerId: 'o1', generation: 2 });
  assert.equal(rebound.roleDescription, 'Duyệt kế hoạch'); assert.equal(rebound.scope, null);
  assert.equal(cw.seat('s1', { person: 'Oanh', kind: 'simulated_role', consumerId: 'o1', generation: 2, scope: 'kế hoạch' }).scope, 'kế hoạch');
});

test('a wrong consumer, a missing or stale generation, or a pack the seat has not read cannot reply', () => {
  const w = make(); const { cw } = w; seated(w);
  const a = cw.assign('s1', 'Quân', 'Gửi bảng giá', [1]);
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { consumerId: 'other', generation: 1 }), /WRONG_CONSUMER/);
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], {}), /WRONG_CONSUMER/, 'a bound seat cannot be answered for by a caller that names no consumer');
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { consumerId: 'q1' }), /GENERATION_REQUIRED/);
  assert.throws(() => cw.accept(a, 'Quân', { consumerId: 'other', generation: 1 }), /WRONG_CONSUMER/);
  assert.throws(() => cw.decline(a, 'Quân', 'x', { consumerId: 'q1', generation: 0 }), /STALE_GENERATION/);

  // The seat is bound again by a restart: generation 2.
  cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 2, scope: 'giá' });
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { consumerId: 'q1', generation: 1 }), /STALE_GENERATION/, 'a late result of the old process');
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { consumerId: 'q1', generation: 3 }), /NOT_BOUND/);
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 1, scope: 'giá' }), /STALE_GENERATION/, 'a zombie cannot take the seat back');

  // context_pack readiness: the seat must have read THIS version, and be the consumer that read it.
  const at2 = { consumerId: 'q1', generation: 2 };
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...at2, context: { pack: null, bindings: {} } }), /CONTEXT_NOT_CURRENT.*NO_CONTEXT/);
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...at2, context: { pack, bindings: {} } }), /CONTEXT_NOT_CURRENT.*NOT_BOUND/);
  const onlyOanh = bindRole({}, { sessionId: 's1', role: 'participant', consumerId: 'o1', generation: 1, version: pack.version });
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...at2, context: { pack, bindings: onlyOanh } }), /CONTEXT_NOT_CURRENT.*WRONG_CONSUMER/, 'another reader has the current pack, this one has not');
  const stale = bindRole({}, { sessionId: 's1', role: 'participant', consumerId: 'q1', generation: 2, version: 'old-version' });
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { ...at2, context: { pack, bindings: stale } }), /CONTEXT_NOT_CURRENT.*STALE_CONTEXT/);
  assert.equal(cw.replies('s1').length, 0, 'every refusal left no reply'); assert.equal(cw.get(a).status, 'open');

  const current = bindRole(stale, { sessionId: 's1', role: 'participant', consumerId: 'q1', generation: 2, version: pack.version });
  const ok = cw.reply(a, 'Quân', 'Đã gửi', [2], { ...at2, context: { pack, bindings: current } });
  assert.equal(ok.decided, false); assert.equal(cw.replies('s1').length, 1);
});

// Codex review of a3e1fb3: a seat's generation is compared whatever the consumer, and the host's ledger refuses a reply that
// brings no context at all (optional context let a caller skip the check by leaving it out).
test('a lower generation cannot take a seat back by naming another consumer', () => {
  const { cw } = make();
  cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 5 });
  assert.throws(() => cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q2', generation: 3 }), /STALE_GENERATION/);
  assert.equal(cw.seatFor('s1', 'Quân').consumerId, 'q1');
  assert.equal(cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q2', generation: 6 }).consumerId, 'q2', 'a newer generation may move the seat');
});

test('with requireContext (the host) a reply without context is refused and leaves nothing', () => {
  let t = 1_000_000; const db = new DatabaseSync(':memory:'); const cw = new CoworkLedger(db, () => t, { requireContext: true });
  cw.seat('s1', { person: 'Quân', kind: 'simulated_role', consumerId: 'q1', generation: 2 });
  const a = cw.assign('s1', 'Quân', 'Gửi bảng giá', [1]);
  assert.throws(() => cw.reply(a, 'Quân', 'x', [], { consumerId: 'q1', generation: 2 }), /CONTEXT_REQUIRED/);
  assert.equal(cw.replies('s1').length, 0); assert.equal(cw.get(a).status, 'open');
  const bindings = bindRole({}, { sessionId: 's1', role: 'participant', consumerId: 'q1', generation: 2, version: pack.version });
  assert.equal(cw.reply(a, 'Quân', 'Đã gửi', [2], { consumerId: 'q1', generation: 2, context: { pack, bindings } }).decided, false);
});
