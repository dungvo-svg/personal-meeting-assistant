// 0.13.0 items 5, 6, 7 against a real TEST host (isolated world, fixture session, no audio): every save command ends in a receipt or a
// Vietnamese refusal (never silence), an empty/blank participant role is "no role", and translate/picture still save for a short
// while after `pma stop`. Same harness rules as daemon.test.mjs: nothing is sent to a host this test did not start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, proveOwned, recordingHost, teardown } from './harness.mjs';

const run = promisify(execFile);
const world = await isolatedEnv('save-commands'); const env = world.env; const restoreEnv = applyEnv(env);
const call = guardedCall(env);
const cliRaw = (...args) => run(process.execPath, [resolve('dist/cli.js'), ...args], { env });
const cli = async (...args) => { await proveOwned(env); return cliRaw(...args); };
const files = mkdtempSync(join(tmpdir(), 'pma-save-files-'));
const file = (name, text) => { const path = join(files, name); writeFileSync(path, text, 'utf8'); return path; };
// A failed command prints {"error": …} on stdout and exits 1.
const refused = async (...args) => { const e = await cli(...args).then(() => null, error => error); assert.ok(e, 'the command was refused: ' + args.join(' ')); assert.equal(e.code, 1); return JSON.parse(e.stdout).error; };
const ok = async (...args) => JSON.parse((await cli(...args)).stdout);

test.after(async () => { try { assertCleaned(await teardown(world)); } finally { restoreEnv(); } });

test('picture: a save without --file, without --sources, with an empty file or a bad #id is refused in Vietnamese; a good one prints its receipt, an identical one says so', async () => {
  await recordingHost(env, () => cliRaw('history'));
  await call('prepare', { title: 'Họp thử', fixture: true });
  const first = (await call('fixture', { text: 'Đoạn một.' })).id; const second = (await call('fixture', { text: 'Đoạn hai.' })).id;
  const { receipt } = await call('brief', { as: 'chinh' });
  const picture = file('picture.md', '# Bức tranh\n\nĐang bàn đoạn một.');
  // 23/11: `pma picture --base 26` said nothing and the picture stayed as it was.
  assert.match(await refused('picture', '--base', '0'), /^SAVE_NEEDS_FILE: --base .*Chưa lưu gì/);
  assert.match(await refused('picture', '--file', picture, '--base', '0', '--receipt', receipt), /^SOURCES_REQUIRED: .*cần --sources.*ít nhất một #id có chữ thật/);
  assert.match(await refused('picture', '--file', picture, '--sources', '--base', '0'), /^SOURCES_REQUIRED/, 'a --sources with no value is the same as none');
  assert.match(await refused('picture', '--file', picture, '--sources', 'abc,12', '--base', '0'), /^SOURCES_INVALID: .*abc/);
  assert.match(await refused('picture', '--file', file('empty.md', '  \n'), '--sources', String(first), '--base', '0', '--receipt', receipt), /^CONTENT_EMPTY: bức tranh/);
  // The host's own zod refusal is readable too (a client that skips the CLI checks, e.g. the MCP adapter).
  await assert.rejects(call('picture', { text: 'x', sourceIds: [], expectedRevision: 0, receipt }), /INVALID_INPUT: cần ít nhất một #id có chữ thật trong --sources/);
  await assert.rejects(call('picture', { text: '', sourceIds: [first], expectedRevision: 0, receipt }), /INVALID_INPUT: .*đang rỗng/);
  await assert.rejects(call('picture', { text: 'x', sourceIds: [first], expectedRevision: -1, receipt }), /INVALID_INPUT: .*--base/);
  assert.equal((await call('picture', {})), null, 'nothing was saved by any refusal');

  const saved = await ok('picture', '--file', picture, '--sources', `${first},#${second}`, '--base', '0', '--receipt', receipt);
  assert.equal(saved.revision, 1); assert.match(saved.line, new RegExp(`^ĐÃ LƯU bức tranh \\(bản 1, ${'# Bức tranh\n\nĐang bàn đoạn một.'.length} ký tự, nguồn #${first}, #${second}\\)$`));
  const again = await ok('picture', '--file', picture, '--sources', `${first},${second}`, '--base', '1', '--receipt', receipt);
  assert.equal(again.duplicate, true); assert.match(again.line, /^GIỐNG HỆT bản đã có, không tạo bản mới: bức tranh \(bản 1/);
  assert.match(await refused('picture', '--file', picture, '--sources', String(first), '--base', '0', '--receipt', receipt), /BASE|REVISION_CONFLICT|giống|PICTURE/i, 'a stale --base is an error, never silence');
});

test('translate, participants, job done, summary and tasks each print a receipt; their refusals are readable', async () => {
  const lao = (await call('fixture', { text: 'ສະບາຍດີ', language: 'lo' })).id; const plain = (await call('fixture', { text: 'Xin chào.' })).id;
  // translate
  assert.match(await refused('translate', '--text', 'Xin chào'), /^TRANSLATE_NEEDS_SOURCE/);
  assert.match(await refused('translate', '--source', String(lao)), /^TRANSLATE_NEEDS_TEXT/);
  assert.match(await refused('translate', '--file', file('bad.json', '{không phải json')), /^JSON_INVALID: bản dịch/);
  const translated = await ok('translate', '--source', `#${lao}`, '--text', 'Xin chào');
  assert.match(translated.line, new RegExp(`^ĐÃ LƯU bản dịch \\(8 ký tự, nguồn #${lao}\\)$`));
  assert.match(await refused('translate', '--source', String(plain), '--text', 'x'), /TRANSLATE_ONLY_LAO/);
  // participants: an empty or blank role is "no role" (item 6); the receipt says how many people
  const people = file('people.json', JSON.stringify([{ name: 'An', role: '' }, { name: 'Bình', role: '   ', languages: ['vi'] }, { name: 'Chi', role: 'Kế toán' }]));
  const listed = await ok('participants', '--file', people);
  assert.equal(listed.participants, 3); assert.match(listed.line, /^ĐÃ LƯU danh sách người dự/);
  assert.deepEqual((await call('context')).agenda.participants.map(p => [p.name, p.role]), [['An', undefined], ['Bình', undefined], ['Chi', 'Kế toán']]);
  await assert.rejects(call('participants', { participants: [{ name: 'Dũng', role: 'x'.repeat(121) }] }), /INVALID_DRAFT: participants BAD_LENGTH content\.participants\[0\]\.role — mục thứ 1, trường role/);
  assert.match(await refused('participants', '--file', file('empty.json', '')), /^CONTENT_EMPTY: danh sách người dự/);
  // job done
  const job = await call('job', { action: 'start', title: 'Phân tích dài' });
  assert.match(await refused('job', 'done', String(job.id), '--token', job.token), /^JOB_NEEDS_RESULT/);
  const done = await ok('job', 'done', String(job.id), '--text', 'Kết quả', '--sources', String(plain), '--token', job.token);
  assert.match(done.line, new RegExp(`^ĐÃ LƯU kết quả việc nền #${job.id} \\(7 ký tự, nguồn #${plain}\\)$`));
  assert.match((await ok('job', 'done', String(job.id), '--text', 'Kết quả', '--sources', String(plain), '--token', job.token)).line, /đã có kết quả giống hệt/);
  // summary and tasks after the meeting ended
  await call('finish');
  const { receipt } = await call('brief', { as: 'chinh' });
  const summary = await ok('summary', '--file', file('s.md', '# Tóm tắt\n\nĐoạn [#1].'), '--sources', String(plain), '--base', '0', '--receipt', receipt);
  assert.match(summary.line, new RegExp(`^ĐÃ LƯU SUMMARY \\(bản 1, \\d+ ký tự, nguồn #${plain}\\) → `));
  assert.match(await refused('summary', '--file', file('s2.md', 'x'), '--base', '1', '--receipt', receipt), /^SOURCES_REQUIRED: SUMMARY/);
  const tasks = await ok('tasks', '--file', file('t.json', JSON.stringify([{ task: 'Gửi giá', owner: '', due: ' ', sourceIds: [plain] }])), '--base', '0', '--receipt', receipt);
  assert.match(tasks.line, new RegExp(`^ĐÃ LƯU TASKS \\(1 việc\\) \\(bản 1, \\d+ ký tự, nguồn #${plain}\\)`));
  assert.match(await refused('tasks', '--file', file('t2.json', '{"task":"x"}'), '--base', '1', '--receipt', receipt), /^TASKS_NOT_A_LIST/);
});

test('after stop the same host still takes translate and picture without --session (ended meeting inside the grace period)', async () => {
  // The previous test finished the meeting; nothing is open, the host answers for the meeting that just ended.
  assert.equal((await call('status')).session.ended !== null, true);
  const id = (await call('history'))[0].id; assert.ok(id);
  const rows = (await call('read', { sessionId: id })).items; const lao = rows.find(row => row.language === 'lo').id;
  const result = await call('translate', { items: [{ sourceId: lao, text: 'Xin chào (muộn)' }] });
  assert.equal(result.saved, 1); assert.equal(result.replaced, 1);
  const { receipt } = await call('brief', { as: 'chinh' });
  const next = (await call('picture', {})).revision + 1;
  const picture = await call('picture', { text: 'Bức tranh sau họp.', sourceIds: [lao], expectedRevision: next - 1, receipt });
  assert.equal(picture.revision, next);
  // Not a draft that makes sense after the meeting: a manual line still needs an open meeting.
  await assert.rejects(call('manual', { text: 'nhập tay' }), /SESSION_NOT_ACTIVE|NO_OPEN_SESSION/);
});
