// 0.13.0 item 11: the meeting purpose (thong-bao | huong-dan | giao-viec | ban-quyet-dinh) in the session context and so in the context pack,
// on the first line of `pma brief`, settable at start and for the open meeting. Runtime-level tests use the fakes (no recording); the CLI
// test uses an isolated TEST host (fixture-free `pma start` in test mode: no audio, no model).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, withFakes } from './fakes.mjs';
import { parsePurpose, PURPOSES } from '../dist/purpose.js';
import { composeBrief, buildBrief, BRIEF_MAX_BYTES } from '../dist/brief.js';
import { buildPack } from '../dist/context_pack.js';
import { CAPABILITIES, callNeeds } from '../dist/protocol.js';
import { applyEnv, assertCleaned, isolatedEnv, proveOwned, recordingHost, teardown } from './harness.mjs';

test('the four purposes are accepted by id or in Vietnamese with or without diacritics; anything else is refused with the list', () => {
  for (const [input, id] of [['thong-bao', 'thong-bao'], ['thông báo', 'thong-bao'], ['Thong bao', 'thong-bao'], ['THONG_BAO', 'thong-bao'], ['hướng dẫn', 'huong-dan'], ['huong-dan', 'huong-dan'],
    ['giao việc', 'giao-viec'], ['Giao Viec', 'giao-viec'], ['bàn quyết định', 'ban-quyet-dinh'], ['  ban  quyet   dinh ', 'ban-quyet-dinh'], ['ban-quyet-dinh', 'ban-quyet-dinh']]) assert.equal(parsePurpose(input).id, id, input);
  assert.equal(PURPOSES.length, 4);
  for (const bad of ['', 'họp', 'thông báo và giao việc', 5, undefined, null]) assert.throws(() => parsePurpose(bad), /INVALID_PURPOSE: .*thong-bao.*huong-dan.*giao-viec.*ban-quyet-dinh/, String(bad));
});

test('the purpose is part of the context pack: setting it changes the version (every role reads again), the same purpose does not, and a meeting without one keeps the old version', async () => {
  const input = { sessionId: 's1', title: 'Họp', createdAt: '2026-11-23T10:00:00Z' };
  assert.notEqual(buildPack({ ...input, purpose: 'thong-bao' }).version, buildPack(input).version);
  assert.equal(buildPack({ ...input, purpose: 'thong-bao' }).version, buildPack({ ...input, purpose: 'thong-bao' }).version);
  assert.notEqual(buildPack({ ...input, purpose: 'thong-bao' }).version, buildPack({ ...input, purpose: 'giao-viec' }).version);
  assert.equal(buildPack(input).purpose, undefined); assert.equal(buildPack(input).missing.includes('purpose'), false, 'not knowing the purpose is not a missing-context block');
  await withFakes(async r => {
    r.prepare('Họp thầu', false, undefined, ['vi'], { purpose: 'hướng dẫn' }); const id = r.session.id;
    assert.equal(r.session.context.purpose, 'huong-dan'); assert.equal(r.packOf(id).purpose, 'huong-dan');
    const { receipt } = r.contextReceipt(id, 'chinh'); const bound = { version: r.packOf(id).version };
    assert.doesNotThrow(() => r.requireCentralContext(id, receipt));
    const same = r.setPurpose(id, 'huong-dan'); assert.equal(same.changed, false); assert.equal(same.version, bound.version);
    const changed = r.setPurpose(id, 'bàn quyết định'); assert.equal(changed.changed, true); assert.equal(changed.was, 'huong-dan'); assert.notEqual(changed.version, bound.version);
    assert.throws(() => r.requireCentralContext(id, receipt), /CONTEXT_NOT_CURRENT/, 'a role that read the old version must read the brief again');
    assert.doesNotThrow(() => r.requireCentralContext(id, r.contextReceipt(id, 'chinh').receipt));
    assert.equal(JSON.parse(r.db.prepare('SELECT context FROM sessions WHERE id=?').get(id).context).purpose, 'ban-quyet-dinh', 'stored in the session, not only in memory');
    assert.throws(() => r.setPurpose(id, 'họp chơi'), /INVALID_PURPOSE/); assert.equal(r.session.context.purpose, 'ban-quyet-dinh');
    assert.throws(() => r.setPurpose('00000000-0000-4000-8000-000000000000', 'giao việc'), /SESSION_NOT_FOUND/);
  });
});

test('a wrong purpose at start leaves no meeting behind; start on an open meeting with --purpose sets it', async () => {
  await withFakes(async r => {
    assert.throws(() => r.prepare('Họp', false, undefined, ['vi'], { purpose: 'họp chơi' }), /INVALID_PURPOSE/);
    assert.ok(!r.session); assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    r.prepare('Họp', false, undefined, ['vi'], {}); assert.equal(r.session.context.purpose, undefined);
    r.prepare('Họp', false, undefined, ['vi'], { purpose: 'giao việc' }); assert.equal(r.session.context.purpose, 'giao-viec', 'start again on the open meeting');
  });
});

test('pma brief: the purpose is the FIRST line (with its rule), "chưa rõ" when unknown, and the brief stays within 2 KB', async () => {
  const { mkdirSync } = await import('node:fs'); const { join } = await import('node:path');
  await withFakes(async (r, dir) => {
    const root = join(dir, 'root-brief'); mkdirSync(root);
    r.prepare('Họp anh Quân', false, 'Hướng dẫn app Quản trị mục tiêu', ['vi'], { me: 'Dũng' });
    let lines = composeBrief(r, root).split('\n');
    assert.match(lines[0], /^\*\*Mục đích họp:\*\* chưa rõ — .*pma purpose thong-bao\|huong-dan\|giao-viec\|ban-quyet-dinh/);
    assert.match(lines[1], /^# Brief họp/);
    r.setPurpose(r.session.id, 'thông báo'); lines = composeBrief(r, root).split('\n');
    assert.equal(lines[0], '**Mục đích họp:** thông báo — nghe để nắm nội dung được thông báo; việc, tên, số nêu khi làm mẫu là ví dụ, không vào TASKS');
    assert.ok(Buffer.byteLength(composeBrief(r, root)) <= BRIEF_MAX_BYTES);
    assert.match(composeBrief(r, root).trimEnd().split('\n').at(-1), /^\*\*Tình trạng:\*\*/, 'the status line still comes last');
  });
  // No meeting: no purpose line at all (nothing to say it about).
  assert.doesNotMatch(buildBrief({ owner: null, session: null, glossary: [] }), /Mục đích họp/);
  // A huge context still fits with the purpose line in front.
  const long = buildBrief({ owner: null, glossary: [], session: { title: 'Họp '.repeat(80), ended: null, languages: ['vi'], context: { purpose: 'ban-quyet-dinh', agenda: 'Rất dài. '.repeat(500), participants: Array.from({ length: 50 }, (_, i) => ({ name: `Người ${i} dài`, role: 'Trưởng phòng' })) } } });
  assert.ok(Buffer.byteLength(long) <= BRIEF_MAX_BYTES); assert.match(long.split('\n')[0], /^\*\*Mục đích họp:\*\* bàn quyết định/);
});

test('a client that sends a purpose to a host that does not say meeting-purpose/1 is refused first (an older host would ignore it silently)', () => {
  assert.ok(CAPABILITIES.includes('meeting-purpose/1'));
  assert.deepEqual(callNeeds('prepare', { title: 'x', purpose: 'thong-bao' }), ['meeting-purpose/1']); assert.deepEqual(callNeeds('prepare', { title: 'x' }), []);
  assert.deepEqual(callNeeds('purpose', { purpose: 'thong-bao' }), ['meeting-purpose/1']);
  assert.deepEqual(callNeeds('prepare', { mic: false, purpose: 'thong-bao' }), ['mic-session/2', 'meeting-purpose/1']);
});

const run = promisify(execFile);
test('the CLI: start --purpose "thông báo", brief shows it first, pma purpose changes it and says to read the brief again, a wrong word is a clear error', async () => {
  const world = await isolatedEnv('purpose'); const env = world.env; const restoreEnv = applyEnv(env);
  try {
    const cliRaw = (...args) => run(process.execPath, [resolve('dist/cli.js'), ...args], { env });
    const cli = async (...args) => { await proveOwned(env); return cliRaw(...args); };
    await recordingHost(env, () => cliRaw('history'));
    const wrong = await cli('start', '--title', 'Họp thử', '--purpose', 'họp chơi').then(() => null, e => e);
    assert.equal(wrong.code, 1); assert.match(JSON.parse(wrong.stdout).error, /INVALID_PURPOSE: .*thong-bao/);
    assert.equal(JSON.parse((await cli('status')).stdout).session, null, 'the refused start made no meeting');
    await cli('start', '--title', 'Họp thông báo', '--purpose', 'thông báo', '--languages', 'vi');
    assert.equal((await cli('brief')).stdout.split('\n')[0], '**Mục đích họp:** thông báo — nghe để nắm nội dung được thông báo; việc, tên, số nêu khi làm mẫu là ví dụ, không vào TASKS');
    const changed = JSON.parse((await cli('purpose', 'giao việc')).stdout);
    assert.equal(changed.purpose, 'giao-viec'); assert.match(changed.line, /^MỤC ĐÍCH HỌP: giao việc \(trước đó: thong-bao\) — .*chạy lại pma brief --as chinh/);
    assert.match((await cli('brief')).stdout.split('\n')[0], /^\*\*Mục đích họp:\*\* giao việc — /);
    assert.match(JSON.parse((await cli('purpose', 'giao-viec')).stdout).line, /không đổi/);
    const empty = await cli('purpose').then(() => null, e => e); assert.match(JSON.parse(empty.stdout).error, /^PURPOSE_NEEDS_VALUE/);
    const bad = await cli('purpose', 'xyz').then(() => null, e => e); assert.match(JSON.parse(bad.stdout).error, /INVALID_PURPOSE/);
  } finally { try { assertCleaned(await teardown(world)); } finally { restoreEnv(); } }
});
