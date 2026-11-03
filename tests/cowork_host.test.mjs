// Co-working seats through the runtime (what the host's seat / role / respond / converge RPCs call). A MeetingRuntime on the
// temp folders of withFakes; the meeting row is inserted directly, so nothing is prepared, nothing is spawned, no device, no audio.
// The host makes each seat's token and generation; a role acts only with its token and only after reading the current context.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, withFakes } from './fakes.mjs';

function meeting(r, context = { me: 'Dũng', agenda: '- Giá', participants: [{ name: 'Dũng' }, { name: 'Quân' }, { name: 'Oanh' }] }) {
  const id = randomUUID();
  r.db.prepare("INSERT INTO sessions(id,title,created,ended,mode,context) VALUES(?,?,?,NULL,'live',?)").run(id, 'Họp thử', new Date().toISOString(), JSON.stringify(context));
  return id;
}

test('a seat is a simulated role, its token is shown once, and nothing is reported as connected', async () => {
  await withFakes(async r => {
    const id = meeting(r);
    const { seat, token } = r.seatRole(id, { person: 'Quân', scope: 'giá' });
    assert.match(token, /^seat-[a-f0-9]{20}$/);
    assert.equal(seat.simulated, true); assert.equal(seat.connection, 'SIMULATED'); assert.match(seat.label, /Vai giả lập của Quân/);
    const list = r.seatList(id, ['Quân', 'Oanh']);
    assert.equal(list.liveRemote, 0); assert.equal(list.seats[0].consumerId, 'đã cấp', 'the token is not shown again');
    assert.ok(list.missing.includes('seat:Oanh'));
    assert.throws(() => r.seatRole(id, { person: 'Tôi' }), /UNKNOWN_SPEAKER/);
  });
});

test('a role answers only with its own token, after reading the current context; a reply never decides', async () => {
  await withFakes(async r => {
    const id = meeting(r); const other = meeting(r);
    const { token } = r.seatRole(id, { person: 'Quân' });
    const task = r.cowork.assign(id, 'Quân', 'Gửi bảng giá', [1]);
    assert.throws(() => r.seatAct(id, token, 'reply', task, { text: 'Đã gửi' }), /CONTEXT_NOT_CURRENT/, 'not read yet');
    assert.throws(() => r.seatAct(other, token, 'reply', task, { text: 'x' }), /SEAT_UNKNOWN/, 'a token of another meeting');
    assert.throws(() => r.seatAct(id, 'seat-00000000000000000000', 'reply', task, { text: 'x' }), /SEAT_UNKNOWN/);

    const seen = r.seatView(id, token);
    assert.equal(seen.view.person, 'Quân'); assert.deepEqual(seen.view.assignments.map(a => a.id), [task]);
    const reply = r.seatAct(id, token, 'reply', task, { text: 'Em đề xuất giá B', sourceIds: [3], propose: 'Chọn giá B' });
    assert.equal(reply.decided, false); assert.equal(reply.simulated, true);

    // The context changes (a correction): the role must read it again before its next answer counts.
    const second = r.cowork.assign(id, 'Quân', 'Soát hạn giao', [4]);
    r.addToContext(id, 'corrections', { raw: 'ta', corrected: 'Tar', basis: 'inferred', scope: 'meeting', source: 'correction' });
    assert.throws(() => r.seatAct(id, token, 'reply', second, { text: 'Xong' }), /CONTEXT_NOT_CURRENT.*STALE_CONTEXT/);
    r.seatView(id, token); assert.equal(r.seatAct(id, token, 'reply', second, { text: 'Xong' }).decided, false);

    // Seating Quân again makes a new token: the old one stops working.
    const { token: again } = r.seatRole(id, { person: 'Quân' });
    assert.notEqual(again, token);
    assert.throws(() => r.seatView(id, token), /SEAT_UNKNOWN/);
  });
});

test('a proposal converges to the central session and enters the decision ledger only as a proposal', async () => {
  await withFakes(async r => {
    const id = meeting(r);
    const { token } = r.seatRole(id, { person: 'Oanh' }); r.seatView(id, token);
    const task = r.cowork.assign(id, 'Oanh', 'Chọn ngày giao', [2]);
    const reply = r.seatAct(id, token, 'reply', task, { text: 'Thứ Sáu được', sourceIds: [2], propose: 'Giao thứ Sáu' });
    const items = r.cowork.convergeToCentral(id);
    assert.equal(items.length, 1); assert.equal(items[0].kind, 'proposal'); assert.equal(items[0].provenance.simulated, true);

    const promoted = r.promoteReply(id, reply.id);
    assert.equal(promoted.status, 'proposed');
    const d = r.decisions.get(promoted.decisionId);
    assert.equal(d.status, 'proposed', 'nobody decided it'); assert.match(d.text, /vai giả lập Oanh/);
    assert.deepEqual(r.promoteReply(id, reply.id), { decisionId: promoted.decisionId, status: 'proposed', already: true });
    assert.equal(r.cowork.convergeToCentral(id).length, 0, 'tracked by the decision ledger from here');
    assert.equal(r.cowork.provenanceOfDecision(promoted.decisionId).simulated, true);
    assert.throws(() => r.handleCentral(meeting(r), 'reply', reply.id, 'Dũng', 'x'), /REF_OF_ANOTHER_MEETING/);
  });
});

test('the host refuses a remote seat as not connected (read as text: no host is started)', () => {
  const daemon = readFileSync(resolve('src/daemon.ts'), 'utf8');
  assert.match(daemon, /if \(a\.kind === 'remote_claude'\) throw new Error\('REMOTE_NOT_CONNECTED/);
});
