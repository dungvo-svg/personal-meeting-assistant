import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'personal-mcp-probe-'));
const client = new Client({ name: 'personal-runtime-protocol-probe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)), PMA_TEST_MODE: '1', PMA_PORT: '8797', PMA_DATA_DIR: data }, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', d => stderr = (stderr + d).slice(-4000));
const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'source_next'));
  assert.ok(!tools.tools.some(t => /exec|shell|grant|authorize/.test(t.name)));
  const session = await call('session_prepare', { title: 'SYNTHETIC PROTOCOL CHECK — not a meeting', fixture: true });
  const id = session.session.id;
  const first = await call('fixture_append', { text: 'Mẫu thử: có ba xe cần kiểm tra, chưa có quyết định sửa xe.' });
  const read = await call('source_next', { sessionId: id, after: 0, waitMs: 0 });
  assert.equal(read.items[0].id, first.id);
  await call('note_publish', { sessionId: id, key: 'probe', revision: 1, kind: 'observation', text: 'Nguồn thử nêu ba xe cần kiểm tra; chưa có quyết định sửa.', sourceIds: [first.id] });
  const home = await fetch(session.panelUrl);
  assert.equal(home.status, 200);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const state = await fetch(session.panelUrl + '/api/state', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(state.notes.length, 1);
  const exported = await fetch(session.panelUrl + '/api/export?id=' + id, { headers: { Cookie: cookie } }); assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition'), /attachment/); assert.match(await exported.text(), /Mẫu thử/);
  const history = await fetch(session.panelUrl + '/api/history?id=' + id, { headers: { Cookie: cookie } }).then(r => r.json()); assert.equal(history.historicalView, true); assert.equal(history.sources.length, 1);
  const denied = await fetch(session.panelUrl + '/api/finish', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
  assert.equal(denied.status, 403);
  assert.equal((await call('session_status')).session.ended, null);
  const noCookie = await fetch(session.panelUrl + '/api/state'); assert.equal(noCookie.status, 403);
  const malicious = await fetch(session.panelUrl + '/api/manual', { method: 'POST', headers: { Cookie: cookie, Origin: session.panelUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id, text: '<img src=x onerror=alert(1)> Chỉ là dữ liệu.' }) }); assert.equal(malicious.status, 200);
  for (const name of ['meeting_open', 'report_raw', 'report_save_summary', 'report_save_tasks']) assert.ok(tools.tools.some(t => t.name === name), name);
  assert.equal((await call('meeting_open', { url: 'https://zoom.us/j/81234567890?pwd=probe' })).meetingId, '81234567890');
  const finished = await call('session_finish', { sessionId: id }); assert.equal(finished.raw.sourceCount, 2); assert.equal(finished.sources, undefined);
  const summary = await call('report_save_summary', { sessionId: id, markdown: '- Ba xe cần kiểm tra; chưa quyết định sửa.', sourceIds: [first.id] });
  const tasks = await call('report_save_tasks', { sessionId: id, tasks: [{ task: 'Kiểm tra ba xe', sourceIds: [first.id] }] });
  for (const kind of ['raw', 'summary', 'tasks']) { const report = await fetch(session.panelUrl + '/api/report?kind=' + kind + '&id=' + id, { headers: { Cookie: cookie } }); assert.equal(report.status, 200, kind); }
  assert.match(summary.path, /SUMMARY\.md$/); assert.match(tasks.path, /TASKS\.md$/);
  const rejected = await client.callTool({ name: 'note_publish', arguments: { sessionId: id, key: 'late', revision: 1, kind: 'action', text: 'Late', sourceIds: [first.id] } }); assert.equal(rejected.isError, true);
  console.log(JSON.stringify({ status: 'PASS', evidence: 'SDK_CLIENT_PROTOCOL_ONLY_NOT_CLAUDE', toolCount: tools.tools.length, checks: ['stdio handshake', 'source cursor', 'agent-note publication', 'panel JSON', 'history and text export', 'cross-origin POST denied', 'missing cookie denied', 'STOP rejects late notes', 'meeting_open test-mode no launch', 'RAW on finish', 'summary/tasks after end', 'report download'], actualCapture: false, actualModel: false }));
} catch (error) { console.error(stderr); throw error; }
finally { await client.close(); assert.ok(resolve(data).startsWith(resolve(tmpdir()))); rmSync(data, { recursive: true, force: true }); }
