// The session host of this machine (0.11). `pma start` creates it; it lives as long as the meeting: it owns the recorder
// (WAV of the whole session), the ASR worker, history and reports, and exits after `stop` once the mix is made. Any other
// command that finds no host starts one only to read history, and that one leaves after PMA_IDLE_MINUTES (2) idle.
// It is independent of any Claude session: the CLI (`pma`) and the thin MCP adapter talk to it over loopback, through
// POST /rpc with the bearer token in daemon.json. There is no web panel any more (removed in 0.12); manual text goes in
// through the `manual` RPC (`pma say`).
import { z } from 'zod';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BRIEF_READER, MeetingRuntime, PICTURE_MAX_CHARS } from './runtime.js';
import { releaseMachine, updateMachine } from './machine_lock.js';
import { composeBrief } from './brief.js';
import { applyParticipants } from './participants.js';
import { setMicState } from './mic.js';

export const VERSION = '0.12.1';
// Settings arrive as `--env KEY=VALUE` when started through WMI (no inherited environment); allowlisted keys only.
const ALLOWED_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH', 'PMA_LOCK_DIR'];
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
const token = randomBytes(32).toString('hex');
// Constructed only after this process owns the port: a second instance must not touch the shared history.
let runtime: MeetingRuntime;
let lastActivity = Date.now();

const sid = z.string().uuid();
const ids = z.array(z.number().int().positive());
// The open meeting, unless an ID is given. With neither, say so in words (zod's "expected string, received undefined" did not).
const current = (sessionId?: string) => { const id = sessionId ?? runtime.session?.id; if (id === undefined) throw new Error('NO_OPEN_SESSION: không có cuộc họp nào đang mở; thêm --session <id> (pma history)'); return sid.parse(id); };
// Work done after the meeting (report, summary, tasks): the open meeting, else the latest one. After `pma stop` the host leaves and
// the next command starts a new host with no open meeting (03/11: `pma summary` without --session failed).
const afterwards = (sessionId?: string) => sid.parse(sessionId ?? runtime.session?.id ?? runtime.latestSessionId());
const languages = z.array(z.enum(['vi', 'lo', 'th'])).min(1).max(3).default(['vi', 'lo', 'th']);
// An id given by a command must belong to the meeting it acts on (fencing): a job, question, decision or action of another meeting is refused.
const owned = (item: { sessionId: string } | null, sessionId: string, what: string) => { if (!item) throw new Error(`${what}_NOT_FOUND`); if (item.sessionId !== sessionId) throw new Error(`${what}_OF_ANOTHER_MEETING`); return item; };

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
  next: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), waitMs: z.number().int().min(0).max(25000).default(20000), limit: z.number().int().min(1).max(100).default(12), follower: z.boolean().default(false), as: z.string().regex(/^[a-z0-9-]{1,24}$/).default('chinh'), ack: z.number().int().nonnegative().optional(), lease: z.string().regex(/^[a-z0-9]{8,64}$/).optional() }).parse(input); return runtime.next(current(a.sessionId), a.after, a.waitMs, a.limit, a.follower, a.as, { ack: a.ack, lease: a.lease }); },
  release: input => { const a = z.object({ sessionId: sid.optional(), as: z.string().regex(/^[a-z0-9-]{1,24}$/), lease: z.string().regex(/^[a-z0-9]{8,64}$/), ack: z.number().int().nonnegative() }).parse(input); return runtime.release(current(a.sessionId), a.as, a.lease, a.ack); },
  read: input => { const a = z.object({ sessionId: sid.optional(), after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100), as: z.string().regex(/^[a-z0-9-]{1,24}$/).optional() }).parse(input); return runtime.read(current(a.sessionId), a.after, a.limit, a.as); },
  context: () => ({ agenda: runtime.session?.context ?? null, session: runtime.compact().session }),
  note: input => { const a = z.object({ sessionId: sid.optional(), key: z.string().regex(/^[\w-]{1,80}$/), revision: z.number().int().min(1), kind: z.enum(['observation', 'decision', 'action', 'question', 'correction']), text: z.string().min(1).max(8000), sourceIds: ids.min(1).max(50) }).parse(input); return runtime.publish(current(a.sessionId), a.key, a.revision, a.kind, a.text, a.sourceIds); },
  // Text typed by the owner (was the panel's /api/manual): origin operator_text, shown as "nhập tay" in RAW; never ASR, never remote.
  manual: input => { const a = z.object({ sessionId: sid.optional(), text: z.string().trim().min(1).max(8000) }).parse(input); runtime.requireSession(current(a.sessionId)); return { id: runtime.ingest(a.text, 'operator_text') }; },
  // Listening again from the WAV, and the list of what is worth listening to again. Both work on a finished session too:
  // without an ID they take the open session, else the latest one.
  recheck: input => { const a = z.object({ sessionId: sid.optional(), sourceId: z.number().int().positive().optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), channel: z.enum(['speaker', 'mic']).optional(), beam: z.number().int().min(1).max(16).optional() }).parse(input); return runtime.recheck(afterwards(a.sessionId), a); },
  coverage: input => { const a = z.object({ sessionId: sid.optional() }).parse(input); return runtime.coverage(afterwards(a.sessionId)); },
  finish: input => runtime.finish(current(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  raw: input => runtime.writeRaw(afterwards(z.object({ sessionId: sid.optional() }).parse(input).sessionId)),
  summary: input => { const a = z.object({ sessionId: sid.optional(), markdown: z.string().min(1).max(40000), sourceIds: ids.min(1).max(200) }).parse(input); return runtime.saveSummary(afterwards(a.sessionId), a.markdown, a.sourceIds); },
  tasks: input => { const a = z.object({ sessionId: sid.optional(), tasks: z.array(z.object({ task: z.string().min(1).max(2000), owner: z.string().max(200).optional(), due: z.string().max(200).optional(), ownerBasis: z.enum(['stated', 'confirmed', 'inferred']).optional(), sourceIds: ids.min(1).max(50) })).max(200) }).parse(input); return runtime.saveTasks(afterwards(a.sessionId), a.tasks); },
  history: () => runtime.historyList(),
  glossary: input => {
    const a = z.object({ action: z.enum(['list', 'add', 'remove']).default('list'), name: z.string().max(80).optional(), variants: z.array(z.string().max(80)).max(20).default([]), force: z.boolean().default(false) }).parse(input);
    if (a.action === 'add') return runtime.glossaryAdd(a.name ?? '', a.variants, a.force);
    if (a.action === 'remove') return runtime.glossaryRemove(a.name ?? '');
    return runtime.glossary;
  },
  // Pre-meeting context (participants, brief) and the owner's manual microphone state for the "Tôi" channel.
  participants: input => applyParticipants(runtime, z.object({ participants: z.array(z.any()).max(200) }).parse(input).participants),
  // Reading the brief as a role is the context receipt (ENG-45): the pack version that role's agent was shown is recorded then.
  brief: input => {
    const a = z.object({ sessionId: sid.optional(), as: z.string().regex(/^[a-z0-9-]{1,24}$/).optional() }).parse(input);
    const markdown = composeBrief(runtime, root, a.sessionId); const id = a.sessionId ?? runtime.session?.id;
    if (!id) return { markdown };
    const block = runtime.contextBlock(id);
    if (!a.as) return { markdown: markdown + (block ? '\n\n' + block + '\n' : '') };
    const bound = runtime.bind(id, a.as, BRIEF_READER);
    return { markdown: markdown + '\n\n' + block + `\nĐã ghi nhận: vai ${a.as} đọc context v${bound.version} (${bound.readiness.state}).\n`, context: bound };
  },
  correct: input => { const a = z.object({ sessionId: sid.optional(), raw: z.string().trim().min(1).max(120), corrected: z.string().trim().min(1).max(120), sourceId: z.number().int().positive().optional(), basis: z.enum(['user_confirmed', 'inferred']).default('inferred'), scope: z.enum(['meeting', 'company']).default('meeting') }).parse(input); return runtime.addToContext(current(a.sessionId), 'corrections', { raw: a.raw, corrected: a.corrected, ...(a.sourceId ? { sourceId: String(a.sourceId) } : {}), basis: a.basis, scope: a.scope, source: 'correction' }); },
  doc: input => { const a = z.object({ sessionId: sid.optional(), label: z.string().trim().min(1).max(120), pointer: z.string().trim().min(1).max(500) }).parse(input); return runtime.addToContext(current(a.sessionId), 'docs', { label: a.label, pointer: a.pointer, source: 'owner_docs' }); },
  // Decisions -> actions (decisions.ts, ENG-49). `grant` records authority the OWNER gave in chat; nothing reads it from the transcript.
  grant: input => { const a = z.object({ sessionId: sid.optional(), person: z.string().trim().min(1).max(80), scope: z.string().trim().min(1).max(120).default('*'), source: z.string().trim().min(1).max(300) }).parse(input); return { granted: runtime.decisions.grant(current(a.sessionId), a.person, a.scope, 'owner', a.source) }; },
  propose: input => { const a = z.object({ sessionId: sid.optional(), text: z.string().trim().min(1).max(2000), sourceIds: ids.max(50).default([]) }).parse(input); return { id: runtime.decisions.propose(current(a.sessionId), a.text, a.sourceIds) }; },
  decide: input => {
    const a = z.object({ sessionId: sid.optional(), id: z.number().int().positive(), by: z.string().trim().min(1).max(80), sourceIds: ids.max(50).default([]), scope: z.string().max(120).optional(), change: z.string().trim().min(1).max(2000).optional() }).parse(input);
    const s = current(a.sessionId); owned(runtime.decisions.get(a.id), s, 'DECISION');
    return runtime.decide(s, a.id, a.by, a.sourceIds, { scope: a.scope, change: a.change });
  },
  withdraw: input => { const a = z.object({ sessionId: sid.optional(), id: z.number().int().positive(), by: z.string().trim().min(1).max(80), note: z.string().max(1000).default(''), scope: z.string().max(120).optional() }).parse(input); const s = current(a.sessionId); owned(runtime.decisions.get(a.id), s, 'DECISION'); return runtime.decisions.withdraw(a.id, a.by, a.note, { scope: a.scope }); },
  action: input => {
    const a = z.object({ sessionId: sid.optional(), step: z.enum(['plan', 'done', 'fail', 'rollback']), id: z.number().int().positive(), text: z.string().trim().min(1).max(4000) }).parse(input);
    const s = afterwards(a.sessionId); const ledger = runtime.decisions;
    if (a.step === 'plan') { owned(ledger.get(a.id), s, 'DECISION'); return { id: ledger.plan(a.id, a.text) }; }
    owned(ledger.getAction(a.id), s, 'ACTION');
    return { ok: a.step === 'done' ? ledger.done(a.id, a.text) : a.step === 'fail' ? ledger.fail(a.id, a.text) : ledger.rollback(a.id, a.text), action: ledger.getAction(a.id) };
  },
  decisions: input => { const s = afterwards(z.object({ sessionId: sid.optional() }).parse(input).sessionId); const ledger = runtime.decisions; return { list: ledger.list(s), pending: ledger.pending(s), summary: ledger.summaryOf(s), report: ledger.reportLines(s) }; },
  // Context binding (ENG-45): a follow process says it read the context pack.
  bind: input => { const a = z.object({ sessionId: sid.optional(), as: z.string().regex(/^[a-z0-9-]{1,24}$/), consumer: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(input); return runtime.bind(current(a.sessionId), a.as, a.consumer); },
  // Background jobs, owner questions, degraded conditions (jobs.ts, ENG-46). Recorded by the host; nothing here waits for anything.
  job: input => {
    const a = z.object({ sessionId: sid.optional(), action: z.enum(['start', 'done', 'fail', 'list']), kind: z.enum(['analysis', 'translation', 'other']).default('analysis'), title: z.string().trim().min(1).max(300).optional(), id: z.number().int().positive().optional(), result: z.string().min(1).max(40000).optional(), sourceIds: ids.max(200).default([]), note: z.string().max(2000).optional(), status: z.enum(['running', 'done', 'failed', 'cancelled']).optional() }).parse(input);
    const jobs = runtime.ledger.jobs;
    if (a.action === 'start') { if (!a.title) throw new Error('JOB_NEEDS_TITLE'); return { id: jobs.start(current(a.sessionId), a.kind, a.title) }; }
    if (a.action === 'list') return jobs.list(afterwards(a.sessionId), { status: a.status });
    if (!a.id) throw new Error('JOB_NEEDS_ID');
    owned(jobs.get(a.id), afterwards(a.sessionId), 'JOB');
    if (a.action === 'done') { if (!a.result) throw new Error('JOB_NEEDS_RESULT'); return { saved: jobs.finish(a.id, a.result, a.sourceIds), job: jobs.get(a.id) }; }
    return { failed: jobs.fail(a.id, a.note ?? '') };
  },
  ask: input => { const a = z.object({ sessionId: sid.optional(), text: z.string().trim().min(1).max(2000), sourceIds: ids.max(50).default([]), ttl: z.number().min(1).max(240).default(10) }).parse(input); return { id: runtime.ledger.questions.ask(current(a.sessionId), a.text, a.sourceIds, a.ttl) }; },
  answer: input => { const a = z.object({ sessionId: sid.optional(), id: z.number().int().positive(), text: z.string().trim().min(1).max(4000) }).parse(input); owned(runtime.ledger.questions.get(a.id), afterwards(a.sessionId), 'QUESTION'); return { answered: runtime.ledger.questions.answer(a.id, a.text) }; },
  // `due` marks the one reminder as given; expired open questions become parked (silence is not an answer).
  questions: input => { const s = afterwards(z.object({ sessionId: sid.optional() }).parse(input).sessionId); const q = runtime.ledger.questions; const due = q.due(s); q.park(s); return { due, open: q.open(s), parked: q.parked(s) }; },
  degraded: input => {
    const a = z.object({ sessionId: sid.optional(), action: z.enum(['mark', 'clear', 'list']).default('list'), kind: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(), detail: z.string().max(1000).default('') }).parse(input);
    const s = afterwards(a.sessionId); const board = runtime.ledger.degraded;
    if (a.action === 'list') return board.list(s);
    if (!a.kind) throw new Error('DEGRADED_NEEDS_KIND');
    return a.action === 'mark' ? { first: board.mark(s, a.kind, a.detail) } : { cleared: board.clear(s, a.kind) };
  },
  picture: input => {
    const a = z.object({ sessionId: sid.optional(), text: z.string().min(1).max(PICTURE_MAX_CHARS).optional(), sourceIds: ids.min(1).max(50).optional() }).parse(input);
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
    // /rpc is the only door (0.12): no page, no cookie, no /api/*, no event stream.
    return json(response, 404, { error: 'NOT_FOUND' });
  } catch (error) { if (!response.headersSent) json(response, 400, { error: String(error) }); else response.end(); }
});
http.requestTimeout = 30000; http.headersTimeout = 10000;
// A host that has just finished its session may still hold the port for a moment while a command already started the next one: wait for it.
const listen = () => new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
try { for (let attempt = 0; ; attempt++) { try { await listen(); break; } catch (error: any) { if (error?.code !== 'EADDRINUSE' || attempt >= 6) throw error; await new Promise(r => setTimeout(r, 500)); } } }
catch (error: any) { console.error(`Meeting runtime already running on ${origin} (${error?.code || error}); exiting without touching history.`); process.exit(1); }
runtime = new MeetingRuntime(root, dataDir, process.env.PMA_TEST_MODE === '1', { port });
// A diagnostic instance must never launch Zoom.
if (runtime.testMode) runtime.opener = () => {};
runtime.on('change', () => writeRegistry());
mkdirSync(dataDir, { recursive: true });
const startedAt = new Date().toISOString();
// daemon.json says who this host is and (Q-3) which session, recorder and worker it is running, so the next host can take a
// session over if this one dies while the recorder goes on. Rewritten whenever those change.
let lastRegistry = '';
function writeRegistry() {
  const registry = runtime.registry(); const text = JSON.stringify(registry); if (text === lastRegistry) return; lastRegistry = text;
  try { writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ url: origin, pid: process.pid, token, version: VERSION, startedAt, ...registry })); } catch (error) { console.error('daemon.json not written:', error); }
  if (runtime.machine) try { updateMachine(runtime.machine.token, { sessionId: registry.sessionId, recorderPid: runtime.recorderAlive() ? runtime.recorder.pid : null, workerPid: runtime.capture?.pid ?? null }); } catch {}
}
writeRegistry();
console.error(`Meeting runtime ${VERSION}: ${origin} (capture OFF)`);

// Saved audio never expires and is never deleted here: only `pma audio purge` removes it (owner, 31/10/2026).

// A host with no open session and nothing recording leaves after PMA_IDLE_MINUTES; the CLI starts one again on demand.
setInterval(() => { if (!runtime.session || runtime.session.ended) try { runtime.releaseWhenIdle(); } catch (error) { console.error('releaseWhenIdle:', error); } if ((!runtime.session || runtime.session.ended) && !runtime.capture && !runtime.recorderAlive() && Date.now() - lastActivity > idleMinutes * 60000) void shutdown(); }, Math.min(30000, Math.max(500, idleMinutes * 30000))).unref();
// The session is over, RAW is written and the mix is made: this host has nothing left to do. The grace lets the reply to `pma stop`
// reach the CLI. A diagnostic runtime stays up (tests keep using it) unless PMA_EXIT_AFTER_FINISH=1.
if (!runtime.testMode || process.env.PMA_EXIT_AFTER_FINISH === '1') runtime.on('finished', () => setTimeout(() => void shutdown(), 1500).unref());
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await runtime.close();
  // Gone from daemon.json before the port is released, so a command that comes right after starts a new host instead of calling this one.
  try { rmSync(join(dataDir, 'daemon.json'), { force: true }); } catch {}
  http.close(); setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
// However the host ends, a lock it still holds goes with it (a lock left behind is also seen as stale by PID).
process.on('exit', () => { if (runtime?.machine && !runtime.capture && !runtime.recorderAlive()) try { releaseMachine(runtime.machine.token); } catch {} });
