// Claude Code Stop hook: while a meeting session is live, the following agent keeps reading
// instead of ending its turn. It releases when the user ends the meeting (session_finish),
// capture stops, or the panel is gone. Sessions that never started hearing are not affected.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allow = () => process.exit(0);
if (process.env.PMA_STOP_HOOK === 'off') allow();
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { allow(); }

// Only the session that is following the meeting: its transcript holds a real tool_use of hearing_start or
// source_next. Mentions of those names in text (code, messages) are JSON-escaped and do not match.
let transcript = '';
try { transcript = readFileSync(input.transcript_path, 'utf8'); } catch { allow(); }
if (!/"name":"mcp__personal-meeting-assistant__(hearing_start|source_next)"/.test(transcript)) allow();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
let state;
try {
  const { url } = JSON.parse(readFileSync(join(dataDir, 'panel.json'), 'utf8'));
  const home = await fetch(url + '/', { signal: AbortSignal.timeout(3000) });
  const cookie = home.headers.get('set-cookie')?.split(';')[0];
  state = await fetch(url + '/api/state', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) }).then(r => r.json());
} catch { allow(); }

const session = state?.session;
if (!session || session.ended) allow();
const live = ['LOADING_ASR', 'WAITING_FOR_SOURCE', 'LISTENING'].includes(state.captureState);
const unread = state.backlog?.count ?? 0;
if (!live && !unread) allow();

const reason = live
  ? `Cuộc họp "${session.title}" vẫn đang diễn ra (${state.captureState}, ${unread} đoạn chưa đọc). Không kết thúc lượt: gọi source_next với cursor tiếp theo (waitMs 20000) và tiếp tục theo dõi. Chỉ dừng khi người dùng nói kết thúc/đóng — khi đó gọi session_finish rồi làm RAW/SUMMARY/TASKS.`
  : `Bộ thu đã dừng (${state.captureState}${state.lastError ? ': ' + state.lastError : ''}) nhưng còn ${unread} đoạn chưa đọc. Đọc hết bằng source_next, báo người dùng tình trạng bộ thu, rồi mới kết thúc lượt.`;
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
