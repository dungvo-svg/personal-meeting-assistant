// The cumulative picture (plan item 10, 0.13.x). 23/11 OTC: the picture was rewritten whole each batch, so per-person figures present in
// revision 12 were gone by revision 26 and a failed last save dropped a whole discussion. The host now keeps STRUCTURED items; the session
// sends only what is new or corrected. Three layers, none touches a real host, device or audio:
//   1. the pure functions (src/picture.ts) on plain data;
//   2. a MeetingRuntime on the temp folders of withFakes, with a meeting and source rows inserted directly (as draft_guard.test.mjs does);
//   3. one isolated TEST host (harness.mjs) driven through its RPC and the CLI, as save_commands.test.mjs does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, withFakes } from './fakes.mjs';
import { MeetingRuntime } from '../dist/runtime.js';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, proveOwned, recordingHost, teardown } from './harness.mjs';
import { assertNoLoss, describeItems, liveItems, pagesOf, planUpdate, PICTURE_LIMITS, renderPicture, validatePictureUpdate } from '../dist/picture.js';

const upd = value => { const v = validatePictureUpdate(value); assert.equal(v.ok, true, JSON.stringify(v)); return v.update; };
const refusedWith = (value, code) => { const v = validatePictureUpdate(value); assert.equal(v.ok, false); assert.equal(v.code, code, JSON.stringify(v)); return v; };

// ---- 1. pure --------------------------------------------------------------------------------------------------------------------------

test('the update shape is closed and its limits are per item and per update, not on the whole picture', () => {
  const item = { kind: 'decision', text: 'Chốt giá P1 là 25.000 kíp.', sourceIds: [3] };
  assert.equal(upd({ add: [item] }).add.length, 1);
  refusedWith({}, 'EMPTY_UPDATE'); refusedWith({ add: [] }, 'EMPTY_UPDATE');
  refusedWith({ dangBan: 'Đang bàn thưởng cuối năm.' }, 'NO_SOURCES');
  assert.equal(upd({ dangBan: 'Đang bàn thưởng cuối năm.', sourceIds: [7] }).dangBan, 'Đang bàn thưởng cuối năm.', 'a dangBan-only update names the rows it was written from');
  refusedWith({ add: [{ ...item, path: 'C:\\x' }] }, 'FORBIDDEN_KEY'); refusedWith({ add: [{ ...item, extra: 1 }] }, 'UNKNOWN_KEY'); refusedWith({ add: [item], run: 'x' }, 'FORBIDDEN_KEY');
  refusedWith({ add: [{ ...item, kind: 'rumour' }] }, 'BAD_VALUE'); refusedWith({ add: [{ ...item, sourceIds: [] }] }, 'BAD_LENGTH'); refusedWith({ add: [{ ...item, sourceIds: [0] }] }, 'BAD_INTEGER');
  refusedWith({ add: [{ ...item, status: 'resolved' }] }, 'BAD_VALUE');   // a new item is open; resolving is an explicit fix
  refusedWith({ add: [{ ...item, text: 'x'.repeat(PICTURE_LIMITS.itemChars + 1) }] }, 'BAD_LENGTH');
  refusedWith({ add: [{ ...item, sourceIds: Array.from({ length: PICTURE_LIMITS.itemSources + 1 }, (_, i) => i + 1) }] }, 'BAD_LENGTH');
  refusedWith({ add: Array.from({ length: PICTURE_LIMITS.addPerUpdate + 1 }, () => item) }, 'BAD_LENGTH');
  refusedWith({ add: [item], dangBan: 'x'.repeat(PICTURE_LIMITS.dangBanChars + 1) }, 'BAD_LENGTH');
  // the whole picture has no size limit of its own: many updates of ordinary size are fine (see the large-picture test)
  const a = validatePictureUpdate({ add: [{ ...item, sourceIds: [2, 1, 1] }] }), b = validatePictureUpdate({ add: [{ sourceIds: [1, 2], text: ' Chốt giá P1 là 25.000 kíp. ', kind: 'decision' }] });
  assert.equal(a.contentHash, b.contentHash, 'same content, same hash, whatever the key order, spacing or source order');
});

const ITEM = (kind, text, sourceIds, more = {}) => ({ kind, text, sourceIds, ...more });
test('items get ids by kind; a retry of the same item is skipped, not added twice', () => {
  const plan = planUpdate([], upd({ add: [ITEM('decision', 'Chốt A', [1]), ITEM('task', 'Anh Nam gửi báo giá', [1], { person: 'Nam', deadline: 'thứ Sáu' }), ITEM('decision', 'Chốt B', [2]), ITEM('number', 'Doanh số Oanh: 120 triệu', [2]), ITEM('question', 'Ai nhận khuyến mại?', [2]), ITEM('fact', 'Họp OTC', [1])] }), 1);
  assert.deepEqual(plan.added.map(a => a.id), ['D1', 'T1', 'D2', 'N1', 'Q1', 'F1']);
  const again = planUpdate(plan.events, upd({ add: [ITEM('decision', ' chốt a ', [9]), ITEM('decision', 'Chốt C', [9])] }), 2);
  assert.deepEqual(again.skipped, ['D1']); assert.deepEqual(again.added.map(a => a.id), ['D3']);
});

test('a fix names the text it replaces, a reason and sources; the old item stays and the picture shows "đã sửa: cũ → mới"', () => {
  const first = planUpdate([], upd({ add: [ITEM('number', 'Giá P1 là 25.000 kíp', [4], { person: 'Oanh' }), ITEM('question', 'Giá P2 bao nhiêu?', [5]), ITEM('task', 'Gửi bảng giá', [5], { person: 'Nam', certainty: 'tentative' })] }), 1).events;
  const fix = (targetId, expectedOld, replacement, extra = {}) => ({ targetId, expectedOld, replacement, sourceIds: [8], reason: 'người nói đính chính', ...extra });
  const two = planUpdate(first, upd({ fix: [fix('N1', 'Giá P1 là 25.000 kíp', { text: 'Giá P1 là 28.000 kíp' })] }), 2);
  assert.deepEqual(two.fixed, [{ targetId: 'N1', newId: 'N2' }]);
  const all = [...first, ...two.events];
  assert.equal(all.find(i => i.id === 'N1').text, 'Giá P1 là 25.000 kíp', 'the old item is untouched');
  assert.equal(all.find(i => i.id === 'N2').person, 'Oanh', 'what the replacement leaves out is carried over (the person is not dropped by a text fix)');
  assert.deepEqual(liveItems(all).map(i => i.id), ['Q1', 'T1', 'N2']);
  const text = renderPicture({ revision: 2, purpose: { label: 'giao việc' }, dangBan: 'Đang bàn giá P2.', items: all });
  assert.match(text, /## Mục đích họp\ngiao việc/); assert.match(text, /## Đang bàn\nĐang bàn giá P2\./);
  assert.match(text, /\[N2\] Giá P1 là 28\.000 kíp — người: Oanh \(#8\)\n  ↳ đã sửa \(bản 2\): “Giá P1 là 25\.000 kíp” → “Giá P1 là 28\.000 kíp” — lý do: người nói đính chính \(#8\)/);
  // resolving a question and closing a task are fixes (a status change with sources); the corrected history stays visible
  const three = planUpdate(all, upd({ fix: [fix('Q1', 'Giá P2 bao nhiêu?', { text: 'Giá P2 bao nhiêu? → 31.000 kíp', status: 'resolved' }), fix('T1', 'Gửi bảng giá', { text: 'Gửi bảng giá', status: 'done' })] }), 3);
  const done = [...all, ...three.events]; const rendered = renderPicture({ revision: 3, dangBan: '', items: done });
  assert.match(rendered, /## Câu hỏi đã có trả lời\n- \[Q2\] Giá P2 bao nhiêu\? → 31\.000 kíp/); assert.doesNotMatch(rendered, /## Câu hỏi mở/);
  assert.match(rendered, /\[T2\] \[xong\] Gửi bảng giá — người: Nam · tạm/, 'person and certainty carried over, status shown');
  assert.equal(describeItems(done).find(i => i.id === 'N2').history[0].text, 'Giá P1 là 25.000 kíp');
});

test('a fix that would silently drop or rewrite is refused: stale old text, an item already corrected, a kind change, no change, a bad status, an unknown target', () => {
  const first = planUpdate([], upd({ add: [ITEM('decision', 'Chốt X', [1]), ITEM('number', 'Con số 5', [1])] }), 1).events;
  const fix = (targetId, expectedOld, replacement) => upd({ fix: [{ targetId, expectedOld, replacement, sourceIds: [2], reason: 'đính chính' }] });
  const code = (items, update) => { try { planUpdate(items, update, 9); } catch (e) { return e.code; } return 'NO_ERROR'; };
  assert.equal(code(first, fix('D1', 'Chốt Y', { text: 'Chốt Z' })), 'PICTURE_FIX_OLD_MISMATCH');
  assert.equal(code(first, fix('D9', 'Chốt X', { text: 'Chốt Z' })), 'PICTURE_FIX_TARGET_UNKNOWN');
  assert.equal(code(first, fix('D1', 'Chốt X', { text: 'Chốt X' })), 'PICTURE_FIX_NO_CHANGE');
  assert.equal(code(first, fix('D1', 'Chốt X', { kind: 'task', text: 'Chốt Z' })), 'PICTURE_FIX_KIND_CHANGE');
  assert.equal(code(first, fix('D1', 'Chốt X', { text: 'Chốt X', status: 'done' })), 'PICTURE_FIX_BAD_STATUS');
  const corrected = [...first, ...planUpdate(first, fix('D1', 'Chốt X', { text: 'Chốt Z' }), 2).events];
  assert.equal(code(corrected, fix('D1', 'Chốt X', { text: 'Chốt W' })), 'PICTURE_FIX_TARGET_SUPERSEDED', 'the old item cannot be corrected again; the live one can');
  assert.equal(code(corrected, fix('D2', 'Chốt Z', { text: 'Chốt W' })), 'NO_ERROR');
  // two fixes of the same item in one update: the second meets the first one's successor
  const twice = upd({ fix: [{ targetId: 'D1', expectedOld: 'Chốt X', replacement: { text: 'A' }, sourceIds: [2], reason: 'r' }, { targetId: 'D1', expectedOld: 'Chốt X', replacement: { text: 'B' }, sourceIds: [2], reason: 'r' }] });
  assert.equal(code(first, twice), 'PICTURE_FIX_TARGET_SUPERSEDED');
  refusedWith({ fix: [{ targetId: 'D1', expectedOld: 'Chốt X', replacement: { text: 'Z' }, sourceIds: [], reason: 'r' }] }, 'BAD_LENGTH');   // no sources, no fix
  refusedWith({ fix: [{ targetId: 'D1', expectedOld: 'Chốt X', replacement: { text: 'Z' }, sourceIds: [2] }] }, 'MISSING_KEY');   // no reason, no fix
  refusedWith({ fix: [{ targetId: '../x', expectedOld: 'Chốt X', replacement: { text: 'Z' }, sourceIds: [2], reason: 'r' }] }, 'BAD_ID');
});

test('the no-loss invariant (the picture analogue of CONFIRMED_OVERRIDE): dropping an item or rewriting one in place is caught', () => {
  const before = planUpdate([], upd({ add: [ITEM('decision', 'Chốt X', [1]), ITEM('task', 'Việc Y', [1], { person: 'Nam' })] }), 1).events;
  const after = [...before, ...planUpdate(before, upd({ add: [ITEM('fact', 'Ghi chú', [2])] }), 2).events];
  assert.doesNotThrow(() => assertNoLoss(before, after));
  assert.throws(() => assertNoLoss(before, after.slice(1)), e => e.code === 'PICTURE_ITEM_LOST');
  assert.throws(() => assertNoLoss(before, after.map(i => i.id === 'D1' ? { ...i, text: 'Chốt X (đã viết đè)' } : i)), e => e.code === 'PICTURE_ITEM_OVERRIDE');
  assert.throws(() => assertNoLoss(before, after.map(i => i.id === 'T1' ? { ...i, person: undefined } : i)), e => e.code === 'PICTURE_ITEM_OVERRIDE', 'dropping the person is a rewrite');
  const dup = [...before, { ...before[0], id: 'D2', supersedes: 'D1', text: 'Z' }, { ...before[0], id: 'D3', supersedes: 'D1', text: 'W' }];
  assert.throws(() => assertNoLoss(before, dup), e => e.code === 'PICTURE_ITEM_OVERRIDE', 'one item corrected twice at once');
});

test('pages hold whole lines, nothing is cut or left out, a line longer than a page is split not dropped', () => {
  const body = Array.from({ length: 400 }, (_, i) => `- [F${i + 1}] ${'chữ '.repeat(30)} (#${i + 1})`).join('\n') + '\n';
  const pages = pagesOf(body, 5000); assert.ok(pages.length > 1); assert.ok(pages.every(p => p.length <= 5000));
  assert.equal(pages.join('\n'), body);
  const long = 'a'.repeat(12000); const split = pagesOf(long, 5000); assert.equal(split.join(''), long); assert.equal(split.length, 3);
  assert.equal(pagesOf('ngắn\n', 5000).join('\n'), 'ngắn\n');
});

// ---- 2. runtime -----------------------------------------------------------------------------------------------------------------------

function meeting(r, sources = 40, context = { me: 'Dũng', agenda: '- Giá' }) {
  const id = randomUUID(); const now = new Date().toISOString();
  r.db.prepare("INSERT INTO sessions(id,title,created,ended,mode,context) VALUES(?,?,?,NULL,'live',?)").run(id, 'Họp OTC', now, JSON.stringify(context));
  const ids = []; for (let n = 1; n <= sources; n++) ids.push(Number(r.db.prepare("INSERT INTO sources(session_id,text,origin,start,end,created,boundary) VALUES(?,?,?,?,?,?,?)").run(id, 'Đoạn ' + n + '.', 'synthetic_fixture', n, n + 1, now, 'final').lastInsertRowid));
  r.session = { id, title: 'Họp OTC', created: now, ended: null, mode: 'live', languages: ['vi'], context };
  return { id, ids };
}
const save = (r, id, update, base, extra = {}) => r.savePictureUpdate(id, upd(update), { expectedRevision: base, ...extra });

test('additions over several batches accumulate: the final picture holds every decision, task and number, and the revisions are history', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r);
    const batches = [
      { add: [ITEM('number', 'Oanh: doanh số 120 triệu', [ids[0]], { person: 'Oanh' }), ITEM('number', 'Nam: doanh số 95 triệu', [ids[0]], { person: 'Nam' })], dangBan: 'Doanh số từng người.' },
      { add: [ITEM('decision', 'Khuyến mại tháng 12 giữ nguyên', [ids[3]])], dangBan: 'Khuyến mại.' },
      { add: [ITEM('task', 'Chị Tar gửi bảng khuyến mại', [ids[5]], { person: 'Tar', deadline: '25/11' }), ITEM('question', 'Thưởng năm chia theo doanh số hay theo đầu người?', [ids[6]])], dangBan: 'Thưởng cuối năm.' },
      { add: [ITEM('decision', 'Thưởng năm chia theo doanh số', [ids[8]])], fix: [{ targetId: 'Q1', expectedOld: 'Thưởng năm chia theo doanh số hay theo đầu người?', replacement: { text: 'Thưởng năm: chia theo doanh số hay đầu người? → theo doanh số', status: 'resolved' }, sourceIds: [ids[8]], reason: 'anh Quân chốt' }], dangBan: 'Đã chốt thưởng.' },
    ];
    let base = 0; const results = [];
    for (const b of batches) { const out = save(r, id, b, base); assert.equal(out.revision, base + 1); results.push(out); base = out.revision; }
    assert.deepEqual(results.map(x => x.added.map(a => a.id)), [['N1', 'N2'], ['D1'], ['T1', 'Q1'], ['D2']]);
    const p = r.picture(id); assert.equal(p.revision, 4); assert.equal(p.structured, true);
    for (const must of ['Oanh: doanh số 120 triệu', 'Nam: doanh số 95 triệu', 'Khuyến mại tháng 12 giữ nguyên', 'Chị Tar gửi bảng khuyến mại — người: Tar · hạn: 25/11', 'Thưởng năm chia theo doanh số', '→ theo doanh số']) assert.ok(p.text.includes(must), 'final picture has: ' + must);
    assert.match(p.text, /đã sửa \(bản 4\): “Thưởng năm chia theo doanh số hay theo đầu người\?” → “Thưởng năm: chia theo doanh số hay đầu người\? → theo doanh số”/);
    assert.match(p.text, /## Mục đích họp\nchưa chọn/); assert.equal(p.dangBan, 'Đã chốt thưởng.');
    // earlier revisions are still in history, each a snapshot of its moment; the first one does not have the later items
    const rev1 = JSON.parse(r.db.prepare("SELECT payload FROM notes WHERE session_id=? AND item_key='buc-tranh' AND revision=1").get(id).payload);
    assert.ok(rev1.text.includes('Oanh: doanh số 120 triệu') && !rev1.text.includes('Khuyến mại tháng 12'));
    assert.equal(r.pictureEvents(id).length, 7, 'every add and fix is one stored event: 2+1+2+1 adds and 1 fix');
    // the SUMMARY writer's data view: live items with their history
    const view = r.pictureItems(id); assert.equal(view.revision, 4); assert.equal(view.items.find(i => i.id === 'Q2').history[0].id, 'Q1');
  });
});

test('"đang bàn" is a snapshot replaced each batch and kept when a batch does not send it; the purpose is rendered at the top', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 5, { me: 'Dũng', agenda: '- Giá', purpose: 'giao-viec' });
    save(r, id, { dangBan: 'Giá P1.', sourceIds: [ids[0]] }, 0);
    save(r, id, { add: [ITEM('fact', 'Có ba loại giá', [ids[1]])] }, 1);
    assert.match(r.picture(id).text, /## Mục đích họp\ngiao việc — ghi việc - người - hạn/); assert.match(r.picture(id).text, /## Đang bàn\nGiá P1\./, 'carried over');
    save(r, id, { dangBan: 'Thưởng.', sourceIds: [ids[2]] }, 2);
    assert.match(r.picture(id).text, /## Đang bàn\nThưởng\./); assert.doesNotMatch(r.picture(id).text, /Giá P1\./);
    assert.match(r.picture(id).text, /Có ba loại giá/, 'the cumulative part is not touched by a new "đang bàn"');
  });
});

test('sources must belong to the session; the base is checked; a stale base is a conflict that says what to do and changes nothing', async () => {
  await withFakes(async r => {
    const other = meeting(r, 2); const { id, ids } = meeting(r, 4);   // other.ids belong to another meeting
    assert.throws(() => save(r, id, { add: [ITEM('fact', 'X', [other.ids[0]])] }, 0), /SOURCE_OUTSIDE_SESSION/);
    assert.throws(() => save(r, id, { add: [ITEM('fact', 'X', [999999])] }, 0), /SOURCE_OUTSIDE_SESSION/);
    assert.equal(r.picture(id), null); assert.equal(r.pictureEvents(id).length, 0);
    save(r, id, { add: [ITEM('fact', 'Một', [ids[0]])] }, 0);
    assert.throws(() => save(r, id, { add: [ITEM('fact', 'Hai', [ids[1]])] }, 0), /PICTURE_REVISION_CONFLICT: .*đã có bản 1.*đọc lại pma picture.*--base 1/);
    assert.equal(r.pictureEvents(id).length, 1, 'a conflict saves nothing');
    assert.equal(save(r, id, { add: [ITEM('fact', 'Hai', [ids[1]])] }, 1).revision, 2);
  });
});

test('the central picture update needs the receipt of a chinh read of the current context, like the whole-text save', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 3);
    const update = { add: [ITEM('fact', 'Một', [ids[0]])] };
    assert.throws(() => save(r, id, update, 0, { central: true }), /CONTEXT_NOT_READ/);
    assert.throws(() => save(r, id, update, 0, { central: true, receipt: 'agent' }), /CONTEXT_RECEIPT_UNKNOWN|CONTEXT_NOT_READ/);
    const { receipt } = r.contextReceipt(id, 'chinh');
    assert.equal(save(r, id, update, 0, { central: true, receipt }).revision, 1);
    r.addToContext(id, 'corrections', { raw: 'MTP', corrected: 'Mittaphab', basis: 'user_confirmed', scope: 'meeting', source: 'correction' });
    assert.throws(() => save(r, id, { add: [ITEM('fact', 'Hai', [ids[1]])] }, 1, { central: true, receipt }), /CONTEXT_NOT_CURRENT/);
    assert.equal(r.pictureEvents(id).length, 1);
  });
});

test('same key and same content gives the earlier receipt, even after a newer revision; the same key with other content is refused', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 4);
    const run = (update, key, base) => { const v = validatePictureUpdate(update); return r.draftOnce(id, 'picture', key, v.contentHash, () => r.savePictureUpdate(id, v.update, { expectedRevision: base })); };
    const first = run({ add: [ITEM('decision', 'Chốt A', [ids[0]])] }, 'k1', 0);
    assert.equal(first.revision, 1); assert.equal(first.receipt.state, 'SAVED');
    const second = run({ add: [ITEM('decision', 'Chốt B', [ids[1]])] }, 'k2', 1); assert.equal(second.revision, 2);
    const replay = run({ add: [ITEM('decision', 'Chốt A', [ids[0]])] }, 'k1', 0);   // the timed-out caller retries with its old base
    assert.equal(replay.duplicate, true); assert.equal(replay.revision, 1); assert.deepEqual(replay.added, [{ id: 'D1', kind: 'decision' }]);
    assert.equal(r.pictureEvents(id).length, 2, 'the replay wrote nothing');
    assert.throws(() => run({ add: [ITEM('decision', 'Chốt C', [ids[2]])] }, 'k1', 2), /IDEMPOTENCY_KEY_REUSED/);
    // without a key, the same items again (a retry under no key) add nothing and make no new revision
    const nothing = run({ add: [ITEM('decision', 'Chốt A', [ids[0]]), ITEM('decision', 'Chốt B', [ids[1]])] }, undefined, 2);
    assert.equal(nothing.duplicate, true); assert.equal(nothing.revision, 2); assert.deepEqual(nothing.skipped, ['D1', 'D2']);
  });
});

test('an error anywhere leaves nothing half saved: events, snapshot, revision and key go together', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 4);
    save(r, id, { add: [ITEM('decision', 'Chốt A', [ids[0]])] }, 0);
    // The snapshot is the LAST write: a fault on inserting revision 2 makes it fail after the events were written.
    const before = r.pictureEvents(id).length;
    r.db.exec("CREATE TRIGGER block_rev2 BEFORE INSERT ON notes WHEN NEW.revision=2 AND NEW.item_key='buc-tranh' BEGIN SELECT RAISE(ABORT,'DISK_FULL_TEST'); END;");
    assert.throws(() => save(r, id, { add: [ITEM('task', 'Việc B', [ids[1]])], fix: [{ targetId: 'D1', expectedOld: 'Chốt A', replacement: { text: 'Chốt A2' }, sourceIds: [ids[1]], reason: 'r' }] }, 1), /DISK_FULL_TEST/);
    assert.equal(r.pictureEvents(id).length, before, 'the events were rolled back with the snapshot'); assert.equal(r.picture(id).revision, 1); assert.equal(r.db.isTransaction, false);
    // through draftOnce too: the key is not kept for a save that failed, and the retry after the fault is cleared saves everything
    const v = validatePictureUpdate({ add: [ITEM('task', 'Việc B', [ids[1]])] });
    assert.throws(() => r.draftOnce(id, 'picture', 'kx', v.contentHash, () => r.savePictureUpdate(id, v.update, { expectedRevision: 1 })), /DISK_FULL_TEST/);
    assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM draft_keys WHERE key='kx'").get().n, 0);
    r.db.exec('DROP TRIGGER block_rev2');
    assert.equal(r.draftOnce(id, 'picture', 'kx', v.contentHash, () => r.savePictureUpdate(id, v.update, { expectedRevision: 1 })).revision, 2);
    assert.equal(r.pictureEvents(id).length, before + 1);
    // an update that violates the rules (a fix of an unknown item) fails before anything is written
    assert.throws(() => save(r, id, { add: [ITEM('fact', 'Không được lưu', [ids[2]])], fix: [{ targetId: 'D9', expectedOld: 'x', replacement: { text: 'y' }, sourceIds: [ids[2]], reason: 'r' }] }, 2), /PICTURE_FIX_TARGET_UNKNOWN/);
    assert.equal(r.pictureEvents(id).length, before + 1, 'the valid add in the same update was not saved either');
  });
});

test('the stored events are immutable: no UPDATE, no DELETE', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 2); save(r, id, { add: [ITEM('decision', 'Chốt A', [ids[0]])] }, 0);
    assert.throws(() => r.db.prepare("UPDATE picture_events SET text='đã đổi' WHERE session_id=?").run(id), /PICTURE_EVENTS_IMMUTABLE/);
    assert.throws(() => r.db.prepare('DELETE FROM picture_events WHERE session_id=?').run(id), /PICTURE_EVENTS_IMMUTABLE/);
    assert.equal(r.pictureEvents(id)[0].text, 'Chốt A');
  });
});

test('a host restart keeps the items: a second runtime on the same data folder reads them and goes on from the same revision', async () => {
  await withFakes(async (r, dir, root) => {
    const { id, ids } = meeting(r, 5);
    save(r, id, { add: [ITEM('decision', 'Chốt A', [ids[0]]), ITEM('task', 'Việc B', [ids[1]], { person: 'Nam' })], dangBan: 'Đang bàn A.' }, 0);
    save(r, id, { fix: [{ targetId: 'D1', expectedOld: 'Chốt A', replacement: { text: 'Chốt A (sửa)' }, sourceIds: [ids[2]], reason: 'đính chính' }] }, 1);
    const before = r.picture(id).text;
    r.db.prepare('UPDATE sessions SET ended=? WHERE id=?').run(new Date().toISOString(), id); r.session = null;   // the meeting is over; the first host is gone
    const next = new MeetingRuntime(root, dir, true); next.mixer = () => {};
    try {
      assert.equal(next.picture(id).text, before); assert.deepEqual(next.pictureEvents(id).map(i => i.id), ['D1', 'T1', 'D2']);
      const out = next.savePictureUpdate(id, upd({ add: [ITEM('fact', 'Sau khi khởi động lại', [ids[3]])] }), { expectedRevision: 2 });
      assert.equal(out.revision, 3); assert.match(next.picture(id).text, /Chốt A \(sửa\)/); assert.match(next.picture(id).text, /Đang bàn A\./); assert.match(next.picture(id).text, /Sau khi khởi động lại/);
    } finally { await next.close(); }
  });
});

test('a large picture is saved whole (limits are per item) and read in pages with nothing left out', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 30); let base = 0;
    for (let batch = 0; batch < 12; batch++) {
      const add = Array.from({ length: 40 }, (_, k) => ITEM(k % 2 ? 'number' : 'decision', `Mục ${batch}-${k}: ${'nội dung dài '.repeat(25)}`, [ids[(batch + k) % 30]]));
      base = save(r, id, { add }, base).revision;
    }
    const p = r.picture(id); assert.equal(p.revision, 12); assert.equal(r.pictureEvents(id).length, 480);
    assert.ok(p.text.length > PICTURE_LIMITS.pageChars * 5, 'far beyond the old 30000-character whole-picture limit: ' + p.text.length);
    for (const probe of ['Mục 0-0:', 'Mục 5-17:', 'Mục 11-39:']) assert.ok(p.text.includes(probe), probe);
    const pages = pagesOf(p.text); assert.ok(pages.length > 5); assert.equal(pages.join('\n'), p.text, 'every character is on some page');
    assert.equal(r.pictureItems(id).items.length, 480);
  });
});

test('the whole-text save still works as a historical snapshot, is refused once items exist, and its text is carried, never dropped', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 4);
    assert.equal(r.savePicture(id, 'Bức tranh viết tay cả buổi.', [ids[0]], { expectedRevision: 0 }).revision, 1);
    assert.equal(r.picture(id).structured, undefined, 'a legacy picture does not pretend to be split into items');
    assert.equal(r.pictureEvents(id).length, 0);
    save(r, id, { add: [ITEM('decision', 'Chốt A', [ids[1]])] }, 1);
    const text = r.picture(id).text; assert.match(text, /Chốt A/); assert.match(text, /## Bản viết tay trước đó \(bản 1;[^\n]*\nBức tranh viết tay cả buổi\./, 'the handwritten text is kept, not lost');
    assert.throws(() => r.savePicture(id, 'Viết lại cả bức tranh.', [ids[2]], { expectedRevision: 2 }), /PICTURE_HAS_ITEMS/);
    assert.equal(r.picture(id).revision, 2, 'the whole-text save changed nothing');
  });
});

test('chinh progress: an update covers up to what chinh was handed, not what it merely cited', async () => {
  await withFakes(async r => {
    const { id, ids } = meeting(r, 10);
    r.followers.chinh = { cursor: ids[4], at: null };
    save(r, id, { add: [ITEM('decision', 'Chốt A', [ids[1], ids[8]])] }, 0);   // cites #9 but chinh was only handed up to #5
    assert.equal(r.committedOf(id, 'chinh', false), ids[4], 'covers min(cited, handed)');
    r.followers.chinh = { cursor: ids[9], at: null };
    assert.equal(r.committedOf(id, 'chinh', false), ids[4], 'coverage is fixed at save time: a later read does not lift it');
    save(r, id, { add: [ITEM('fact', 'Ghi chú', [ids[9]])] }, 1);
    assert.equal(r.committedOf(id, 'chinh', false), ids[9]);
  });
});

// ---- 3. an isolated test host, its RPC and the CLI ------------------------------------------------------------------------------------

const run = promisify(execFile);
const world = await isolatedEnv('picture-items'); const env = world.env; const restoreEnv = applyEnv(env);
const call = guardedCall(env);
const cliRaw = (...args) => run(process.execPath, [resolve('dist/cli.js'), ...args], { env, maxBuffer: 16 * 1024 * 1024 });
const cli = async (...args) => { await proveOwned(env); return cliRaw(...args); };
const files = mkdtempSync(join(tmpdir(), 'pma-picture-items-'));
const file = (name, value) => { const path = join(files, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); return path; };
const refused = async (...args) => { const e = await cli(...args).then(() => null, error => error); assert.ok(e, 'the command was refused: ' + args.join(' ')); assert.equal(e.code, 1); return JSON.parse(e.stdout).error; };
const ok = async (...args) => JSON.parse((await cli(...args)).stdout);
test.after(async () => { try { assertCleaned(await teardown(world)); } finally { restoreEnv(); } });

test('host and CLI: pma picture update saves with a receipt, refuses in Vietnamese, replays by key, paginates and gives the items as JSON', async () => {
  await recordingHost(env, () => cliRaw('history'));
  await call('prepare', { title: 'Họp thử', fixture: true, purpose: 'giao-viec' });
  const a = (await call('fixture', { text: 'Đoạn một.' })).id; const b = (await call('fixture', { text: 'Đoạn hai.' })).id;
  const { receipt } = await call('brief', { as: 'chinh' });
  const add = file('u1.json', { add: [ITEM('decision', 'Chốt giá P1 là 25.000 kíp', [a]), ITEM('task', 'Nam gửi báo giá', [b], { person: 'Nam', deadline: 'thứ Sáu' })], dangBan: 'Giá P1.' });
  assert.match(await refused('picture', 'update', '--base', '0', '--receipt', receipt), /^SAVE_NEEDS_FILE: pma picture update cần --file/);
  assert.match(await refused('picture', 'update', '--file', add, '--sources', '1', '--base', '0', '--receipt', receipt), /^SOURCES_IN_JSON/);
  assert.match(await refused('picture', 'update', '--file', file('bad.json', '{không phải json'), '--base', '0', '--receipt', receipt), /^JSON_INVALID: bản cập nhật bức tranh/);
  assert.match(await refused('picture', 'update', '--file', add, '--receipt', receipt), /^BASE_REVISION_REQUIRED/);
  assert.match(await refused('picture', 'update', '--file', add, '--base', '0'), /^CONTEXT_NOT_READ/);
  assert.match(await refused('picture', 'update', '--file', file('empty.json', '{}'), '--base', '0', '--receipt', receipt), /^INVALID_PICTURE_UPDATE: EMPTY_UPDATE .*cần add, fix hoặc dangBan/);
  assert.match(await refused('picture', 'update', '--file', file('nosrc.json', { dangBan: 'x' }), '--base', '0', '--receipt', receipt), /^INVALID_PICTURE_UPDATE: NO_SOURCES/);
  assert.equal(await call('picture', {}), null, 'nothing was saved by any refusal');

  const saved = await ok('picture', 'update', '--file', add, '--base', '0', '--receipt', receipt, '--key', 'b1');
  assert.equal(saved.revision, 1); assert.match(saved.line, /^ĐÃ LƯU bức tranh \(cập nhật: thêm D1, T1\) \(bản 1\)$/);
  const replay = await ok('picture', 'update', '--file', add, '--base', '0', '--receipt', receipt, '--key', 'b1');
  assert.equal(replay.duplicate, true); assert.match(replay.line, /^GIỐNG HỆT bản đã có/);
  assert.match(await refused('picture', 'update', '--file', add, '--base', '0', '--receipt', receipt), /PICTURE_REVISION_CONFLICT/, 'a stale base without a key is a conflict');

  const fix = file('u2.json', { fix: [{ targetId: 'D1', expectedOld: 'Chốt giá P1 là 25.000 kíp', replacement: { text: 'Chốt giá P1 là 28.000 kíp' }, sourceIds: [b], reason: 'người nói đính chính' }] });
  const fixed = await ok('picture', 'update', '--file', fix, '--base', '1', '--receipt', receipt);
  assert.match(fixed.line, /^ĐÃ LƯU bức tranh \(cập nhật: sửa D1→D2\) \(bản 2\)$/);
  assert.match(await refused('picture', 'update', '--file', fix, '--base', '2', '--receipt', receipt), /^PICTURE_FIX_TARGET_SUPERSEDED/);
  // the whole-text save is refused now (it would replace the items)
  assert.match(await refused('picture', '--file', file('whole.md', '# Bức tranh mới'), '--sources', String(a), '--base', '2', '--receipt', receipt), /^PICTURE_HAS_ITEMS/);

  const text = (await cli('picture')).stdout;
  assert.match(text, /^# Bức tranh cuộc họp \(bản 2, /); assert.match(text, /## Mục đích họp\ngiao việc/); assert.match(text, /\[D2\] Chốt giá P1 là 28\.000 kíp/); assert.match(text, /đã sửa \(bản 2\): “Chốt giá P1 là 25\.000 kíp” → “Chốt giá P1 là 28\.000 kíp”/);
  assert.match(text, /\[T1\] Nam gửi báo giá — người: Nam · hạn: thứ Sáu/); assert.match(text, /## Đang bàn\nGiá P1\./);
  const json = await ok('picture', '--json'); assert.equal(json.revision, 2); assert.deepEqual(json.items.map(i => i.id), ['T1', 'D2']); assert.equal(json.items.find(i => i.id === 'D2').history[0].id, 'D1');

  // a big picture is read in pages, and the CLI says how many are left
  let base = 2;
  for (let batch = 0; batch < 6; batch++) {
    const items = Array.from({ length: 40 }, (_, k) => ITEM('fact', `Ghi ${batch}-${k}: ${'nội dung '.repeat(40)}`, [a]));
    base = (await ok('picture', 'update', '--file', file(`big${batch}.json`, { add: items }), '--base', String(base), '--receipt', receipt)).revision;
  }
  const page1 = (await cli('picture')).stdout; assert.match(page1, /\[trang 1\/\d+\]/); assert.match(page1, /CÒN \d+ TRANG: pma picture --page 2/);
  const all = (await cli('picture', '--page', 'all')).stdout; assert.ok(all.includes('Ghi 0-0:') && all.includes('Ghi 5-39:') && all.includes('Chốt giá P1 là 28.000 kíp'), '--page all prints everything');
  assert.match(await refused('picture', '--page', '99'), /^PAGE_OUT_OF_RANGE/);
  const last = (await cli('picture', '--page', String(Number(page1.match(/\[trang 1\/(\d+)\]/)[1])))).stdout; assert.match(last, /\[hết\]/);
});
