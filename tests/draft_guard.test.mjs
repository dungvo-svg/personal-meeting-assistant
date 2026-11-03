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

test('the central picture and reports need chinh to have read the current context', async () => {
  await withFakes(async r => {
    const { id, source } = meeting(r);
    assert.throws(() => r.savePicture(id, 'Bức tranh.', [source], { central: true }), /CONTEXT_NOT_READ/);
    assert.throws(() => r.requireCentralContext(id), /CONTEXT_NOT_READ/);
    r.bind(id, 'chinh', 'agent');
    assert.equal(r.savePicture(id, 'Bức tranh.', [source], { central: true }).revision, 1);
    r.addToContext(id, 'corrections', { raw: 'MTP', corrected: 'Mittaphab', basis: 'user_confirmed', scope: 'meeting', source: 'correction' });
    assert.throws(() => r.savePicture(id, 'Bức tranh 2.', [source], { central: true }), /CONTEXT_NOT_CURRENT/);
    r.bind(id, 'chinh', 'agent');
    assert.equal(r.savePicture(id, 'Bức tranh 2.', [source], { central: true }).revision, 2);
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
