import type { DatabaseSync } from 'node:sqlite';

// Durable record of what is still running, what waits for the owner, and what is degraded (0.12.1, docs/EXCEPTIONS_0_12.md).
// Why in the host and not in the chat: the central session must never block on a background agent or on the owner, and must
// be able to answer "what is still running / pending" at any time, including after a restart. Nothing here is ever deleted:
// finished, failed, cancelled, parked and cleared rows stay as history; only `status`/`cleared` move. Times are epoch ms
// from the injected clock, so tests need no real timers.

export type JobKind = 'analysis' | 'translation' | 'other';
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type QuestionStatus = 'open' | 'answered' | 'parked';
export type Job = { id: number; sessionId: string; kind: JobKind; title: string; status: JobStatus; started: number; updated: number; result: string | null; sourceIds: number[]; note: string | null };
export type OwnerQuestion = { id: number; sessionId: string; text: string; asked: number; reminded: number | null; expires: number; closed: number | null; status: QuestionStatus; answer: string | null; sourceIds: number[] };
export type Degraded = { sessionId: string; kind: string; since: number; detail: string; reported: boolean; cleared: number | null };
export type LedgerSummary = { jobs: { running: number; done: number; failed: number; cancelled: number }; questions: { open: number; parked: number }; degraded: string[] };

export const CANCEL_NOTE = 'Dừng khi kết thúc họp';
const KINDS: readonly string[] = ['analysis', 'translation', 'other'];
const MINUTE = 60_000;

// `cleared` (degraded) and `closed` (questions) are additions to the bare design so that recovery, answer and park keep a
// timestamp instead of deleting a row.
export const JOBS_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL, updated INTEGER NOT NULL, result TEXT, source_ids TEXT NOT NULL DEFAULT '[]', note TEXT);
  CREATE INDEX IF NOT EXISTS jobs_by_session ON jobs(session_id, status);
  CREATE TABLE IF NOT EXISTS owner_questions(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, asked INTEGER NOT NULL, reminded INTEGER, expires INTEGER NOT NULL, closed INTEGER, status TEXT NOT NULL, answer TEXT, source_ids TEXT NOT NULL DEFAULT '[]');
  CREATE INDEX IF NOT EXISTS owner_questions_by_session ON owner_questions(session_id, status);
  CREATE TABLE IF NOT EXISTS degraded(session_id TEXT NOT NULL, kind TEXT NOT NULL, since INTEGER NOT NULL, detail TEXT NOT NULL, reported INTEGER NOT NULL DEFAULT 0, cleared INTEGER, PRIMARY KEY(session_id, kind));`;

type Clock = () => number;

// Source ids are provenance: only real positive integers, sorted and unique, so the same set always serialises the same way.
function ids(sourceIds: readonly number[] | undefined): number[] {
  const list = sourceIds ?? [];
  if (!Array.isArray(list) || list.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('INVALID_SOURCE_IDS');
  return [...new Set(list)].sort((a, b) => a - b);
}
const parseIds = (raw: unknown): number[] => { try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.filter(Number.isSafeInteger) : []; } catch { return []; } };
const text = (value: unknown, max: number, code: string) => { const s = String(value ?? '').trim(); if (!s || s.length > max) throw new Error(code); return s; };

const jobOf = (r: any): Job => ({ id: r.id, sessionId: r.session_id, kind: r.kind, title: r.title, status: r.status, started: r.started, updated: r.updated, result: r.result ?? null, sourceIds: parseIds(r.source_ids), note: r.note ?? null });
const questionOf = (r: any): OwnerQuestion => ({ id: r.id, sessionId: r.session_id, text: r.text, asked: r.asked, reminded: r.reminded ?? null, expires: r.expires, closed: r.closed ?? null, status: r.status, answer: r.answer ?? null, sourceIds: parseIds(r.source_ids) });
const degradedOf = (r: any): Degraded => ({ sessionId: r.session_id, kind: r.kind, since: r.since, detail: r.detail, reported: !!r.reported, cleared: r.cleared ?? null });

// Small write transactions. If the caller already opened one (the runtime batches), join it instead of failing on a nested BEGIN.
function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class JobBoard {
  constructor(private db: DatabaseSync, private now: Clock) {}
  start(sessionId: string, kind: JobKind, title: string): number {
    if (!KINDS.includes(kind)) throw new Error('INVALID_JOB_KIND: ' + kind);
    const t = text(title, 200, 'INVALID_JOB_TITLE'), at = this.now();
    return tx(this.db, () => Number(this.db.prepare("INSERT INTO jobs(session_id,kind,title,status,started,updated) VALUES(?,?,?,'running',?,?)").run(sessionId, kind, t, at, at).lastInsertRowid));
  }
  get(id: number): Job | null { const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return r ? jobOf(r) : null; }
  // Returns true when this call moved the job to done. The same result again is a no-op (an agent that re-sends after a lost
  // reply must not make a second record); a different result for a job already closed is refused rather than silently dropped
  // or overwritten, so the first result stays the record and the caller learns the job is not running.
  finish(id: number, result: string, sourceIds: readonly number[] = []): boolean {
    const body = text(result, 200_000, 'INVALID_JOB_RESULT'), src = ids(sourceIds), at = this.now();
    return tx(this.db, () => {
      const row: any = this.db.prepare('SELECT status,result FROM jobs WHERE id=?').get(id);
      if (!row) throw new Error('JOB_NOT_FOUND: ' + id);
      if (row.status === 'done' && row.result === body) return false;
      if (row.status !== 'running') throw new Error('JOB_NOT_RUNNING: #' + id + ' đang ở trạng thái ' + row.status);
      this.db.prepare("UPDATE jobs SET status='done', result=?, source_ids=?, updated=? WHERE id=?").run(body, JSON.stringify(src), at, id);
      return true;
    });
  }
  // Only a running job can fail; a late failure report on a closed job changes nothing.
  fail(id: number, note: string): boolean {
    const n = text(note, 1000, 'INVALID_JOB_NOTE'), at = this.now();
    return tx(this.db, () => this.db.prepare("UPDATE jobs SET status='failed', note=?, updated=? WHERE id=? AND status='running'").run(n, at, id).changes > 0);
  }
  // A job that was set aside (failed, with the range it still owes in its note) runs again: failed -> running. Only a failed job
  // moves; a running, done or cancelled one is left as it is. Used by a heavy job that yielded the GPU to a new meeting (ENG-50).
  reopen(id: number): boolean {
    const at = this.now();
    return tx(this.db, () => this.db.prepare("UPDATE jobs SET status='running', note=NULL, updated=? WHERE id=? AND status='failed'").run(at, id).changes > 0);
  }
  // At stop: everything still running is cancelled (the background agent is told separately by the skill) and returned so the
  // caller can list it in SUMMARY "Chưa làm xong". Calling it again returns [] because nothing is running any more.
  cancelRunning(sessionId: string, note: string = CANCEL_NOTE): Job[] {
    const at = this.now();
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM jobs WHERE session_id=? AND status='running' ORDER BY id").all(sessionId) as { id: number }[];
      for (const { id } of rows) this.db.prepare("UPDATE jobs SET status='cancelled', note=?, updated=? WHERE id=?").run(note, at, id);
      return rows.map(({ id }) => this.get(id)!);
    });
  }
  list(sessionId: string, opts: { status?: JobStatus } = {}): Job[] {
    const rows = opts.status ? this.db.prepare('SELECT * FROM jobs WHERE session_id=? AND status=? ORDER BY id').all(sessionId, opts.status) : this.db.prepare('SELECT * FROM jobs WHERE session_id=? ORDER BY id').all(sessionId);
    return rows.map(jobOf);
  }
  // Work that did not reach "done": still running, failed, or cancelled at stop. These are what SUMMARY "Chưa làm xong" lists.
  unfinished(sessionId: string): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE session_id=? AND status IN ('running','failed','cancelled') ORDER BY id").all(sessionId).map(jobOf);
  }
}

export class QuestionBoard {
  constructor(private db: DatabaseSync, private now: Clock) {}
  // The owner is reminded once at `ttlMinutes` after asking, and the question is parked at twice that, so the reminder has a
  // window to be answered in. Silence is never an answer: expiry parks the question, it does not close it.
  ask(sessionId: string, questionText: string, sourceIds: readonly number[] = [], ttlMinutes = 10): number {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('INVALID_TTL');
    const t = text(questionText, 2000, 'INVALID_QUESTION'), src = ids(sourceIds), at = this.now();
    return tx(this.db, () => Number(this.db.prepare("INSERT INTO owner_questions(session_id,text,asked,expires,status,source_ids) VALUES(?,?,?,?,'open',?)").run(sessionId, t, at, at + 2 * ttlMinutes * MINUTE, JSON.stringify(src)).lastInsertRowid));
  }
  // Questions whose ONE reminder is due: still open, never reminded, and `ttl` (half of expires - asked) has passed. Marking
  // happens in the same transaction, so a second call returns [].
  due(sessionId: string): OwnerQuestion[] {
    const at = this.now();
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM owner_questions WHERE session_id=? AND status='open' AND reminded IS NULL AND asked + (expires - asked) / 2 <= ? ORDER BY id").all(sessionId, at) as any[];
      for (const r of rows) this.db.prepare('UPDATE owner_questions SET reminded=? WHERE id=?').run(at, r.id);
      return rows.map(r => questionOf({ ...r, reminded: at }));
    });
  }
  // Open questions past their expiry become parked (they go to the picture's open questions and SUMMARY). `all` is for the end
  // of the meeting: whatever is still open is parked then, whatever its clock says. Returns what was parked now.
  park(sessionId: string, opts: { all?: boolean } = {}): OwnerQuestion[] {
    const at = this.now();
    return tx(this.db, () => {
      const rows = (opts.all ? this.db.prepare("SELECT * FROM owner_questions WHERE session_id=? AND status='open' ORDER BY id").all(sessionId) : this.db.prepare("SELECT * FROM owner_questions WHERE session_id=? AND status='open' AND expires <= ? ORDER BY id").all(sessionId, at)) as any[];
      for (const r of rows) this.db.prepare("UPDATE owner_questions SET status='parked', closed=? WHERE id=?").run(at, r.id);
      return rows.map(r => questionOf({ ...r, status: 'parked', closed: at }));
    });
  }
  // A real answer closes the question, also a parked one (the owner may answer after the reminder window). The first answer
  // stays: answering again returns false and changes nothing.
  answer(id: number, answerText: string): boolean {
    const a = text(answerText, 4000, 'INVALID_ANSWER'), at = this.now();
    return tx(this.db, () => this.db.prepare("UPDATE owner_questions SET status='answered', answer=?, closed=? WHERE id=? AND status IN ('open','parked')").run(a, at, id).changes > 0);
  }
  get(id: number): OwnerQuestion | null { const r = this.db.prepare('SELECT * FROM owner_questions WHERE id=?').get(id); return r ? questionOf(r) : null; }
  open(sessionId: string): OwnerQuestion[] { return this.byStatus(sessionId, 'open'); }
  parked(sessionId: string): OwnerQuestion[] { return this.byStatus(sessionId, 'parked'); }
  private byStatus(sessionId: string, status: QuestionStatus) { return this.db.prepare('SELECT * FROM owner_questions WHERE session_id=? AND status=? ORDER BY id').all(sessionId, status).map(questionOf); }
}

export class DegradedBoard {
  constructor(private db: DatabaseSync, private now: Clock) {}
  // True only when the caller should tell the owner: the first time a condition appears, or when it appears again after it was
  // cleared (a new episode). Repeats while it stays degraded return false and keep the first detail, so the chat is not spammed.
  mark(sessionId: string, kind: string, detail: string): boolean {
    const k = text(kind, 64, 'INVALID_DEGRADED_KIND'), d = text(detail, 1000, 'INVALID_DEGRADED_DETAIL'), at = this.now();
    return tx(this.db, () => {
      const row: any = this.db.prepare('SELECT cleared FROM degraded WHERE session_id=? AND kind=?').get(sessionId, k);
      if (!row) { this.db.prepare('INSERT INTO degraded(session_id,kind,since,detail,reported) VALUES(?,?,?,?,1)').run(sessionId, k, at, d); return true; }
      if (row.cleared == null) return false;
      this.db.prepare('UPDATE degraded SET since=?, detail=?, reported=1, cleared=NULL WHERE session_id=? AND kind=?').run(at, d, sessionId, k);
      return true;
    });
  }
  // Recovery keeps the row (with the time it cleared). Returns true when something was actually cleared.
  clear(sessionId: string, kind: string): boolean {
    const at = this.now();
    return tx(this.db, () => this.db.prepare('UPDATE degraded SET cleared=? WHERE session_id=? AND kind=? AND cleared IS NULL').run(at, sessionId, kind).changes > 0);
  }
  // Active conditions by default; `all` includes the cleared ones as history.
  list(sessionId: string, opts: { all?: boolean } = {}): Degraded[] {
    return this.db.prepare(`SELECT * FROM degraded WHERE session_id=?${opts.all ? '' : ' AND cleared IS NULL'} ORDER BY since, kind`).all(sessionId).map(degradedOf);
  }
}

// One handle for the runtime: creates the tables, and gives the three boards one shared clock.
export class Ledger {
  readonly jobs: JobBoard; readonly questions: QuestionBoard; readonly degraded: DegradedBoard;
  constructor(private db: DatabaseSync, now: Clock = Date.now) {
    db.exec(JOBS_TABLES_SQL);
    this.jobs = new JobBoard(db, now); this.questions = new QuestionBoard(db, now); this.degraded = new DegradedBoard(db, now);
  }
  // Compact, for `pma status`.
  summaryOf(sessionId: string): LedgerSummary {
    const count = (table: string, status: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=? AND status=?`).get(sessionId, status) as any).n);
    return {
      jobs: { running: count('jobs', 'running'), done: count('jobs', 'done'), failed: count('jobs', 'failed'), cancelled: count('jobs', 'cancelled') },
      questions: { open: count('owner_questions', 'open'), parked: count('owner_questions', 'parked') },
      degraded: this.degraded.list(sessionId).map(d => d.kind),
    };
  }
  // "Chưa làm xong" lines for SUMMARY: unfinished jobs and parked questions, each with its provenance.
  unfinishedLines(sessionId: string): string[] {
    const src = (s: number[]) => (s.length ? ' (nguồn ' + s.map(n => '#' + n).join(', ') + ')' : '');
    return [
      ...this.jobs.unfinished(sessionId).map(j => '- ' + j.title + ' — ' + (j.status === 'running' ? 'đang chạy' : j.status === 'failed' ? 'lỗi' : 'đã dừng') + (j.note ? ': ' + j.note : '') + src(j.sourceIds)),
      ...this.questions.parked(sessionId).map(q => '- Câu hỏi chưa được trả lời: ' + q.text + src(q.sourceIds)),
    ];
  }
}
