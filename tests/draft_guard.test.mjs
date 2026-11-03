// Drafts handed to the host (Codex review of 9b02494): the central session's picture and reports count only from a reader of the
// current context; a picture edited from an older revision is a conflict; a report the disk refused is not recorded; the same report
// again adds no row. A MeetingRuntime on the temp folders of withFakes with the meeting and one source row inserted directly:
// nothing is prepared or spawned, no device, no audio, no host. The client's attach-only path is read as text (no host is started).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, withFakes } from './fakes.mjs';

function meeting(r) {
  const id = randomUUID(); const now = new Date().toISOString();
  r.db.prepare("INSERT INTO sessions(id,title,created,ended,mode,context) VALUES(?,?,?,NULL,'live',?)").run(id, 'Họp thử', now, JSON.stringify({ me: 'Dũng', agenda: '- Giá' }));
  const source = Number(r.db.prepare("INSERT INTO sources(session_id,text,origin,start,end,created,boundary) VALUES(?,?,?,?,?,?,?)").run(id, 'Đoạn một.', 'synthetic_fixture', 0, 1, now, 'final').lastInsertRowid);
  r.session = { id, title: 'Họp thử', created: now, ended: null, mode: 'live', languages: ['vi'], context: { me: 'Dũng', agenda: '- Giá' } };
  return { id, source };
}

test('drafts never start a host: the CLI sends them through attach, and attach does not call ensureDaemon', () => {
  const client = readFileSync(resolve('src/client.ts'), 'utf8'); const cli = readFileSync(resolve('src/cli.ts'), 'utf8');
  const body = client.slice(client.indexOf('export async function attach'), client.indexOf('export async function attach') + 600);
  assert.ok(body.length > 0 && !/ensureDaemon/.test(body), 'attach must not start a host');
  for (const method of ['picture', 'translate', 'participants', 'summary', 'tasks']) assert.match(cli, new RegExp(`attach\\('${method}'`), method + ' goes through attach');
  assert.match(cli, /attach\('job', \{ \.\.\.session, action, id: Number\(positional\[1\]\), result/, 'job done goes through attach');
});

test('the central picture and reports need the receipt of a chinh read of the current context; the shared reader is not one', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    assert.throws(() => r.savePicture(id, 'Bức tranh.', [source], { central: true }), /CONTEXT_NOT_READ/);
    r.bind(id, 'chinh', 'agent');
    assert.throws(() => r.savePicture(id, 'Bức tranh.', [source], { central: true, receipt: 'agent' }), /CONTEXT_RECEIPT_UNKNOWN|CONTEXT_NOT_READ/, 'the shared reader every process uses is no receipt');
    const other = r.contextReceipt(id, 'dich').receipt;
    assert.throws(() => r.requireCentralContext(id, other), /CONTEXT_RECEIPT_UNKNOWN/, 'a receipt of another role');
    const { receipt } = r.contextReceipt(id, 'chinh'); assert.match(receipt, /^rcpt-[a-f0-9]{16}$/);
    assert.equal(r.savePicture(id, 'Bức tranh.', [source], { central: true, receipt }).revision, 1);
    r.addToContext(id, 'corrections', { raw: 'MTP', corrected: 'Mittaphab', basis: 'user_confirmed', scope: 'meeting', source: 'correction' });
    assert.throws(() => r.savePicture(id, 'Bức tranh 2.', [source], { central: true, receipt }), /CONTEXT_NOT_CURRENT/);
    const again = r.contextReceipt(id, 'chinh').receipt; assert.notEqual(again, receipt);
    assert.equal(r.savePicture(id, 'Bức tranh 2.', [source], { central: true, receipt: again }).revision, 2);
  });
});

test('an idempotency key gives back the first result for the same content and refuses other content; no key remembers nothing', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    const save = text => () => r.savePicture(id, text, [source]);
    const first = r.draftOnce(id, 'picture', 'k1', 'h1', save('Một.'));
    assert.equal(first.revision, 1); assert.equal(first.receipt.state, 'SAVED'); assert.equal(first.receipt.delivered, 'NOT_AVAILABLE');
    const again = r.draftOnce(id, 'picture', 'k1', 'h1', () => { throw new Error('must not save twice'); });
    assert.equal(again.duplicate, true); assert.equal(again.revision, 1);
    assert.throws(() => r.draftOnce(id, 'picture', 'k1', 'h2', save('Khác.')), /IDEMPOTENCY_KEY_REUSED/);
    assert.equal(r.draftOnce(id, 'picture', undefined, 'h3', save('Hai.')).revision, 2);
    assert.equal(r.draftOnce(id, 'picture', undefined, 'h1', save('Một.')).revision, 3, 'an edit back to an earlier text still saves without a key');
    assert.throws(() => r.draftOnce(id, 'summary', 'k9', 'h9', () => { throw new Error('DISK'); }), /DISK/);
    assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM draft_keys WHERE key='k9'").get().n, 0, 'a failed save keeps no key');
  });
});

test('a background job is finished only with the token its start returned', async () => {
  await withFakes(async r => {
    const { id } = meeting(r);
    const job = r.ledger.jobs.start(id, 'analysis', 'So sánh giá'); const token = r.jobToken(job);
    assert.match(token, /^job-[a-f0-9]{16}$/);
    assert.throws(() => r.requireJobToken(job), /JOB_TOKEN_REQUIRED/);
    assert.throws(() => r.requireJobToken(job, 'job-0000000000000000'), /JOB_TOKEN_REQUIRED/);
    assert.doesNotThrow(() => r.requireJobToken(job, token));
  });
});

test('a picture edited from an older revision is a conflict; the same picture again is not a new revision', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    assert.equal(r.savePicture(id, 'Bản một.', [source], { expectedRevision: 0 }).revision, 1);
    assert.equal(r.savePicture(id, 'Bản hai.', [source], { expectedRevision: 1 }).revision, 2);
    assert.throws(() => r.savePicture(id, 'Bản sửa từ bản một.', [source], { expectedRevision: 1 }), /PICTURE_REVISION_CONFLICT/);
    assert.equal(r.picture(id).text, 'Bản hai.', 'nothing overwritten');
    assert.deepEqual(r.savePicture(id, 'Bản hai.', [source], { expectedRevision: 1 }), { saved: true, revision: 2, duplicate: true }, 'a resend of what is saved');
  });
});

test('a report the disk refuses is not recorded; the same report again adds no row', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    const rows = () => Number(r.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE session_id=? AND kind='summary'").get(id).n);
    const first = r.saveSummary(id, '- Một.', [source]);
    assert.equal(rows(), 1); assert.match(readFileSync(first.path, 'utf8'), /- Một\./);
    assert.equal(r.saveSummary(id, '- Một.', [source]).duplicate, true); assert.equal(rows(), 1, 'a resend adds no row');
    // The file's place is taken by a folder: the write fails, and the database gets nothing.
    rmSync(first.path); mkdirSync(first.path);
    assert.throws(() => r.saveSummary(id, '- Hai.', [source]), /REPORT_NOT_WRITTEN/);
    assert.equal(rows(), 1, 'nothing recorded for a report that is not on disk');
    rmSync(first.path, { recursive: true });
  });
});

// Codex review of 9124eb3: the key, the job token and the save are one commit; the base revision catches a late result of the same writer.
test('a key that cannot be written leaves no saved picture (the key is reserved first, in the same transaction)', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    r.db.exec("CREATE TRIGGER deny_keys BEFORE INSERT ON draft_keys BEGIN SELECT RAISE(ABORT, 'KEY_STORE_DENIED'); END;");
    assert.throws(() => r.draftOnce(id, 'picture', 'k1', 'h1', () => r.savePicture(id, 'Một.', [source])), /KEY_STORE_DENIED/);
    assert.equal(r.picture(id), null, 'no picture without its key'); assert.equal(r.db.isTransaction, false);
    r.db.exec('DROP TRIGGER deny_keys');
    // The key is completed after the save: a failing completion also leaves nothing.
    r.db.exec("CREATE TRIGGER deny_done BEFORE UPDATE ON draft_keys BEGIN SELECT RAISE(ABORT, 'KEY_COMPLETE_DENIED'); END;");
    assert.throws(() => r.draftOnce(id, 'picture', 'k2', 'h2', () => r.savePicture(id, 'Hai.', [source])), /KEY_COMPLETE_DENIED/);
    assert.equal(r.picture(id), null); assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM draft_keys").get().n, 0);
    r.db.exec('DROP TRIGGER deny_done');
    assert.equal(r.draftOnce(id, 'picture', 'k2', 'h2', () => r.savePicture(id, 'Hai.', [source])).revision, 1, 'the retry with the same key saves once');
    assert.throws(() => r.draftOnce(id, 'picture', 'k2', 'h3', () => r.savePicture(id, 'Khác.', [source])), /IDEMPOTENCY_KEY_REUSED/);
    // Translations join the same transaction instead of failing on a nested BEGIN.
    r.db.prepare("UPDATE sources SET language='lo' WHERE id=?").run(source);
    assert.equal(r.draftOnce(id, 'translations', 't1', 'ht', () => r.translate(id, [{ sourceId: source, text: 'Xin chào' }])).saved, 1);
  });
});

test('a job and its token are one commit; a job made after tokens exist with no token cannot be finished', async () => {
  await withFakes(async r => {
    const { id } = meeting(r);
    r.db.exec("CREATE TRIGGER deny_tokens BEFORE INSERT ON job_tokens BEGIN SELECT RAISE(ABORT, 'TOKEN_DENIED'); END;");
    const before = r.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    assert.throws(() => r.startJob(id, 'analysis', 'So sánh giá'), /TOKEN_DENIED/);
    assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, before, 'no job without its token');
    r.db.exec('DROP TRIGGER deny_tokens');
    // A job that got no token some other way (made directly in the ledger) is not legacy: it fails closed.
    const orphan = r.ledger.jobs.start(id, 'analysis', 'Không token');
    assert.throws(() => r.requireJobToken(orphan), /JOB_TOKEN_MISSING/);
    const { id: job, token } = r.startJob(id, 'analysis', 'Có token');
    assert.throws(() => r.requireJobToken(job), /JOB_TOKEN_REQUIRED/); assert.doesNotThrow(() => r.requireJobToken(job, token));
  });
});

test('a late report derived from an older version is refused by its base revision; the same content again is not', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    assert.equal(r.saveSummary(id, '- Bản một.', [source], 0).revision, 1);
    assert.equal(r.saveSummary(id, '- Bản hai, đã chốt.', [source], 1).revision, 2);
    assert.throws(() => r.saveSummary(id, '- Bản một, sửa thêm (kết quả trễ).', [source], 1), /REPORT_REVISION_CONFLICT/);
    assert.match(readFileSync(r.saveSummary(id, '- Bản hai, đã chốt.', [source], 1).path, 'utf8'), /Bản hai, đã chốt/, 'a resend of what is saved is a duplicate, not a conflict');
    assert.equal(r.reportRevision(id, 'summary'), 2);
  });
});
