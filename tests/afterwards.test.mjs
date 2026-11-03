// Fixes from the 03/11 tender meeting (0.12.1), against a real test host: the meeting picture may outgrow a note, and the
// reports written after `pma stop` reach the meeting even when the host that ran it has gone. Synthetic rows; no audio, no ASR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNet } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = createNet(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('a 30-minute picture longer than 8000 characters is saved; after stop and a new host, summary and tasks go to the latest meeting; with no meeting open the error says so', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pma-afterwards-')); const port = String(await freePort());
  const env = { PMA_PORT: port, PMA_TEST_MODE: '1', PMA_DATA_DIR: directory, PMA_STOP_HOOK: 'off' };
  const saved = { ...process.env }; Object.assign(process.env, env);
  const { call } = await import('../dist/client.js');
  try {
    const opened = await call('prepare', { title: 'Họp thầu thử', fixture: true }); const id = opened.session.id;
    const first = (await call('fixture', { text: 'Đoạn một.' })).id;
    const long = 'Bức tranh. '.repeat(1800);   // ~19800 characters
    assert.ok(long.length > 8000);
    assert.equal((await call('picture', { text: long, sourceIds: [first] })).revision, 1);
    assert.equal((await call('picture', {})).text, long);
    await assert.rejects(call('picture', { text: 'x'.repeat(30001), sourceIds: [first] }), /INVALID_INPUT/);
    await call('finish', {});
    // The host that ran the meeting leaves; the next command starts a new one with no meeting open.
    await call('shutdown'); await sleep(800);
    await assert.rejects(call('manual', { text: 'nhập tay' }), /NO_OPEN_SESSION: không có cuộc họp nào đang mở; thêm --session/);
    // The reports folder is named after the meeting (date_first-8-of-id): both land in the meeting that just ended.
    const summary = await call('summary', { markdown: '# Tóm tắt\n\nĐoạn một [#1].', sourceIds: [first] });
    const tasks = await call('tasks', { tasks: [{ task: 'Gửi giá thuốc', sourceIds: [first] }] });
    for (const saved of [summary, tasks]) assert.ok(JSON.stringify(saved).includes(id.slice(0, 8)), JSON.stringify(saved));
  } finally {
    await call('shutdown').catch(() => {}); await sleep(500);
    for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });   // the host may still hold its database for a moment
  }
});
