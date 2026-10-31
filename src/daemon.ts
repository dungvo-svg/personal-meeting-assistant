// The session host of this machine (0.11). `pma start` creates it; it lives as long as the meeting: it owns the recorder
// (WAV of the whole session), the ASR worker, history and reports, and exits after `stop` once the mix is made. Any other
// command that finds no host starts one only to read history, and that one leaves after PMA_IDLE_MINUTES (2) idle.
// It is independent of any Claude session: the CLI (`pma`) and the thin MCP adapter talk to it over loopback.
import { z } from 'zod';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MeetingRuntime } from './runtime.js';
import { composeBrief } from './brief.js';
import { applyParticipants } from './participants.js';
import { setMicState } from './mic.js';

export const VERSION = '0.11.0';
// Settings arrive as `--env KEY=VALUE` when started through WMI (no inherited environment); allowlisted keys only.
const ALLOWED_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH'];
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] !== '--env') continue;
  const [key, ...value] = process.argv[++i].split('=');
  if (ALLOWED_ENV.includes(key)) process.env[key] = value.join('=');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
const port = Number(process.env.PMA_PORT || 8796);
const idleMinutes = Number(process.env.PMA_IDLE_MINUTES || 2);
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
const languages = z.array(z.enum(['vi', 'lo', 'th'])).min(1).max(3).default(['vi', 'lo', 'th']);

// Every operation the CLI and MCP adapter may call. Inputs are validated here, once, for both.
const methods: Record<string, (input: any) => any> = {
  ping: () => ({ ok: true, version: VERSION, pid: process.pid, testMode: runtime.testMode }),
  status: () => runtime.compact(),
  prepare: input => { const a = z.object({ title: z.string().max(300).optional(), agenda: z.string().max(20000).optional(), languages, fixture: z.boolean().optional(), me: z.string().max(80).optional(), at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(), warm: z.boolean().optional() }).parse(input); runtime.prepare(a.title, a.fixture, a.agenda, a.languages, { me: a.me, at: a.at, warm: a.warm }); return { ...runtime.compact(), me: runtime.profile.me ?? null, expectedLoadSeconds: runtime.profile.lastModelLoadSeconds ?? null, rememberedSpeaker: runtime.profile.speaker?.name ?? null }; },
  open: input => runtime.openMeeting(z.object({ url: z.string().min(10).max(2000) }).parse(input).url),
  schedule: input => { const a = z.object({ sessionId: sid.optional(), at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/) }).parse(input); return runtime.setSchedule(current(a.sessionId), a.at); },
  sources: async input => { const devices = await runtime.listDevices(z.object({ levels: z.boolean().default(true) }).parse(input).levels); return { devices, suggested: runtime.suggest(devices) }; },
  // Choosing the speaker also starts the recorder (when `start` has not already found the remembered one).
  select: async input => { const a = z.object({ sessionId: sid.optional(), deviceIndex: z.number().int().nonnegative(), mic: z.boolean().default(true) }).parse(input); const armed = await runtime.select(current(a.sessionId), a.deviceIndex, a.mic); return { index: armed.index, name: armed.name, recorder: runtime.recorderBrief() }; },
  selectMic: async input => { const a = z.object({ sessionId: sid.optional(), deviceIndex: z.number().int().nonnegative(), consent: z.literal(true) }).parse(input); const armed = await runtime.selectMic(current(a.sessionId), a.deviceIndex); return { index: armed.index, name: armed.name, channel: 'Tôi', expiresAt: armed.expiresAt }; },
  listen: input => { const a = z.object({ sessionId: sid.optional(), mic: z.boolean().default(true) }).parse(input); return runtime.start(current(a.sessionId), a.mic); },
  replay: input => { const a = z.object({ sessionId: sid.optional(), file: z.string().min(1).max(1000), speed: z.number().min(0.5).max(20).default(1) }).parse(input); return runtime.replay(current(a.sessionId), a.file, a.speed); },
  pause: async input => { runtime.requireSession(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)); await runtime.pause(); return runtime.compact(); },
  audio: input => { const a = z.object({ action: z.enum(['list', 'purge']).default('list'), olderThanDays: z.number().min(0).max(3650).optional() }).parse(input); return a.action === 'purge' ? runtime.purgeAudio(a.olderThanDays) : runtime.audioList(); },
  next: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), waitMs: z.number().int().min(0).max(25000).default(20000), limit: z.number().int().min(1).max(100).default(12), follower: z.boolean().default(false), as: z.string().regex(/^[a-z0-9-]{1,24}$/).default('chinh') }).parse(input); return runtime.next(current(a.sessionId), a.after, a.waitMs, a.limit, a.follower, a.as); },
  read: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) }).parse(input); const items = runtime.sources(current(a.sessionId), a.after, a.limit); return { items, nextCursor: items.at(-1)?.id ?? a.after, done: items.length < a.limit }; },
  context: () => ({ agenda: runtime.session?.context ?? null, session: runtime.compact().session }),
  note: input => { const a = z.object({ sessionId: sid.optional(), key: z.string().regex(/^[\w-]{1,80}$/), revision: z.number().int().min(1), kind: z.enum(['observation', 'decision', 'action', 'question', 'correction']), text: z.string().min(1).max(8000), sourceIds: ids.min(1).max(50) }).parse(input); return runtime.publish(current(a.sessionId), a.key, a.revision, a.kind, a.text, a.sourceIds); },
  // Listening again from the WAV, and the list of what is worth listening to again. Both work on a finished session too:
  // without an ID they take the open session, else the latest one.
  recheck: input => { const a = z.object({ sessionId: sid.optional(), sourceId: z.number().int().positive().optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), channel: z.enum(['speaker', 'mic']).optional(), beam: z.number().int().min(1).max(16).optional() }).parse(input); return runtime.recheck(sid.parse(a.sessionId ?? runtime.session?.id ?? runtime.latestSessionId()), a); },
  coverage: input => { const a = z.object({ sessionId: sid.optional() }).parse(input); return runtime.coverage(sid.parse(a.sessionId ?? runtime.session?.id ?? runtime.latestSessionId())); },
  finish: input => runtime.finish(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  raw: input => runtime.writeRaw(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  summary: input => { const a = z.object({ sessionId: sid.optional(), markdown: z.string().min(1).max(40000), sourceIds: ids.min(1).max(200) }).parse(input); return runtime.saveSummary(current(a.sessionId), a.markdown, a.sourceIds); },
  tasks: input => { const a = z.object({ sessionId: sid.optional(), tasks: z.array(z.object({ task: z.string().min(1).max(2000), owner: z.string().max(200).optional(), due: z.string().max(200).optional(), sourceIds: ids.min(1).max(50) })).max(200) }).parse(input); return runtime.saveTasks(current(a.sessionId), a.tasks); },
  history: () => runtime.historyList(),
  glossary: input => {
    const a = z.object({ action: z.enum(['list', 'add', 'remove']).default('list'), name: z.string().max(80).optional(), variants: z.array(z.string().max(80)).max(20).default([]), force: z.boolean().default(false) }).parse(input);
    if (a.action === 'add') return runtime.glossaryAdd(a.name ?? '', a.variants, a.force);
    if (a.action === 'remove') return runtime.glossaryRemove(a.name ?? '');
    return runtime.glossary;
  },
  // Pre-meeting context (participants, brief) and the owner's manual microphone state for the "Tôi" channel.
  participants: input => applyParticipants(runtime, z.object({ participants: z.array(z.any()).max(200) }).parse(input).participants),
  brief: input => ({ markdown: composeBrief(runtime, root, z.object({ sessionId: sid.optional() }).parse(input).sessionId) }),
  picture: input => {
    const a = z.object({ sessionId: sid.optional(), text: z.string().min(1).max(8000).optional(), sourceIds: ids.min(1).max(50).optional() }).parse(input);
    const id = current(a.sessionId);
    if (a.text) { if (!a.sourceIds) throw new Error('PICTURE_NEEDS_SOURCES: --sources <id,…> của các đoạn đã đọc'); return runtime.savePicture(id, a.text, a.sourceIds); }
    return runtime.picture(id);
  },
  mic: input => setMicState(runtime, z.object({ state: z.enum(['on', 'off', 'auto']) }).parse(input).state),
  fixture: input => { if (!runtime.testMode) throw new Error('FIXTURE_DISABLED'); const a = z.object({ text: z.string().min(1).max(8000), language: z.enum(['vi', 'lo', 'th']).optional() }).parse(input); return { id: runtime.ingest(a.text, 'synthetic_fixture', 0, 0, '', '', a.language) }; },
  // Vietnamese lines for Lao segments, written by the Claude session following the meeting.
  translate: input => { const a = z.object({ sessionId: sid.optional(), items: z.array(z.object({ sourceId: z.number().int().positive(), text: z.string().min(1).max(2000) })).min(1).max(100) }).parse(input); return runtime.translate(current(a.sessionId), a.items); },
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
    if (path === '/api/pause') { runtime.requireSession(input.sessionId); await runtime.pause(); return json(response, 200, runtime.snapshot()); }
    if (path === '/api/finish') { await runtime.finish(input.sessionId); return json(response, 200, runtime.snapshot()); }
    if (path === '/api/manual') { runtime.requireSession(input.sessionId); return json(response, 200, { id: runtime.ingest(String(input.text || ''), 'operator_text') }); }
    return json(response, 404, { error: 'NOT_FOUND' });
  } catch (error) { if (!response.headersSent) json(response, 400, { error: String(error) }); else response.end(); }
});
http.requestTimeout = 30000; http.headersTimeout = 10000;
// A host that has just finished its session may still hold the port for a moment while a command already started the next one: wait for it.
const listen = () => new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
try { for (let attempt = 0; ; attempt++) { try { await listen(); break; } catch (error: any) { if (error?.code !== 'EADDRINUSE' || attempt >= 6) throw error; await new Promise(r => setTimeout(r, 500)); } } }
catch (error: any) { console.error(`Meeting runtime already running on ${origin} (${error?.code || error}); exiting without touching history.`); process.exit(1); }
runtime = new MeetingRuntime(root, dataDir, process.env.PMA_TEST_MODE === '1');
// A diagnostic instance must never launch Zoom.
if (runtime.testMode) runtime.opener = () => {};
runtime.on('change', () => { writeRegistry(); for (const response of events) response.write('event: update\ndata: {}\n\n'); });
mkdirSync(dataDir, { recursive: true });
const startedAt = new Date().toISOString();
// daemon.json says who this host is and (Q-3) which session, recorder and worker it is running, so the next host can take a
// session over if this one dies while the recorder goes on. Rewritten whenever those change.
let lastRegistry = '';
function writeRegistry() {
  const registry = runtime.registry(); const text = JSON.stringify(registry); if (text === lastRegistry) return; lastRegistry = text;
  try { writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ url: origin, pid: process.pid, token, version: VERSION, startedAt, ...registry })); } catch (error) { console.error('daemon.json not written:', error); }
}
writeRegistry();
writeFileSync(join(dataDir, 'panel.json'), JSON.stringify({ url: origin, pid: process.pid, startedAt }));
console.error(`Meeting runtime ${VERSION}: ${origin} (capture OFF)`);

// Saved audio never expires and is never deleted here: only `pma audio purge` removes it (owner, 31/10/2026).

// A host with no open session and nothing recording leaves after PMA_IDLE_MINUTES; the CLI starts one again on demand.
setInterval(() => { if ((!runtime.session || runtime.session.ended) && !runtime.capture && !runtime.recorderAlive() && Date.now() - lastActivity > idleMinutes * 60000) void shutdown(); }, Math.min(30000, Math.max(500, idleMinutes * 30000))).unref();
// The session is over, RAW is written and the mix is made: this host has nothing left to do. The grace lets the reply to `pma stop`
// reach the CLI. A diagnostic runtime stays up (tests keep using it) unless PMA_EXIT_AFTER_FINISH=1.
if (!runtime.testMode || process.env.PMA_EXIT_AFTER_FINISH === '1') runtime.on('finished', () => setTimeout(() => void shutdown(), 1500).unref());
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await runtime.close();
  // Gone from daemon.json before the port is released, so a command that comes right after starts a new host instead of calling this one.
  try { rmSync(join(dataDir, 'daemon.json'), { force: true }); rmSync(join(dataDir, 'panel.json'), { force: true }); } catch {}
  for (const response of events) response.end(); http.close(); setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
