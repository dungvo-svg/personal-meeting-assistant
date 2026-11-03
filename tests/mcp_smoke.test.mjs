// MCP smoke (0.12.1): a real MCP client (the SDK's Client over stdio) talks to dist/server.js, which forwards to a diagnostic host of
// this test's own world (harness.mjs: temp root, data dir, lock dir, free loopback port, no inherited PMA_*, PMA_TEST_MODE=1,
// PMA_WARM=0). The meeting is a fixture session (synthetic text, no device, no audio, no model). The host is started by a read-only
// tool call of the adapter (history_list) and recorded and proven as this test's before any change; the test's own requests go through guardedCall (ping says
// testMode and the recorded pid) and teardown stops only that host. Checks the draft contract end to end over stdio: status is a pure
// look, reports need the context receipt and the base revision, a resend is a duplicate, a late result is a conflict, a context change
// needs a new read, a new adapter process (reconnect) keeps the host's records, and a report the disk refuses is not recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const text = reply => reply.content?.[0]?.text ?? '';
const parsed = reply => JSON.parse(text(reply));
async function adapter(env) {
  const client = new Client({ name: 'pma-mcp-smoke', version: '0.12.1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env, stderr: 'ignore' }));
  return client;
}
const tool = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('MCP over stdio: context receipt, base revision, resend, late result, context change, reconnect and disk failure', async () => {
  const world = await isolatedEnv('mcp-smoke'); const restoreEnv = applyEnv(world.env);
  const call = guardedCall(world.env); let client = null;
  try {
    client = await adapter(world.env);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['context_read', 'report_save_summary', 'report_save_tasks', 'session_status']) assert.ok(names.includes(name), name);

    // Status only looks: no host is started by it.
    assert.equal(parsed(await tool(client, 'session_status')).host, 'NOT_RUNNING');
    assert.equal(existsSync(join(world.env.PMA_DATA_DIR, 'daemon.json')), false, 'session_status started no host');
    // Ending a meeting with no host running starts none either (reach): it says so.
    const cold = await tool(client, 'session_finish', { sessionId: '00000000-0000-4000-8000-000000000123' });
    assert.equal(cold.isError, true); assert.match(text(cold), /HOST_NOT_RUNNING/);
    assert.equal(existsSync(join(world.env.PMA_DATA_DIR, 'daemon.json')), false, 'session_finish started no host');

    // A read-only tool starts the host in this world; it is recorded as this test's and proven (ping: testMode, same pid) before the
    // first tool call that changes anything.
    const history = await recordingHost(world.env, () => tool(client, 'history_list'));
    assert.notEqual(history.isError, true, text(history));
    assert.equal((await call('ping')).testMode, true);
    const opened = parsed(await tool(client, 'session_prepare', { title: 'Họp thử MCP', fixture: true }));
    const sessionId = opened.session.id; assert.match(sessionId, /^[0-9a-f-]{36}$/);
    const first = parsed(await tool(client, 'fixture_append', { text: 'Đoạn một của buổi thử.' })).id;

    // Without the receipt and base the adapter refuses the call before the host is asked.
    const bare = await tool(client, 'report_save_summary', { sessionId, markdown: '- Một.', sourceIds: [first] });
    assert.equal(bare.isError, true, 'receipt and expectedRevision are required by the tool schema');

    const read = parsed(await tool(client, 'context_read', { sessionId }));
    assert.match(read.receipt, /^rcpt-[a-f0-9]{16}$/); assert.match(read.markdown, /Biên nhận context: rcpt-/);
    const save = (args) => tool(client, 'report_save_summary', { sessionId, sourceIds: [first], ...args });

    const v1 = parsed(await save({ markdown: '- Bản một.', receipt: read.receipt, expectedRevision: 0 }));
    assert.equal(v1.revision, 1); assert.equal(v1.receipt.state, 'SAVED'); assert.equal(v1.receipt.delivered, 'NOT_AVAILABLE');
    assert.equal(parsed(await save({ markdown: '- Bản một.', receipt: read.receipt, expectedRevision: 0 })).duplicate, true, 'a resend is a duplicate');
    const late = await save({ markdown: '- Bản khác dựng từ bản 0.', receipt: read.receipt, expectedRevision: 0 });
    assert.equal(late.isError, true); assert.match(text(late), /REPORT_REVISION_CONFLICT/);

    // The context changes (a correction): the old receipt no longer counts until the context is read again.
    await call('correct', { sessionId, raw: 'MTP', corrected: 'Mittaphab', basis: 'user_confirmed' });
    const stale = await save({ markdown: '- Bản hai.', receipt: read.receipt, expectedRevision: 1 });
    assert.equal(stale.isError, true); assert.match(text(stale), /CONTEXT_NOT_CURRENT/);
    const again = parsed(await tool(client, 'context_read', { sessionId }));
    assert.notEqual(again.receipt, read.receipt);
    assert.equal(parsed(await save({ markdown: '- Bản hai.', receipt: again.receipt, expectedRevision: 1 })).revision, 2);

    // A new adapter process (the MCP client reconnected): the host's receipt and revisions are still the record.
    await client.close(); client = await adapter(world.env);
    assert.equal(parsed(await save({ markdown: '- Bản ba.', receipt: again.receipt, expectedRevision: 2 })).revision, 3);
    const replay = await save({ markdown: '- Kết quả trễ dựng từ bản một.', receipt: again.receipt, expectedRevision: 1 });
    assert.equal(replay.isError, true); assert.match(text(replay), /REPORT_REVISION_CONFLICT/);

    // The disk refuses the report (its file's place is a folder): nothing recorded, the revision does not move.
    const path = v1.path; rmSync(path, { force: true }); mkdirSync(path);
    const refused = await save({ markdown: '- Bản bốn.', receipt: again.receipt, expectedRevision: 3 });
    assert.equal(refused.isError, true); assert.match(text(refused), /REPORT_NOT_WRITTEN/);
    assert.equal((await call('status')).revisions.summary, 3, 'the failed save recorded nothing');
    rmSync(path, { recursive: true, force: true });
  } finally {
    // The adapter (an SDK-owned stdio child) is closed first, so it cannot start a host again; then the host, then the root.
    try { await client?.close(); } catch {}
    try { assertCleaned(await teardown(world)); } finally { restoreEnv(); }
  }
});
