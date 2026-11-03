// Fixes from the 03/11 tender meeting (0.12.1), against a real test host: the meeting picture may outgrow a note, and the
// reports written after `pma stop` reach the meeting even when the host that ran it has gone. Synthetic rows; no audio, no ASR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, isolatedEnv, ownedShutdown, recordingHost, teardown } from './harness.mjs';

test('a 30-minute picture longer than 8000 characters is saved; after stop and a new host, summary and tasks go to the latest meeting; with no meeting open the error says so', async () => {
  // A world of its own (temp root, data dir, lock dir, free port, no inherited PMA_*); process.env is set from it only, before the import.
  const world = await isolatedEnv('afterwards'); const restoreEnv = applyEnv(world.env);
  const { call } = await import('../dist/client.js');
  try {
    const opened = await recordingHost(world.env, () => call('prepare', { title: 'Họp thầu thử', fixture: true })); const id = opened.session.id;   // starts the host: its pid is recorded as this test's
    const first = (await call('fixture', { text: 'Đoạn một.' })).id;
    // The picture is the central session's: it counts only once chinh has read the current context (Codex review of 9b02494).
    await assert.rejects(call('picture', { text: 'Bức tranh.', sourceIds: [first], expectedRevision: 0 }), /CONTEXT_NOT_READ/);
    await assert.rejects(call('picture', { text: 'Bức tranh.', sourceIds: [first] }), /BASE_REVISION_REQUIRED/);
    const { receipt } = await call('brief', { as: 'chinh' });
    const long = 'Bức tranh. '.repeat(1800);   // ~19800 characters
    assert.ok(long.length > 8000);
    assert.equal((await call('picture', { text: long, sourceIds: [first], receipt, expectedRevision: 0 })).revision, 1);
    assert.equal((await call('picture', {})).text, long);
    await assert.rejects(call('picture', { text: 'x'.repeat(30001), sourceIds: [first], receipt, expectedRevision: 1 }), /INVALID_INPUT/);
    await call('finish', {});
    // The host that ran the meeting leaves; the next command starts a new one with no meeting open.
    const left = await ownedShutdown(world.env); assert.equal(left.skipped, undefined, 'the first host is ours and leaves: ' + left.skipped);
    await assert.rejects(recordingHost(world.env, () => call('manual', { text: 'nhập tay' })), /NO_OPEN_SESSION: không có cuộc họp nào đang mở; thêm --session/);   // starts the second host
    // The reports folder is named after the meeting (date_first-8-of-id): both land in the meeting that just ended.
    const summary = await call('summary', { markdown: '# Tóm tắt\n\nĐoạn một [#1].', sourceIds: [first], receipt, expectedRevision: 0 });
    const tasks = await call('tasks', { tasks: [{ task: 'Gửi giá thuốc', sourceIds: [first] }], receipt, expectedRevision: 0 });
    for (const saved of [summary, tasks]) assert.ok(JSON.stringify(saved).includes(id.slice(0, 8)), JSON.stringify(saved));
  } finally {
    // Stop the host only if it is proven ours (and wait until it is gone: Windows keeps its files locked until the process exits),
    // whatever failed above; then remove the root (the host may still hold its database for a moment: cleanup retries).
    await teardown(world); restoreEnv();
  }
});

// Review of ee528c1 (P1): an explicit end stops capture first; waiting for translation or analysis comes after `pma stop`, never before.
test('the hop skill: on the owner\'s end, `pma stop` comes before any wait for translation or background analysis', async () => {
  const { readFileSync } = await import('node:fs');
  const skill = readFileSync('.claude/skills/hop/SKILL.md', 'utf8'); const end = skill.slice(skill.indexOf('## 5. Kết thúc'), skill.indexOf('2. Đọc toàn bộ'));
  const stop = end.indexOf('`./pma stop` ngay'); assert.ok(stop > 0, 'the end step starts with pma stop');
  for (const later of ['TaskStop', 'dịch nền', 'KẾT THÚC']) assert.ok(end.indexOf(later) > stop, `${later} comes after pma stop`);
  assert.doesNotMatch(end, /rồi chạy `\.\/pma stop`/, 'no "wait, then stop"');
});
