import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'personal-mcp-probe-'));
async function shutdownRuntime() { try { const { url, token } = JSON.parse(readFileSync(join(data, 'daemon.json'), 'utf8')); await fetch(url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ method: 'shutdown' }) }); await new Promise(r => setTimeout(r, 800)); } catch {} }
const client = new Client({ name: 'personal-runtime-protocol-probe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)), PMA_TEST_MODE: '1', PMA_PORT: '8797', PMA_DATA_DIR: data, PMA_IDLE_MINUTES: '2' }, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', d => stderr = (stderr + d).slice(-4000));
const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'source_next'));
  assert.ok(!tools.tools.some(t => /exec|shell|grant|authorize/.test(t.name)));
  const session = await call('session_prepare', { title: 'SYNTHETIC PROTOCOL CHECK — not a meeting', fixture: true });
  const id = session.session.id;
  // The adapter holds no port; the runtime it started is reached over /rpc with the token in daemon.json (there is no web panel).
  const daemon = JSON.parse(readFileSync(join(data, 'daemon.json'), 'utf8'));
  const rpc = async (method, args = {}) => { const reply = await fetch(daemon.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daemon.token }, body: JSON.stringify({ method, args }) }); return { status: reply.status, ...(await reply.json()) }; };
  const first = await call('fixture_append', { text: 'Mẫu thử: có ba xe cần kiểm tra, chưa có quyết định sửa xe.' });
  const read = await call('source_next', { sessionId: id, after: 0, waitMs: 0 });
  assert.equal(read.items[0].id, first.id);
  await call('note_publish', { sessionId: id, key: 'probe', revision: 1, kind: 'observation', text: 'Nguồn thử nêu ba xe cần kiểm tra; chưa có quyết định sửa.', sourceIds: [first.id] });
  const state = (await rpc('status')).result;
  assert.equal(state.noteCount, 1); assert.equal(state.sourceCount, 1);
  const history = (await rpc('read', { sessionId: id })).result; assert.equal(history.items.length, 1); assert.match(history.items[0].text, /Mẫu thử/);
  assert.ok((await rpc('history')).result.some(item => item.id === id));
  // No token, wrong method, a browser origin and the retired panel paths all fail; the session stays open.
  const noToken = await fetch(daemon.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'finish', args: { sessionId: id } }) }); assert.equal(noToken.status, 401);
  const browser = await fetch(daemon.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', Authorization: 'Bearer ' + daemon.token }, body: JSON.stringify({ method: 'finish', args: { sessionId: id } }) }); assert.equal(browser.status, 403);
  for (const retired of ['/', '/api/state', '/api/events']) assert.equal((await fetch(daemon.url + retired)).status, 404, retired);
  assert.equal((await call('session_status')).session.ended, null);
  const typed = await rpc('manual', { sessionId: id, text: '<img src=x onerror=alert(1)> Chỉ là dữ liệu.' }); assert.equal(typed.ok, true);
  for (const name of ['meeting_open', 'report_raw', 'report_save_summary', 'report_save_tasks']) assert.ok(tools.tools.some(t => t.name === name), name);
  assert.equal((await call('meeting_open', { url: 'https://zoom.us/j/81234567890?pwd=probe' })).meetingId, '81234567890');
  const finished = await call('session_finish', { sessionId: id }); assert.equal(finished.raw.sourceCount, 2); assert.equal(finished.sources, undefined);
  const summary = await call('report_save_summary', { sessionId: id, markdown: '- Ba xe cần kiểm tra; chưa quyết định sửa.', sourceIds: [first.id] });
  const tasks = await call('report_save_tasks', { sessionId: id, tasks: [{ task: 'Kiểm tra ba xe', sourceIds: [first.id] }] });
  const raw = await rpc('raw', { sessionId: id }); assert.equal(raw.ok, true); assert.match(readFileSync(raw.result.path, 'utf8'), /nhập tay/);
  assert.match(summary.path, /SUMMARY\.md$/); assert.match(tasks.path, /TASKS\.md$/);
  const rejected = await client.callTool({ name: 'note_publish', arguments: { sessionId: id, key: 'late', revision: 1, kind: 'action', text: 'Late', sourceIds: [first.id] } }); assert.equal(rejected.isError, true);
  console.log(JSON.stringify({ status: 'PASS', evidence: 'SDK_CLIENT_PROTOCOL_ONLY_NOT_CLAUDE', architecture: 'MCP_ADAPTER_TO_RUNTIME_DAEMON', toolCount: tools.tools.length, checks: ['stdio handshake', 'source cursor', 'agent-note publication', 'rpc status/read/history', 'manual text via rpc', 'no-token and browser-origin denied', 'retired panel paths 404', 'STOP rejects late notes', 'meeting_open test-mode no launch', 'RAW on finish', 'summary/tasks after end', 'RAW shows manual text'], actualCapture: false, actualModel: false }));
} catch (error) { console.error(stderr); throw error; }
finally { await client.close(); await shutdownRuntime(); assert.ok(resolve(data).startsWith(resolve(tmpdir()))); rmSync(data, { recursive: true, force: true }); }
