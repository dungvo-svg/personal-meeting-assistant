// Plan 0.12 A, B and D at the runtime: what a share role (`dich`) may be given, folding that keeps the mic label, and the follower
// contract (scan/ack, lease, release, picture, translate). Synthetic rows only; the clock of the runtime is a fake one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { shareable, foldRuns, ackOf } from '../dist/text.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-share-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime, directory); } finally { await runtime.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true }); }
}
const LIVE = 'SOURCE_LIVE_FOLLOW'; const REPLAY = 'SOURCE_REPLAY_MIXED'; const MIC = 'CHANNEL_MIC';
const ing = (r, text, boundary, more = {}) => r.ingest(text, more.origin ?? 'local_asr_unverified', 0, 3, boundary, 'cap', more.language ?? 'vi', '', null, more.alternatives);
const A = 'leaseaaa1'; const B = 'leasebbb2'; const C = 'leaseccc3';
const clock = (r) => { const c = { t: Date.parse('2026-11-01T08:00:00Z'), advance(ms) { c.t += ms; } }; r.now = () => c.t; return c; };
// next() the way `pma follow` / MCP call it
const nx = (r, o = {}) => r.next(r.session.id, o.after ?? 0, o.wait ?? 0, o.limit ?? 100, o.follower ?? true, o.as ?? 'chinh', { ack: o.ack, lease: o.lease });
const state = (r, name) => JSON.stringify([r.followers[name] ?? null, r.agentCursor, r.lastFollowAt]);
const ids = items => items.map(item => item.id);

// What may be shared, written out by hand (not derived from the function under test).
const MATRIX = [
  // speaker channel (no CHANNEL_MIC): shared only with the live-follow stamp, whatever the mic is doing
  ['speaker, live follow', LIVE, true], ['speaker, live follow, ASR flags', 'SILENCE_BOUNDARY_HEURISTIC; LANG_UNSURE; ' + LIVE, true],
  ['speaker, replay of a mixed file', REPLAY, false], ['speaker, replay with ASR flags', 'SILENCE_BOUNDARY_HEURISTIC; ' + REPLAY, false],
  ['speaker, old row without provenance', 'SILENCE_BOUNDARY_HEURISTIC', false], ['speaker, empty boundary', '', false], ['speaker, odd stamp', 'SOURCE_LIVE', false], ['speaker, odd stamp 2', 'LIVE_FOLLOW', false],
  // mic channel: only a flag that says the whole chunk had the mic ON
  ['mic, whole chunk ON', `${MIC}; MIC_STATE_ON; MIC_SHARE_OK; ${LIVE}`, true], ['mic, whole chunk ON, no live stamp', `${MIC}; MIC_STATE_ON; MIC_SHARE_OK`, false],
  ['mic, majority ON (no SHARE_OK)', `${MIC}; MIC_STATE_ON; ${LIVE}`, false], ['mic, ON without anything else', `${MIC}; MIC_STATE_ON`, false],
  ['mic, OFF', `${MIC}; MIC_STATE_OFF; ${LIVE}`, false], ['mic, OFF, no stamp', `${MIC}; MIC_STATE_OFF`, false],
  ['mic, UNKNOWN (also a tie)', `${MIC}; MIC_STATE_UNKNOWN; ${LIVE}`, false], ['mic, no state label', `${MIC}; ${LIVE}`, false], ['mic alone', MIC, false],
  ['mic, odd state label', `${MIC}; MIC_STATE_MAYBE; ${LIVE}`, false], ['mic, odd share flag', `${MIC}; MIC_STATE_ON; MIC_SHARE_MAYBE; ${LIVE}`, false],
];

test('shareable(): the three kinds of row, and everything else hidden', () => {
  for (const [what, boundary, shared] of MATRIX) assert.equal(shareable({ origin: 'local_asr_unverified', boundary }), shared, what);
  // the host's own text is shared whatever its boundary says
  for (const origin of ['system_gap', 'operator_text']) for (const boundary of ['', 'ASR_RESTARTED', MIC, `${MIC}; MIC_STATE_OFF`, REPLAY]) assert.equal(shareable({ origin, boundary }), true, origin + ' ' + boundary);
  assert.equal(shareable({ origin: 'local_asr_unverified' }), false, 'a row with no boundary at all');
  assert.equal(shareable({ origin: 'something_new', boundary: LIVE }), true, 'speaker live flag decides for other origins'); // only local_asr rows exist; the flag is the rule
  assert.equal(shareable({ origin: 'something_new', boundary: MIC }), false);
});

test('next() for a share role returns only shareable rows, with no text or alternatives of hidden ones; chinh reads everything; read is the same', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id; const rows = [];
    for (const [what, boundary, shared] of MATRIX) { const n = rows.length; const text = `chữ[${n}]`; const alt = `phương án[${n}]`; rows.push({ what, shared, text, alt, id: ing(r, text, boundary, { language: 'lo', alternatives: [{ language: 'th', text: alt }] }) }); }
    const gap = r.ingest('[Khoảng trống 4 giây]', 'system_gap', 0, 4, 'ASR_RESTARTED', 'cap'); const typed = r.ingest('ghi tay', 'operator_text');
    const visible = [...rows.filter(row => row.shared).map(row => row.id), gap, typed]; const hidden = rows.filter(row => !row.shared);
    const everything = [...rows.map(row => row.id), gap, typed];
    for (const as of ['dich', 'khach']) {
      const got = await nx(r, { as, limit: 100, lease: undefined }); const text = JSON.stringify(got);
      assert.deepEqual(ids(got.items), visible, as); assert.equal(got.nextCursor, typed, 'cursor goes over the hidden rows too');
      for (const row of hidden) assert.ok(!text.includes(row.text) && !text.includes(row.alt), `${row.what}: neither text nor alternatives leave the host`);
      for (const row of rows.filter(row => row.shared)) assert.ok(got.items.find(item => item.id === row.id).alternatives.length === 1, 'a shared row keeps its alternatives');
      const read = r.read(id, 0, 100, as); assert.deepEqual(ids(read.items), visible); assert.equal(read.nextCursor, typed); assert.equal(read.done, true);
      for (const row of hidden) assert.ok(!JSON.stringify(read).includes(row.text) && !JSON.stringify(read).includes(row.alt), row.what);
    }
    assert.deepEqual(ids((await nx(r, { as: 'chinh' })).items), everything, 'the main session sees all rows, labelled');
    assert.deepEqual(ids(r.read(id, 0, 100).items), everything, 'read without a role is the owner\'s full read');
    assert.deepEqual(ids(r.read(id, 0, 100, 'chinh').items), everything);
    assert.deepEqual(ids(r.sources(id, 0, 100)), everything);
    // limit counts scanned rows
    const page = await nx(r, { as: 'dich', limit: 3 }); assert.equal(page.nextCursor, rows[2].id); assert.deepEqual(ids(page.items), rows.slice(0, 3).filter(row => row.shared).map(row => row.id));
  });
});

test('replay rows are hidden from a share role in next and read, also after the session went on live; the host stamps each row by the worker that made it', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id;
    const source = (text, follow, boundary = 'SILENCE_BOUNDARY_HEURISTIC') => { r.onWorkerEvent({ type: 'source', text, start: 0, end: 3, boundary, language: 'vi', wall: new Date().toISOString(), seg: 1 }, follow); return r.sources(id).at(-1); };
    const replayed = source('từ file trộn', false); const empty = source('không nhãn', false, ''); const live = source('nghe trực tiếp', true); const liveEmpty = source('trực tiếp, nhãn rỗng', true, '');
    assert.equal(replayed.boundary, 'SILENCE_BOUNDARY_HEURISTIC; SOURCE_REPLAY_MIXED'); assert.equal(empty.boundary, 'SOURCE_REPLAY_MIXED');
    assert.equal(live.boundary, 'SILENCE_BOUNDARY_HEURISTIC; SOURCE_LIVE_FOLLOW'); assert.equal(liveEmpty.boundary, 'SOURCE_LIVE_FOLLOW');
    assert.equal(r.sources(id)[0].text, 'từ file trộn', 'stored text is unchanged');
    r.session.replay = { file: 'x.wav', speed: 1 };  // the file is playing: nothing of it for dich
    assert.deepEqual(ids((await nx(r, { as: 'dich' })).items), [live.id, liveEmpty.id]);
    delete r.session.replay;  // the session is live now; the old replay rows stay hidden
    const later = source('lại trực tiếp', true);
    assert.deepEqual(ids((await nx(r, { as: 'dich' })).items), [live.id, liveEmpty.id, later.id]); assert.deepEqual(ids(r.read(id, 0, 100, 'dich').items), [live.id, liveEmpty.id, later.id]);
    assert.deepEqual(ids((await nx(r, { as: 'chinh' })).items), r.sources(id).map(row => row.id));
    // a gap the host wrote is not stamped (it is the host's own text)
    r.onWorkerEvent({ type: 'gap', start: 0, end: 5, reason: 'ASR_LAG', wall: new Date().toISOString() }, false); assert.equal(r.sources(id).at(-1).boundary, 'ASR_LAG');
    assert.equal(ids((await nx(r, { as: 'dich', after: later.id })).items).length, 1, 'and it is shared');
  });
});

test('a page of hidden rows only still moves the cursor; read as a share role pages correctly and ends', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id; const hidden = [...Array(5)].map((_, i) => ing(r, 'riêng ' + i, `${MIC}; MIC_STATE_OFF`));
    const first = await nx(r, { as: 'dich', limit: 3, wait: 2000 });
    assert.deepEqual(first.items, []); assert.equal(first.nextCursor, hidden[2], 'scanned, so the cursor moves');
    const second = await nx(r, { as: 'dich', after: first.nextCursor, limit: 3 }); assert.deepEqual(second.items, []); assert.equal(second.nextCursor, hidden[4]);
    const shown = ing(r, 'công khai', LIVE); const third = await nx(r, { as: 'dich', after: second.nextCursor }); assert.deepEqual(ids(third.items), [shown]);
    // read: an all-hidden page is "not done" while there are more rows to scan; the pages add up to exactly the shareable rows
    const other = ing(r, 'công khai 2', LIVE); ing(r, 'riêng 5', `${MIC}; MIC_STATE_UNKNOWN`); ing(r, 'riêng 6', REPLAY);
    const pages = []; for (let after = 0; ;) { const page = r.read(id, after, 2, 'dich'); pages.push(page); after = page.nextCursor; if (page.done) break; assert.ok(pages.length < 10); }
    assert.deepEqual(pages.flatMap(p => ids(p.items)), [shown, other]); assert.deepEqual(pages.map(p => p.done), [false, false, false, false, true].slice(0, pages.length)); assert.equal(pages.at(-1).nextCursor, r.sources(id).at(-1).id);
    assert.equal(pages[0].items.length, 0, 'the first page was all hidden'); assert.equal(pages[0].done, false);
    assert.equal(r.read(id, 0, 100).items.length, 9, 'without a role: everything');
  });
});

test('folding never joins rows of a different mic state or channel, and RAW keeps each group\'s label', async () => {
  const rows = [...[1, 2, 3].map(id => ({ id, text: 'cái', boundary: `${MIC}; MIC_STATE_ON; MIC_SHARE_OK` })), ...[4, 5, 6].map(id => ({ id, text: 'cái', boundary: `${MIC}; MIC_STATE_OFF` })),
    ...[7, 8, 9].map(id => ({ id, text: 'cái', boundary: LIVE })), ...[10, 11, 12].map(id => ({ id, text: 'cái', boundary: `${MIC}; MIC_STATE_UNKNOWN` })), ...[13, 14, 15].map(id => ({ id, text: 'cái', boundary: MIC }))];
  assert.deepEqual(foldRuns(rows).map(g => [g.first.id, g.last.id, g.count]), [[1, 3, 3], [4, 6, 3], [7, 9, 3], [10, 12, 3], [13, 15, 3]]);
  assert.deepEqual(foldRuns([{ id: 1, text: 'cái', boundary: `${MIC}; MIC_STATE_ON` }, { id: 2, text: 'cái', boundary: LIVE }, { id: 3, text: 'cái', boundary: `${MIC}; MIC_STATE_ON` }]).map(g => g.count), [1, 1, 1], 'a speaker line between two mic lines splits them');
  assert.equal(foldRuns([1, 2, 3].map(id => ({ id, text: 'cái', boundary: 'SILENCE_BOUNDARY_HEURISTIC; ' + LIVE + (id === 2 ? '; LANG_UNSURE' : '') }))).length, 1, 'ASR flags that are not about the mic do not split');
  await withRuntime(async r => {
    r.prepare('Họp', false, undefined, ['vi'], { me: 'Dũng' }); const id = r.session.id;
    const on = [1, 2, 3].map(() => ing(r, 'cái', `${MIC}; MIC_STATE_ON; MIC_SHARE_OK; ${LIVE}`)); const off = [1, 2, 3].map(() => ing(r, 'cái', `${MIC}; MIC_STATE_OFF; ${LIVE}`));
    const speaker = [1, 2, 3].map(() => ing(r, 'cái', LIVE));
    const raw = readFileSync(r.writeRaw(id).path, 'utf8').split('\n');
    const line = first => raw.find(l => l.includes(`#${first}–`));
    assert.match(line(on[0]), new RegExp(`#${on[0]}–#${on[2]} \\(nghe · vi · Tôi — Dũng \\(mic bật\\) · lặp 3 đoạn liền\\) cái \\[×3\\]`));
    assert.match(line(off[0]), new RegExp(`#${off[0]}–#${off[2]} \\(nghe · vi · Tôi — Dũng \\(mic tắt — nói riêng\\) · lặp 3 đoạn liền\\) cái \\[×3\\]`));
    assert.match(line(speaker[0]), new RegExp(`#${speaker[0]}–#${speaker[2]} \\(nghe · vi · lặp 3 đoạn liền\\) cái \\[×3\\]`));
    assert.ok(!raw.some(l => l.includes(`#${on[0]}–#${speaker[2]}`)), 'one group over all nine would hide who was heard on which channel');
  });
});

test('G1: the cursor of a role is what the follower acknowledged, so a crash before printing re-delivers; a lost reply keeps the old ack', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); const id = r.session.id; const one = ing(r, 'một', LIVE); const two = ing(r, 'hai', LIVE); const three = ing(r, 'ba', LIVE);
    // process A reads the three rows, holds them in its batch (not printed), keeps polling with ack = just before the oldest unprinted one
    const first = await nx(r, { after: 0, lease: A }); assert.deepEqual(ids(first.items), [one, two, three]); assert.equal(first.nextCursor, three);
    const batch = first.items; await nx(r, { after: first.nextCursor, ack: ackOf(batch, first.nextCursor), lease: A });
    assert.equal(r.followers.chinh.cursor, one - 1); assert.equal(r.agentCursor, one - 1, 'the main follower drives agentCursor too'); assert.equal(r.compact().unread, 3);
    // A dies without a release; before 90 s nobody can take the role, after it a new process starts at the stored cursor and gets all three again
    c.advance(60000); await assert.rejects(nx(r, { after: one - 1, lease: B }), /FOLLOWER_BUSY/);
    c.advance(30000); const again = await nx(r, { after: r.followers.chinh.cursor, lease: B }); assert.deepEqual(ids(again.items), [one, two, three]);
    // the same request twice (reply lost, same after/ack) gives the same rows and keeps the cursor
    const retry = await nx(r, { after: r.followers.chinh.cursor, ack: one - 1, lease: B }); assert.deepEqual(ids(retry.items), [one, two, three]); assert.equal(r.followers.chinh.cursor, one - 1);
    // ack may be below after: only ack is stored
    await nx(r, { after: three, ack: two, lease: B }); assert.equal(r.followers.chinh.cursor, two); assert.equal(r.agentCursor, two);
    await nx(r, { after: three, lease: B }); assert.equal(r.followers.chinh.cursor, three, 'ack defaults to after');
    await assert.rejects(nx(r, { after: 3, ack: -1, lease: B }), /INVALID_CURSOR/); await assert.rejects(nx(r, { after: 3, lease: 'BAD' }), /INVALID_LEASE/); await assert.rejects(nx(r, { after: 3, lease: 'short' }), /INVALID_LEASE/);
    assert.equal(r.followers.chinh.cursor, three, 'bad input changes nothing'); void id;
  });
});

test('G1: visible, then hidden, then a crash keeps the visible row for the share role; hidden rows never hold the cursor back', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); const seen = ing(r, 'cho xem', LIVE); const secret = ing(r, 'riêng', `${MIC}; MIC_STATE_OFF; ${LIVE}`);
    const first = await nx(r, { as: 'dich', after: 0, lease: A }); assert.deepEqual(ids(first.items), [seen]); assert.equal(first.nextCursor, secret);
    // the batch [seen] is not printed yet: ack = seen - 1, although the hidden row after it was scanned
    assert.equal(ackOf(first.items, first.nextCursor), seen - 1);
    await nx(r, { as: 'dich', after: first.nextCursor, ack: ackOf(first.items, first.nextCursor), lease: A }); assert.equal(r.followers.dich.cursor, seen - 1);
    c.advance(95000); const restarted = await nx(r, { as: 'dich', after: r.followers.dich.cursor, lease: B }); assert.deepEqual(ids(restarted.items), [seen]);
    // printed: ack covers the scan, hidden rows are dropped for good
    await nx(r, { as: 'dich', after: restarted.nextCursor, ack: ackOf([], restarted.nextCursor), lease: B }); assert.equal(r.followers.dich.cursor, secret);
    assert.deepEqual((await nx(r, { as: 'dich', after: r.followers.dich.cursor, lease: B })).items, []);
  });
});

test('G1: ids of other sessions between the rows do not upset the ack', async () => {
  await withRuntime(async r => {
    r.prepare('Phiên một'); ing(r, 'cũ 1', LIVE); ing(r, 'cũ 2', LIVE); await r.finish(r.session.id);
    r.prepare('Phiên hai'); const x = ing(r, 'mới 1', LIVE); const y = ing(r, 'mới 2', LIVE); assert.ok(x > 2);
    const got = await nx(r, { after: 0, lease: A }); assert.deepEqual(ids(got.items), [x, y], 'only this session\'s rows');
    const ack = ackOf(got.items, got.nextCursor); assert.equal(ack, x - 1); await nx(r, { after: got.nextCursor, ack, lease: A }); assert.equal(r.followers.chinh.cursor, x - 1);
    assert.deepEqual(ids((await nx(r, { after: r.followers.chinh.cursor, lease: A })).items), [x, y]);
  });
});

test('G3: a role with a live lease refuses a second process and changes nothing; after 90 s it can be taken; roles do not block each other', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); for (const t of ['a', 'b', 'c']) ing(r, t, LIVE);
    await nx(r, { as: 'dich', after: 0, ack: 0, lease: A });
    c.advance(30000); const before = state(r, 'dich'); const readAt = r.lastAgentReadAt;
    await assert.rejects(nx(r, { as: 'dich', after: 3, ack: 3, lease: B }), /FOLLOWER_BUSY: vai dich/);
    assert.equal(state(r, 'dich'), before, 'cursor, heartbeat and lease of the holder are untouched'); assert.equal(r.lastAgentReadAt, readAt);
    // the other role is free, and does not move dich
    await nx(r, { as: 'chinh', after: 1, lease: C }); assert.equal(r.followers.dich.cursor, 0); assert.equal(r.followers.chinh.cursor, 1); assert.equal(r.agentCursor, 1);
    // the holder's heartbeat keeps the role: 30 s + 89 s since its last call is still live
    await nx(r, { as: 'dich', after: 3, ack: 3, lease: A }); assert.equal(r.followers.dich.cursor, 3);
    c.advance(89999); await assert.rejects(nx(r, { as: 'dich', after: 3, lease: B }), /FOLLOWER_BUSY/);
    c.advance(1); const taken = await nx(r, { as: 'dich', after: r.followers.dich.cursor, lease: B }); assert.deepEqual(taken.items, []);
    assert.equal(r.followers.dich.lease, B); await assert.rejects(nx(r, { as: 'dich', after: 3, lease: A }), /FOLLOWER_BUSY/);
    assert.equal(r.followers.chinh.lease, C, 'the other role still belongs to its holder');
  });
});

test('G3: a call without lease never moves a role that has a live lease (MCP source_next, direct next as=dich), but still reads with its own after', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); const rows = ['a', 'b', 'c', 'd'].map(t => ing(r, t, LIVE));
    // chinh: CLI batch of rows 1..4 not printed yet, ack before the first
    await nx(r, { after: 0, ack: 0, lease: A }); await nx(r, { after: rows[3], ack: rows[0] - 1, lease: A });
    const beforeMain = state(r, 'chinh'); assert.equal(r.followers.chinh.cursor, rows[0] - 1);
    const mcp = await r.next(r.session.id, rows[1], 0, 12);   // MCP source_next after=N: no role, no lease
    assert.deepEqual(ids(mcp.items), [rows[2], rows[3]], 'it reads from its own after'); assert.equal(mcp.nextCursor, rows[3]);
    assert.equal(state(r, 'chinh'), beforeMain, 'chinh cursor, heartbeat, agentCursor and lastFollowAt are the CLI batch\'s');
    const direct = await r.next(r.session.id, rows[3], 0, 12, true); assert.equal(state(r, 'chinh'), beforeMain, 'also with follower=true');
    assert.deepEqual(direct.items, []);
    // CLI dies and comes back: the unprinted rows come again
    c.advance(91000); const back = await nx(r, { after: r.followers.chinh.cursor, lease: B }); assert.deepEqual(ids(back.items), rows);
    // dich
    await nx(r, { as: 'dich', after: 0, ack: 0, lease: C }); const beforeDich = state(r, 'dich'); c.advance(1000);
    const direct2 = await r.next(r.session.id, rows[2], 0, 12, true, 'dich'); assert.deepEqual(ids(direct2.items), [rows[3]]);
    assert.equal(state(r, 'dich'), beforeDich); assert.equal(r.followers.dich.lease, C);
    // nobody holds the role (lease aged out): an unleased call behaves as before and the old lease is gone
    c.advance(120000); await r.next(r.session.id, rows[1], 0, 12, true, 'dich'); assert.equal(r.followers.dich.cursor, rows[1]); assert.equal(r.followers.dich.lease, undefined);
    await nx(r, { as: 'dich', after: rows[1], lease: A }); assert.equal(r.followers.dich.lease, A);
  });
});

test('G3: a request that was waiting when its role was taken over writes nothing when it returns, and its next call is refused', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); const id = r.session.id;
    const waiting = r.next(id, 0, 5000, 12, true, 'dich', { ack: 0, lease: A });   // long poll, no rows yet
    await new Promise(res => setTimeout(res, 30)); c.advance(91000);
    await nx(r, { as: 'dich', after: 0, ack: 0, lease: B });
    const taken = state(r, 'dich'); assert.equal(r.followers.dich.lease, B);
    const row = ing(r, 'đến muộn', LIVE); const got = await waiting;
    assert.deepEqual(ids(got.items), [row], 'it still returns what it read'); assert.equal(state(r, 'dich'), taken, 'but it wrote no progress');
    await assert.rejects(r.next(id, got.nextCursor, 0, 12, true, 'dich', { lease: A }), /FOLLOWER_BUSY/); assert.equal(state(r, 'dich'), taken);
  });
});

test('G5: release gives the role back (cursor = ack, no heartbeat) only to the matching session, role and lease; a stale release changes nothing', async () => {
  await withRuntime(async r => {
    const c = clock(r); r.prepare('Họp'); const id = r.session.id; const rows = ['a', 'b', 'c'].map(t => ing(r, t, LIVE));
    await nx(r, { as: 'dich', after: 0, ack: 0, lease: A });
    // minute 29: A leaves and the next process takes over at once, from the acknowledged cursor
    assert.deepEqual(r.release(id, 'dich', A, rows[1]), { released: true }); assert.deepEqual(r.followers.dich, { cursor: rows[1], at: null });
    assert.equal(r.compact().followers.dich.cursor, rows[1]); assert.equal(r.compact().followers.dich.at, null); assert.equal(r.compact().followers.dich.unread, 1);
    const next = await nx(r, { as: 'dich', after: r.followers.dich.cursor, lease: B }); assert.deepEqual(ids(next.items), [rows[2]]); assert.equal(r.followers.dich.lease, B);
    // a release of A that arrives late (A is gone from the role) or has the wrong session, role or lease: nothing changes
    const held = state(r, 'dich'); c.advance(1000);
    for (const args of [[id, 'dich', A, 0], [id, 'dich', C, 0], [id, 'chinh', B, 0], ['00000000-0000-4000-8000-000000000000', 'dich', B, 0]]) { assert.deepEqual(r.release(...args), { released: false }); assert.equal(state(r, 'dich'), held); }
    assert.equal(r.followers.dich.lease, B); await assert.rejects(nx(r, { as: 'dich', after: 0, lease: A }), /FOLLOWER_BUSY/);
    assert.throws(() => r.release(id, 'dich', B, -1), /INVALID_CURSOR/);
    // the main role: agentCursor follows the ack
    await nx(r, { as: 'chinh', after: rows[2], ack: rows[2], lease: A }); assert.equal(r.agentCursor, rows[2]);
    assert.deepEqual(r.release(id, 'chinh', A, rows[0]), { released: true }); assert.equal(r.agentCursor, rows[0]); assert.equal(r.followers.chinh.at, null);
    const noLease = r.compact(); assert.equal(noLease.unread, 2);
    // the meeting has just ended: follow printed its last batch and releases with the final ack. The same meeting, role and lease
    // may still record it, without reopening anything; a stale lease changes nothing, and once another meeting is prepared the old
    // one's release is refused
    await nx(r, { as: 'dich', after: 0, lease: B }); await r.finish(id);
    assert.deepEqual(r.release(id, 'dich', A, rows[0]), { released: false }); assert.equal(r.followers.dich.lease, B);
    assert.deepEqual(r.release(id, 'dich', B, rows[2]), { released: true }); assert.deepEqual(r.followers.dich, { cursor: rows[2], at: null });
    assert.ok(r.session.ended); assert.throws(() => r.ingest('muộn', 'operator_text'), /SESSION_NOT_ACTIVE/);
    r.prepare('Họp sau'); assert.deepEqual(r.release(id, 'dich', B, 0), { released: false });
  });
});

test('G2: the picture is not saved twice for the same text and sources; sources are checked first, so equal text cannot get an outside ID in', async () => {
  await withRuntime(async r => {
    r.prepare('Họp kho'); const id = r.session.id; const a = ing(r, 'Chốt nhập hàng thứ Hai', ''); const b = ing(r, 'Anh Nam lo xe', '');
    assert.deepEqual(r.savePicture(id, '- Đã chốt: thứ Hai', [b, a, a]), { saved: true, revision: 1 });
    assert.deepEqual(r.picture(id).sourceIds, [a, b], 'stored as a normalised set');
    const notes = () => r.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n; assert.equal(notes(), 1);
    assert.deepEqual(r.savePicture(id, '- Đã chốt: thứ Hai', [a, b]), { saved: true, revision: 1, duplicate: true }); assert.equal(notes(), 1);
    assert.deepEqual(r.savePicture(id, '- Đã chốt: thứ Hai', [b, b, a]), { saved: true, revision: 1, duplicate: true }, 'order and repeats do not matter');
    assert.equal(r.savePicture(id, '- Đã chốt: thứ Hai', [a]).revision, 2, 'another set of sources is a new revision'); assert.equal(notes(), 2);
    assert.equal(r.savePicture(id, '- Đã chốt: thứ Ba', [a]).revision, 3, 'other text too');
    assert.equal(r.savePicture(id, '- Đã chốt: thứ Hai', [a]).revision, 4, 'going back to an old text is a new revision, only the latest is compared');
    // outside IDs: refused although the text equals the latest, and nothing is written
    const foreign = r.db.prepare("INSERT INTO sources(session_id,text,origin,start,end,created,boundary) VALUES('other','x','operator_text',0,0,'t','')").run().lastInsertRowid;
    const before = notes();
    for (const bad of [[a, 999999], [Number(foreign)], [a, b, Number(foreign)], [a, 1.5], [a, -1]]) assert.throws(() => r.savePicture(id, '- Đã chốt: thứ Hai', bad), /SOURCE_OUTSIDE_SESSION/);
    assert.throws(() => r.savePicture(id, 'chữ khác', [a, 999999]), /SOURCE_OUTSIDE_SESSION/); assert.equal(notes(), before); assert.equal(r.picture(id).revision, 4);
    assert.throws(() => r.savePicture(id, '', [a]), /INVALID_NOTE/); assert.throws(() => r.savePicture(id, 'x', []), /INVALID_NOTE/);
    await r.finish(id); assert.throws(() => r.savePicture(id, 'sau họp', [a]), /SESSION_NOT_ACTIVE/);
  });
});

test('G2: translate is idempotent in content: the same text twice is one row, the second call says replaced', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id; const lo = ing(r, 'ສະບາຍດີ', LIVE, { language: 'lo' });
    assert.deepEqual(r.translate(id, [{ sourceId: lo, text: 'Xin chào.' }]), { saved: 1, replaced: 0, label: 'Claude dịch' });
    const first = r.db.prepare('SELECT created FROM translations WHERE source_id=?').get(lo).created; await new Promise(res => setTimeout(res, 5));
    assert.deepEqual(r.translate(id, [{ sourceId: lo, text: 'Xin chào.' }]), { saved: 1, replaced: 1, label: 'Claude dịch' });
    assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM translations').get().n, 1); const row = r.db.prepare('SELECT text,created FROM translations WHERE source_id=?').get(lo);
    assert.equal(row.text, 'Xin chào.'); assert.notEqual(row.created, first, 'the row is overwritten (created changes), no revision is added');
    assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0);
  });
});

test('translations are never in what a share role reads', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id; const lo = ing(r, 'ສະບາຍດີ', LIVE, { language: 'lo' }); const secret = ing(r, 'ລັບ', `${MIC}; MIC_STATE_OFF`, { language: 'lo' });
    r.translate(id, [{ sourceId: lo, text: 'bản dịch công khai' }, { sourceId: secret, text: 'bản dịch của dòng riêng' }]);
    for (const out of [JSON.stringify(await nx(r, { as: 'dich' })), JSON.stringify(r.read(id, 0, 100, 'dich')), JSON.stringify(await nx(r, { as: 'chinh' })), JSON.stringify(r.read(id, 0, 100))]) assert.ok(!out.includes('bản dịch'), 'a translation is read from RAW only');
    assert.match(readFileSync(r.writeRaw(id).path, 'utf8'), /→ \(Claude dịch\) bản dịch của dòng riêng/);
  });
});

test('a share role\'s unread counts only rows it may see, so the stop hook never sends it to read hidden ones; chinh counts all', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const hello = ing(r, 'chào cả nhà', LIVE); await nx(r, { as: 'dich', after: hello, ack: hello, lease: A }); await nx(r, { as: 'chinh', after: hello, ack: hello, lease: B });
    ing(r, 'nói riêng lúc tắt mic', `${MIC}; MIC_STATE_OFF; ${LIVE}`); ing(r, 'không rõ trạng thái', `${MIC}; MIC_STATE_UNKNOWN; ${LIVE}`); ing(r, 'phát lại', REPLAY);
    assert.equal(r.compact().followers.dich.unread, 0); assert.equal(r.compact().followers.chinh.unread, 3);
    ing(r, 'người dự nói tiếp', LIVE); assert.equal(r.compact().followers.dich.unread, 1);
  });
});
