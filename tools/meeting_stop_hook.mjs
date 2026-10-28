// Claude Code Stop hook: while a meeting is live, the session that runs it must keep following.
// - A Monitor on `pma follow` is following (fresh heartbeat): the turn may end; Monitor wakes Claude on new text.
// - Nobody is following: block, and say how to resume (Monitor on `pma follow`, or source_next over MCP).
// Releases when the user ends the meeting, capture stops with nothing unread, or the runtime is gone.
// Sessions that never started or followed a meeting are not affected.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allow = () => process.exit(0);
if (process.env.PMA_STOP_HOOK === 'off') allow();
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { allow(); }

// Real tool calls only: names inside text are JSON-escaped and do not match. Commands that point pma at
// another port or data directory are tests, not the meeting.
let transcript = '';
try { transcript = readFileSync(input.transcript_path, 'utf8'); } catch { allow(); }
const mcp = /"name":"mcp__personal-meeting-assistant__(hearing_start|source_next)"/.test(transcript);
const shell = [...transcript.matchAll(/"name":"(?:Bash|PowerShell|Monitor)","input":\{[^}]*?"command":"((?:[^"\\]|\\.)*)"/g)]
  .some(([, command]) => /\b(?:pma(?:\.cmd)?|cli\.js)(?:\\")?\s+(?:listen|follow|replay)\b/.test(command) && !/PMA_(?:PORT|DATA_DIR)/.test(command));
if (!mcp && !shell) allow();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
// node:http rather than fetch: fetch can abort the process on exit under Windows (libuv async assertion).
const http = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request(url, { method, headers, timeout: 3000 }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => resolve({ headers: res.headers, text })); });
  req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
});
const read = name => { try { return JSON.parse(readFileSync(join(dataDir, name), 'utf8')); } catch { return null; } };
let state;
try {
  const daemon = read('daemon.json');
  if (daemon) {
    const reply = await http(daemon.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` }, body: JSON.stringify({ method: 'status' }) });
    state = JSON.parse(reply.text).result;
  } else {
    // Pre-0.5 MCP server (panel only): same state through the panel API.
    const { url } = read('panel.json');
    const home = await http(url + '/');
    const cookie = String(home.headers['set-cookie'] ?? '').split(';')[0];
    state = JSON.parse((await http(url + '/api/state', { headers: { Cookie: cookie } })).text);
    state.unread = state.backlog?.count;
  }
} catch { allow(); }

const session = state?.session;
if (!session || session.ended) allow();
const live = ['LOADING_ASR', 'WAITING_FOR_SOURCE', 'LISTENING'].includes(state.captureState);
const unread = state.unread ?? 0;
if (!live && !unread) allow();
const followed = state.lastFollowAt && Date.now() - Date.parse(state.lastFollowAt) < 90000;
if (live && followed) allow();

const reason = live
  ? `Cuộc họp "${session.title}" đang diễn ra (${state.captureState}, ${unread} đoạn chưa đọc) mà không có ai theo dõi. Bật lại theo dõi: Monitor với lệnh \`./pma follow\` (Claude Code), hoặc gọi source_next tiếp (MCP). Chỉ dừng khi người dùng nói kết thúc/đóng — khi đó \`./pma stop\` (hoặc session_finish) rồi làm RAW/SUMMARY/TASKS.`
  : `Bộ thu đã dừng (${state.captureState}${state.lastError ? ': ' + state.lastError : ''}) nhưng còn ${unread} đoạn chưa đọc. Đọc hết (\`./pma read --after ${state.agentCursor}\`), báo người dùng tình trạng bộ thu, rồi mới kết thúc lượt.`;
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
