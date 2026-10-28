// The one meeting runtime on this machine. It owns capture, ASR worker, history and reports, and is
// independent of any Claude session: the CLI (`pma`) and the thin MCP adapter talk to it over loopback.
import { z } from 'zod';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MeetingRuntime } from './runtime.js';

export const VERSION = '0.5.0';
// Settings arrive as `--env KEY=VALUE` when started through WMI (no inherited environment); allowlisted keys only.
const ALLOWED_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON'];
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] !== '--env') continue;
  const [key, ...value] = process.argv[++i].split('=');
  if (ALLOWED_ENV.includes(key)) process.env[key] = value.join('=');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
const port = Number(process.env.PMA_PORT || 8796);
const idleMinutes = Number(process.env.PMA_IDLE_MINUTES || 30);
const origin = `http://127.0.0.1:${port}`;
const cookie = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex');
const panel = readFileSync(join(root, 'web', 'index.html'));
const events = new Set<import('node:http').ServerResponse>();
// Constructed only after this process owns the port: a second instance must not touch the shared history.
let runtime: MeetingRuntime;
let lastActivity = Date.now();

const sid = z.string().uuid();
const ids = z.array(z.number().int().positive());
const current = (sessionId?: string) => sid.parse(sessionId ?? runtime.session?.id);
const languages = z.array(z.enum(['vi', 'lo'])).min(1).max(2).default(['vi', 'lo']);

// Every operation the CLI and MCP adapter may call. Inputs are validated here, once, for both.
const methods: Record<string, (input: any) => any> = {
  ping: () => ({ ok: true, version: VERSION, pid: process.pid, testMode: runtime.testMode }),
  status: () => runtime.compact(),
  prepare: input => { const a = z.object({ title: z.string().max(300).optional(), agenda: z.string().max(20000).optional(), languages, fixture: z.boolean().optional() }).parse(input); runtime.prepare(a.title, a.fixture, a.agenda, a.languages); return runtime.compact(); },
  open: input => runtime.openMeeting(z.object({ url: z.string().min(10).max(2000) }).parse(input).url),
  sources: async input => { const devices = await runtime.listDevices(z.object({ levels: z.boolean().default(true) }).parse(input).levels); return { devices, suggested: runtime.suggest(devices) }; },
  select: async input => { const a = z.object({ sessionId: sid.optional(), deviceIndex: z.number().int().nonnegative() }).parse(input); const armed = await runtime.select(current(a.sessionId), a.deviceIndex); return { index: armed.index, name: armed.name, expiresAt: armed.expiresAt }; },
  listen: input => runtime.start(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  replay: input => { const a = z.object({ sessionId: sid.optional(), file: z.string().min(1).max(1000), speed: z.number().min(0.5).max(20).default(1) }).parse(input); return runtime.replay(current(a.sessionId), a.file, a.speed); },
  pause: async input => { runtime.requireSession(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)); await runtime.stopCapture(); return runtime.compact(); },
  next: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), waitMs: z.number().int().min(0).max(25000).default(20000), limit: z.number().int().min(1).max(100).default(12), follower: z.boolean().default(false) }).parse(input); return runtime.next(current(a.sessionId), a.after, a.waitMs, a.limit, a.follower); },
  read: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) }).parse(input); const items = runtime.sources(current(a.sessionId), a.after, a.limit); return { items, nextCursor: items.at(-1)?.id ?? a.after, done: items.length < a.limit }; },
  context: () => ({ agenda: runtime.session?.context ?? null, session: runtime.compact().session }),
  note: input => { const a = z.object({ sessionId: sid.optional(), key: z.string().regex(/^[\w-]{1,80}$/), revision: z.number().int().min(1), kind: z.enum(['observation', 'decision', 'action', 'question', 'correction']), text: z.string().min(1).max(8000), sourceIds: ids.min(1).max(50) }).parse(input); return runtime.publish(current(a.sessionId), a.key, a.revision, a.kind, a.text, a.sourceIds); },
  finish: input => runtime.finish(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  raw: input => runtime.writeRaw(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  summary: input => { const a = z.object({ sessionId: sid.optional(), markdown: z.string().min(1).max(40000), sourceIds: ids.min(1).max(200) }).parse(input); return runtime.saveSummary(current(a.sessionId), a.markdown, a.sourceIds); },
  tasks: input => { const a = z.object({ sessionId: sid.optional(), tasks: z.array(z.object({ task: z.string().min(1).max(2000), owner: z.string().max(200).optional(), due: z.string().max(200).optional(), sourceIds: ids.min(1).max(50) })).max(200) }).parse(input); return runtime.saveTasks(current(a.sessionId), a.tasks); },
  history: () => runtime.historyList(),
  fixture: input => { if (!runtime.testMode) throw new Error('FIXTURE_DISABLED'); return { id: runtime.ingest(z.object({ text: z.string().min(1).max(8000) }).parse(input).text, 'synthetic_fixture') }; },
  shutdown: () => { setTimeout(() => void shutdown(), 50); return { stopping: true }; },
};

function json(response: import('node:http').ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
async function body(request: import('node:http').IncomingMessage, limit: number) { let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > limit) throw new Error('BODY_TOO_LARGE'); } return JSON.parse(text || '{}'); }

const http = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) return json(response, 403, { error: 'ORIGIN_REJECTED' });
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
    lastActivity = Date.now();
    const path = request.url?.split('?')[0];
    if (path === '/rpc') {
      // Token from daemon.json, which only local processes of this user can read. Browsers never get it.
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}` || request.headers.origin || !request.headers['content-type']?.startsWith('application/json')) return json(response, 401, { ok: false, error: 'RPC_UNAUTHORIZED' });
      const { method, args } = await body(request, 256000);
      if (typeof method !== 'string' || !Object.hasOwn(methods, method)) return json(response, 404, { ok: false, error: 'UNKNOWN_METHOD' });
      try { return json(response, 200, { ok: true, result: await methods[method](args ?? {}) }); }
      catch (error: any) { return json(response, 200, { ok: false, error: error instanceof z.ZodError ? 'INVALID_INPUT: ' + error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ') : String(error?.message ?? error) }); }
    }
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `pma=${cookie}; HttpOnly; SameSite=Strict; Path=/`, 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); return response.end(panel);
    }
    if (!request.headers.cookie?.split(';').some(c => c.trim() === `pma=${cookie}`)) return json(response, 403, { error: 'OPEN_PERSONAL_PANEL_FIRST' });
    if (request.method === 'GET' && path === '/api/state') return json(response, 200, runtime.snapshot());
    if (request.method === 'GET' && path === '/api/history-list') return json(response, 200, runtime.historyList());
    if (request.method === 'GET' && path === '/api/history') return json(response, 200, runtime.history(new URL(request.url!, origin).searchParams.get('id') || ''));
    if (request.method === 'GET' && path === '/api/export') { const id = sid.parse(new URL(request.url!, origin).searchParams.get('id')); const content = runtime.exportText(id); response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="meeting-${id}.txt"`, 'Cache-Control': 'no-store' }); return response.end(content); }
    if (request.method === 'GET' && path === '/api/devices') return json(response, 200, await runtime.listDevices(true));
    if (request.method === 'GET' && path === '/api/report') { const params = new URL(request.url!, origin).searchParams; const report = runtime.reportFile(sid.parse(params.get('id')), params.get('kind') || ''); response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${report.name}"`, 'Cache-Control': 'no-store' }); return response.end(report.content); }
    if (request.method === 'GET' && path === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' }); response.write('event: update\ndata: {}\n\n'); events.add(response);
      const keepAlive = setInterval(() => response.write(': keepalive\n\n'), 15000); request.on('close', () => { clearInterval(keepAlive); events.delete(response); }); return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) return json(response, 403, { error: 'CONTROL_REQUIRES_SAME_ORIGIN_JSON' });
    const input = await body(request, 32000);
    if (path === '/api/prepare') return json(response, 200, runtime.prepare());
    if (path === '/api/arm') return json(response, 200, runtime.arm(input.sessionId, input.deviceIndex));
    if (path === '/api/start') return json(response, 200, await runtime.start(input.sessionId));
    if (path === '/api/pause') { runtime.requireSession(input.sessionId); await runtime.stopCapture(); return json(response, 200, runtime.snapshot()); }
    if (path === '/api/finish') { await runtime.finish(input.sessionId); return json(response, 200, runtime.snapshot()); }
    if (path === '/api/manual') { runtime.requireSession(input.sessionId); return json(response, 200, { id: runtime.ingest(String(input.text || ''), 'operator_text') }); }
    return json(response, 404, { error: 'NOT_FOUND' });
  } catch (error) { if (!response.headersSent) json(response, 400, { error: String(error) }); else response.end(); }
});
http.requestTimeout = 30000; http.headersTimeout = 10000;
try { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); }); }
catch (error: any) { console.error(`Meeting runtime already running on ${origin} (${error?.code || error}); exiting without touching history.`); process.exit(1); }
runtime = new MeetingRuntime(root, dataDir, process.env.PMA_TEST_MODE === '1');
// A diagnostic instance must never launch Zoom.
if (runtime.testMode) runtime.opener = () => {};
runtime.on('change', () => { for (const response of events) response.write('event: update\ndata: {}\n\n'); });
mkdirSync(dataDir, { recursive: true });
const startedAt = new Date().toISOString();
writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ url: origin, pid: process.pid, token, version: VERSION, startedAt }));
writeFileSync(join(dataDir, 'panel.json'), JSON.stringify({ url: origin, pid: process.pid, startedAt }));
console.error(`Meeting runtime ${VERSION}: ${origin} (capture OFF)`);

// Exit when nobody has used it for a while and no meeting is open; the CLI starts it again on demand.
setInterval(() => { if ((!runtime.session || runtime.session.ended) && !runtime.capture && Date.now() - lastActivity > idleMinutes * 60000) void shutdown(); }, 30000).unref();
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await runtime.close(); for (const response of events) response.end(); http.close(); setTimeout(() => process.exit(0), 100).unref(); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
