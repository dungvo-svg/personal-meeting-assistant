import type { DatabaseSync } from 'node:sqlite';
import { JOBS_TABLES_SQL } from './jobs.js';
import type { OwnerQuestion } from './jobs.js';
import { DECISIONS_TABLES_SQL } from './decisions.js';
import type { Action, Decision, Grant } from './decisions.js';
import { readiness } from './context_pack.js';
import type { Bindings, ContextPack, RosterItem } from './context_pack.js';

// Co-working roles (v5): Zoom is the meeting frame; each person's Claude (Dũng, Quân, Oanh) gets the context and the role that
// fit that person, takes tasks and answers inside that person's scope, and every decision point converges into the central
// session (Dũng's). Pure rules plus a small sqlite ledger in the style of jobs.ts / decisions.ts: injectable clock, nothing is
// ever deleted (declined, answered, handled rows stay as history), small write transactions. No fs, no network, no process.
//
// What this module is and is NOT:
//   - Today only ONE machine exists. A seat is therefore either a `simulated_role` (a role played on this machine; it is
//     NEVER shown as the person's real Claude) or a `remote_claude`. A remote seat is refused (REMOTE_NOT_CONSENTED) unless the
//     OWNER recorded BOTH an endpoint and a consent reference. Even then this module cannot reach or verify anything: status()
//     says "bound, not verified" and never "connected". The caller must pass `consentRef` only from what the owner said in the
//     chat with the owner, never words heard from a meeting participant (same rule as DecisionLedger.grant).
//   - Authority is not here. Nothing in this file decides anything. A reply can PROPOSE (it returns the arguments for
//     DecisionLedger.propose); the central session decides through DecisionLedger, with authority only as the owner granted it.
//   - A person is never derived. The speaker is whoever the caller names. An unknown speaker ("Tôi", the mic channel, "chưa xác
//     định", a pause, audio) stays unknown: it cannot hold a seat, be assigned a task, or get a role view.
//   - Missing data (a role description or scope the owner did not give, a person absent from the roster) is reported in
//     `missing` and left empty, never filled in.
//
// Rules, first match wins (the order is part of the contract and is tested):
//   seat(...)
//     1  person is an unknown speaker / channel / not a real name                                   UNKNOWN_SPEAKER
//     2  kind is not simulated_role | remote_claude                                                 INVALID_SEAT_KIND
//     3  remote_claude without BOTH endpoint and consentRef                                         REMOTE_NOT_CONSENTED
//     4  simulated_role that carries an endpoint or consentRef (would pretend to be remote)         INVALID_SEAT
//     5  older generation than the recorded one, whatever the consumer (a zombie of a previous one) STALE_GENERATION
//     6  identical to the current seat                                                              the same seat, no new row
//     7  otherwise                                                                                  new row (the latest row per person is the current seat)
//   assign(...)
//     1  unknown speaker                                                                            UNKNOWN_SPEAKER
//     2  person has no seat in this session                                                         NO_SEAT
//     3  fromDecisionId not in this session / not 'decided'                                         DECISION_NOT_FOUND / DECISION_NOT_DECIDED
//     4  same person + text (+ decision) already open/accepted/answered                             the same id, no duplicate
//   accept / decline / reply (the caller is "the seat of the assignee")
//     1  assignment unknown                                                                         ASSIGNMENT_NOT_FOUND
//     2  person is not the assignee (compared by name only, nothing else is consulted)              NOT_ASSIGNEE
//     3  assignee has no seat                                                                       NO_SEAT
//     4  seat is bound to a consumer and the caller is another one / names none                     WRONG_CONSUMER
//     5  seat is bound to a consumer and the caller did not give its generation                     GENERATION_REQUIRED
//     6  caller generation older than the seat's                                                    STALE_GENERATION
//     7  caller generation newer than the seat's (it has not been bound again yet)                  NOT_BOUND
//     8  reply only: opts has a key other than consumerId, generation, propose, context            INVALID_REPLY_OPTION
//     9  assignment already declined (answered for decline), or the transition is not allowed      ASSIGNMENT_CLOSED
//    10  reply only: no `context` while the ledger was made with requireContext (the host)          CONTEXT_REQUIRED
//    10b reply only: `context` given and context_pack readiness() says the seat has not read the
//        current pack of this session (stale version, wrong consumer, other session, not bound)    CONTEXT_NOT_CURRENT
//    11  otherwise                                                                                  recorded; a reply returns decided:false and, when asked, a proposal payload
//   Seat provenance (kind, simulated) is stamped on every reply, decline and proposal at the moment it happens.
export type SeatKind = 'simulated_role' | 'remote_claude';
export type AssignmentStatus = 'open' | 'accepted' | 'declined' | 'answered';
export type MarkKind = 'decision' | 'action' | 'question' | 'assignment';
export type HandledKind = 'reply' | 'assignment' | 'question';
export type CentralKind = 'proposal' | 'declined' | 'overdue' | 'parked_question';

export type Seat = {
  sessionId: string; person: string; kind: SeatKind; endpoint: string | null; consentRef: string | null; boundAt: number;
  role: string; consumerId: string | null; generation: number; roleDescription: string | null; scope: string | null;
};
export type SeatInput = { person: string; kind: SeatKind; endpoint?: string; consentRef?: string; role?: string; consumerId?: string; generation?: number; roleDescription?: string; scope?: string };
export type SeatStatus = {
  person: string; kind: SeatKind; simulated: boolean; live: false; label: string; boundAt: number; role: string; consumerId: string | null; generation: number;
  endpoint: string | null; consentRef: string | null; roleDescription: string | null; scope: string | null; missing: string[];
};
export type CoworkStatus = { sessionId: string; seats: SeatStatus[]; simulated: number; remote: number; liveRemote: 0; missing: string[]; note: string };
export type Assignment = {
  id: number; sessionId: string; person: string; text: string; sourceIds: number[]; fromDecisionId: number | null; status: AssignmentStatus;
  dueAt: number | null; seatKind: SeatKind; created: number; updated: number; note: string | null;
};
export type Provenance = { who: string | null; seatKind: SeatKind | null; simulated: boolean; sourceIds: number[]; at: number };
export type ProposalPayload = { sessionId: string; text: string; sourceIds: number[]; provenance: Provenance };
export type Reply = {
  id: number; assignmentId: number; sessionId: string; person: string; text: string; sourceIds: number[]; proposal: string | null;
  seatKind: SeatKind; simulated: boolean; decisionId: number | null; created: number;
};
export type Caller = { consumerId?: string; generation?: number };
export type ReplyOptions = Caller & { propose?: string; context?: { pack: ContextPack | null; bindings: Bindings } };
export type ReplyResult = { id: number; assignmentId: number; seatKind: SeatKind; simulated: boolean; decided: false; proposal?: ProposalPayload };
export type Mark = { refKind: MarkKind; refId: number; persons: string[] };
export type CentralItem = {
  kind: CentralKind; refKind: HandledKind; refId: number; assignmentId: number | null; person: string | null; addressedTo: string[];
  text: string; detail: string | null; provenance: Provenance; proposal?: ProposalPayload; needs: string;
};
export type RoleData = { decisions?: readonly Decision[]; actions?: readonly Action[]; questions?: readonly OwnerQuestion[]; assignments?: readonly Assignment[]; marks?: readonly Mark[]; seat?: Seat | null };
export type RoleView = {
  person: string | null; unknown: boolean; seat: SeatStatus | null; roster: RosterItem | null; topics: string[];
  decisions: Decision[]; actions: Action[]; questions: OwnerQuestion[]; assignments: Assignment[]; missing: string[];
};

const ANY = '*';
const KINDS: readonly string[] = ['simulated_role', 'remote_claude'];
const MARK_KINDS: readonly string[] = ['decision', 'action', 'question', 'assignment'];
const HANDLED_KINDS: readonly string[] = ['reply', 'assignment', 'question'];
const REPLY_KEYS: readonly string[] = ['consumerId', 'generation', 'propose', 'context'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KIND_ORDER: Record<CentralKind, number> = { proposal: 0, declined: 1, overdue: 2, parked_question: 3 };

// Words that are not a person: first person, anonymous speaker, the mic or a channel, "unknown" in vi / lo / th / en. Compared
// after trimming and lower-casing; anything that is not on this list and not empty is treated as a name the caller gave.
const UNKNOWN = /^(?:tôi|toi|ta|mình|me|i|myself|unknown|unidentified|unnamed|someone|somebody|anyone|speaker(?:\s*\d+)?|người nói(?:\s*\d+)?|không rõ|không biết|chưa rõ|chưa xác định|chưa biết|ai đó|n\/a|none|null|undefined|mic|micro|microphone|channel|kênh|ຂ້ອຍ|ບໍ່ຮູ້|ບໍ່ຮູ້ຈັກ|ฉัน|ผม|ไม่ทราบ|ไม่ทราบชื่อ|tôi\s*\(.*\)|[?-]+)$/u;

export const COWORK_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS cowork_seats(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, person TEXT NOT NULL, person_key TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT, consent_ref TEXT, role TEXT NOT NULL, consumer_id TEXT, generation INTEGER NOT NULL, role_description TEXT, scope TEXT, bound_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS cowork_seats_by_person ON cowork_seats(session_id, person_key, id);
  CREATE TABLE IF NOT EXISTS cowork_assignments(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, person TEXT NOT NULL, person_key TEXT NOT NULL, text TEXT NOT NULL, source_ids TEXT NOT NULL DEFAULT '[]', from_decision_id INTEGER, status TEXT NOT NULL, due_at INTEGER, seat_kind TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, note TEXT);
  CREATE INDEX IF NOT EXISTS cowork_assignments_by_session ON cowork_assignments(session_id, person_key, status);
  CREATE TABLE IF NOT EXISTS cowork_replies(id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER NOT NULL, session_id TEXT NOT NULL, person TEXT NOT NULL, text TEXT NOT NULL, source_ids TEXT NOT NULL DEFAULT '[]', proposal TEXT, seat_kind TEXT NOT NULL, simulated INTEGER NOT NULL, decision_id INTEGER, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS cowork_replies_by_assignment ON cowork_replies(assignment_id);
  CREATE TABLE IF NOT EXISTS cowork_marks(session_id TEXT NOT NULL, ref_kind TEXT NOT NULL, ref_id INTEGER NOT NULL, person_key TEXT NOT NULL, person TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(session_id, ref_kind, ref_id, person_key));
  CREATE TABLE IF NOT EXISTS cowork_handled(ref_kind TEXT NOT NULL, ref_id INTEGER NOT NULL, session_id TEXT NOT NULL, by TEXT NOT NULL, note TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(ref_kind, ref_id));`;

type Clock = () => number;

// ---- small helpers (same style as jobs.ts / decisions.ts) ---------------------------------------------------------------
function ids(sourceIds: readonly number[] | undefined): number[] {
  const list = sourceIds ?? [];
  if (!Array.isArray(list) || list.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('INVALID_SOURCE_IDS');
  return [...new Set(list)].sort((a, b) => a - b);
}
const parseIds = (raw: unknown): number[] => { try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.filter(Number.isSafeInteger) : []; } catch { return []; } };
const text = (value: unknown, max: number, code: string) => { const s = String(value ?? '').normalize('NFC').trim(); if (!s || s.length > max) throw new Error(code); return s; };
// Optional text: absent or blank is "not given" (null); too long or not a string is an error.
function opt(value: unknown, max: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(code);
  const s = value.normalize('NFC').trim();
  if (!s) return null;
  if (s.length > max) throw new Error(code);
  return s;
}
const keyOf = (name: string) => name.normalize('NFC').trim().toLowerCase();
const isUnknownName = (name: string) => UNKNOWN.test(keyOf(name));
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function realPerson(value: unknown): string {
  const s = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!s || s.length > 120 || isUnknownName(s)) throw new Error('UNKNOWN_SPEAKER: "' + (typeof value === 'string' ? value.slice(0, 40) : '') + '" không phải một người đã xác định: không gán, không tạo phiên, không suy từ kênh, micro, khoảng lặng hay âm thanh');
  return s;
}
function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const seatOf = (r: any): Seat => ({ sessionId: r.session_id, person: r.person, kind: r.kind, endpoint: r.endpoint ?? null, consentRef: r.consent_ref ?? null, boundAt: r.bound_at, role: r.role, consumerId: r.consumer_id ?? null, generation: r.generation, roleDescription: r.role_description ?? null, scope: r.scope ?? null });
const assignmentOf = (r: any): Assignment => ({ id: r.id, sessionId: r.session_id, person: r.person, text: r.text, sourceIds: parseIds(r.source_ids), fromDecisionId: r.from_decision_id ?? null, status: r.status, dueAt: r.due_at ?? null, seatKind: r.seat_kind, created: r.created, updated: r.updated, note: r.note ?? null });
const replyOf = (r: any): Reply => ({ id: r.id, assignmentId: r.assignment_id, sessionId: r.session_id, person: r.person, text: r.text, sourceIds: parseIds(r.source_ids), proposal: r.proposal ?? null, seatKind: r.seat_kind, simulated: !!r.simulated, decisionId: r.decision_id ?? null, created: r.created });
const questionOf = (r: any): OwnerQuestion => ({ id: r.id, sessionId: r.session_id, text: r.text, asked: r.asked, reminded: r.reminded ?? null, expires: r.expires, closed: r.closed ?? null, status: r.status, answer: r.answer ?? null, sourceIds: parseIds(r.source_ids) });

// ---- pure: roster, honest status, role view --------------------------------------------------------------------------------
export function rosterEntry(pack: ContextPack | null | undefined, person: string): RosterItem | null {
  const key = keyOf(person);
  return pack?.roster.find(r => keyOf(r.name) === key || r.aliases.some(a => keyOf(a) === key)) ?? null;
}

// What is missing for ONE seat. Everything listed is something the owner did not provide; nothing is derived or guessed.
function missingOfSeat(seat: Seat, pack?: ContextPack | null): string[] {
  const out: string[] = [];
  if (!seat.roleDescription) out.push('role_description:' + seat.person);
  if (!seat.scope) out.push('scope:' + seat.person);
  if (pack && !rosterEntry(pack, seat.person)) out.push('roster:' + seat.person);
  return out;
}

// The kind is always reported as it is. A simulated role says so in the label; a remote seat says what is recorded (endpoint +
// consent) and that this module could not check the connection. `live` is the literal false: nothing here can see a remote Claude.
export function seatStatus(seat: Seat, pack?: ContextPack | null): SeatStatus {
  const simulated = seat.kind === 'simulated_role';
  const label = simulated
    ? 'Vai giả lập của ' + seat.person + ' trên máy này, không phải Claude thật của ' + seat.person
    : 'Claude của ' + seat.person + ' (từ xa): owner đã ghi endpoint và consent; chưa kiểm được kết nối thật';
  return {
    person: seat.person, kind: seat.kind, simulated, live: false, label, boundAt: seat.boundAt, role: seat.role, consumerId: seat.consumerId, generation: seat.generation,
    endpoint: seat.endpoint, consentRef: seat.consentRef, roleDescription: seat.roleDescription, scope: seat.scope, missing: missingOfSeat(seat, pack),
  };
}

// What one seat may see. Visible to `person`:
//   - their own roster entry (by name or alias; absent -> null + missing, never invented) and the meeting's topics;
//   - decisions: marked for them; or, when not marked at all, decided by them, or they hold authority ('*', or a topic grant whose
//     topic appears as a whole word in the decision text: visibility only, never authority), or an assignment of theirs came from it;
//   - actions: marked for them, or, when not marked, those of a decision visible to them;
//   - questions: only those marked (addressed) to them; an unmarked owner question stays with the central session;
//   - assignments: their own.
// Anything marked for other people only is hidden, whatever else would make it visible. An unknown speaker gets an empty view.
export function roleView(pack: ContextPack | null | undefined, person: string, grants: readonly Grant[], data: RoleData = {}): RoleView {
  const name = typeof person === 'string' ? person.normalize('NFC').trim() : '';
  if (!name || name.length > 120 || isUnknownName(name)) {
    return { person: null, unknown: true, seat: null, roster: null, topics: [], decisions: [], actions: [], questions: [], assignments: [], missing: ['person_unknown'] };
  }
  const key = keyOf(name), sessionId = pack?.meeting.sessionId;
  const inSession = <T extends { sessionId: string }>(item: T) => sessionId === undefined || item.sessionId === sessionId;
  const mine = grants.filter(g => keyOf(g.person) === key && inSession(g));
  const holdsAll = mine.some(g => g.scope === ANY);
  const scopes = mine.filter(g => g.scope !== ANY).map(g => new RegExp('(?<![\\p{L}\\p{N}])' + escape(g.scope.normalize('NFC').trim()) + '(?![\\p{L}\\p{N}])', 'iu'));

  const marks = new Map<string, Set<string>>();
  for (const m of data.marks ?? []) marks.set(m.refKind + ':' + m.refId, new Set(m.persons.map(keyOf)));
  const assignments = (data.assignments ?? []).filter(a => inSession(a) && keyOf(a.person) === key);
  const assignedFrom = new Set(assignments.map(a => a.fromDecisionId).filter((n): n is number => n !== null));

  const allDecisions = (data.decisions ?? []).filter(inSession), byId = new Map(allDecisions.map(d => [d.id, d] as const));
  const decisionVisible = (d: Decision): boolean => {
    const marked = marks.get('decision:' + d.id);
    if (marked) return marked.has(key);
    return (d.decidedBy !== null && keyOf(d.decidedBy) === key) || holdsAll || scopes.some(re => re.test(d.text)) || assignedFrom.has(d.id);
  };
  const decisions = allDecisions.filter(decisionVisible);
  const actions = (data.actions ?? []).filter(inSession).filter(a => {
    const marked = marks.get('action:' + a.id);
    if (marked) return marked.has(key);
    const d = byId.get(a.decisionId);
    return d ? decisionVisible(d) : false;
  });
  const questions = (data.questions ?? []).filter(inSession).filter(q => marks.get('question:' + q.id)?.has(key) === true);

  const roster = rosterEntry(pack, name);
  const seat = data.seat ? seatStatus(data.seat, pack) : null;
  const missing = [...(pack ? pack.missing.map(m => 'pack:' + m) : ['pack'])];
  if (pack && !roster) missing.push('roster:' + name);
  if (seat) missing.push(...seat.missing.filter(m => !m.startsWith('roster:')));
  return { person: name, unknown: false, seat, roster: roster ? { ...roster } : null, topics: pack ? [...pack.topics] : [], decisions, actions, questions, assignments, missing: [...new Set(missing)] };
}

// ---- the ledger ----------------------------------------------------------------------------------------------------------
export class CoworkLedger {
  // `requireContext` (the host sets it): a reply without the host's own pack and bindings is refused, so no caller can answer
  // without having read the current context. Off in the pure tests that check other rules.
  constructor(private db: DatabaseSync, private now: Clock = Date.now, private opts: { requireContext?: boolean } = {}) {
    // The owner's questions and the decisions live in the sibling modules' tables; creating them is idempotent (IF NOT EXISTS).
    db.exec(JOBS_TABLES_SQL); db.exec(DECISIONS_TABLES_SQL); db.exec(COWORK_TABLES_SQL);
  }

  // ---- seats ------------------------------------------------------------------------------------------------------------
  seat(sessionId: string, input: SeatInput): Seat {
    const sid = text(sessionId, 100, 'INVALID_SESSION'), person = realPerson(input?.person), key = keyOf(person);
    if (!KINDS.includes(input?.kind)) throw new Error('INVALID_SEAT_KIND: ' + String(input?.kind));
    const endpoint = opt(input.endpoint, 300, 'INVALID_ENDPOINT'), consentRef = opt(input.consentRef, 300, 'INVALID_CONSENT_REF');
    if (endpoint !== null && /\s/.test(endpoint)) throw new Error('INVALID_ENDPOINT');
    if (input.kind === 'remote_claude' && (!endpoint || !consentRef)) {
      throw new Error('REMOTE_NOT_CONSENTED: một phiên Claude từ xa của ' + person + ' cần cả endpoint và consent do owner ghi; thiếu ' + [!endpoint && 'endpoint', !consentRef && 'consent'].filter(Boolean).join(' và ') + '. Chưa có thì dùng vai giả lập (simulated_role)');
    }
    if (input.kind === 'simulated_role' && (endpoint || consentRef)) throw new Error('INVALID_SEAT: vai giả lập không mang endpoint hoặc consent, để khỏi bị hiểu là Claude thật');
    const role = opt(input.role, 60, 'INVALID_ROLE') ?? 'participant';
    const consumerId = opt(input.consumerId, 128, 'INVALID_CONSUMER');
    if (consumerId !== null && !ID_RE.test(consumerId)) throw new Error('INVALID_CONSUMER');
    const generation = input.generation === undefined ? 0 : input.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('INVALID_GENERATION');
    const at = this.now();
    return tx(this.db, () => {
      const prev = this.latestSeat(sid, key);
      // Owner-given text is carried over when this call does not repeat it; it is replaced only by new owner text.
      const roleDescription = input.roleDescription === undefined ? prev?.roleDescription ?? null : opt(input.roleDescription, 1000, 'INVALID_ROLE_DESCRIPTION');
      const scope = input.scope === undefined ? prev?.scope ?? null : opt(input.scope, 500, 'INVALID_SCOPE');
      // Compared whatever the consumer (Codex review of a3e1fb3): a zombie must not take the seat back by naming another consumer.
      if (prev && prev.generation > generation) throw new Error('STALE_GENERATION: phiên của ' + person + ' đã ở thế hệ ' + prev.generation + ', không nhận thế hệ ' + generation);
      if (prev && prev.kind === input.kind && prev.endpoint === endpoint && prev.consentRef === consentRef && prev.role === role && prev.consumerId === consumerId && prev.generation === generation && prev.roleDescription === roleDescription && prev.scope === scope) return prev;
      this.db.prepare('INSERT INTO cowork_seats(session_id,person,person_key,kind,endpoint,consent_ref,role,consumer_id,generation,role_description,scope,bound_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(sid, person, key, input.kind, endpoint, consentRef, role, consumerId, generation, roleDescription, scope, at);
      return this.latestSeat(sid, key)!;
    });
  }
  seatFor(sessionId: string, person: string): Seat | null { return this.latestSeat(sessionId, keyOf(String(person ?? ''))); }
  // The current seat of each person, by first appearance.
  seats(sessionId: string): Seat[] {
    return this.db.prepare('SELECT * FROM cowork_seats WHERE id IN (SELECT MAX(id) FROM cowork_seats WHERE session_id=? GROUP BY person_key) ORDER BY id').all(sessionId).map(seatOf);
  }
  // Honest report: each seat's kind, whether anything is verified (never), and everything the owner has not provided. `expect`
  // lists people the owner said take part: those without a seat are reported as missing 'seat:<name>'. Pass `pack` to also report
  // people missing from the roster.
  status(sessionId: string, opts: { pack?: ContextPack | null; expect?: readonly string[] } = {}): CoworkStatus {
    const seats = this.seats(sessionId).map(s => seatStatus(s, opts.pack));
    const missing = seats.flatMap(s => s.missing);
    const seated = new Set(seats.map(s => keyOf(s.person)));
    for (const raw of opts.expect ?? []) {
      const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
      if (name && !isUnknownName(name) && !seated.has(keyOf(name))) missing.push('seat:' + name);
    }
    return {
      sessionId, seats, simulated: seats.filter(s => s.simulated).length, remote: seats.filter(s => !s.simulated).length, liveRemote: 0,
      missing: [...new Set(missing)], note: 'Chưa có kết nối thật tới Claude của ai khác: vai giả lập chỉ là vai chạy trên máy này; phiên từ xa mới có endpoint + consent, chưa kiểm kết nối.',
    };
  }

  // ---- assignments ------------------------------------------------------------------------------------------------------
  // `fromDecisionId` (optional) must be a decided decision of this session; a proposal is not a reason to give someone a task.
  // `opts.dueAt` is epoch ms and only what the caller was told: no due date is ever invented (overdue needs one).
  assign(sessionId: string, person: string, assignText: string, sourceIds: readonly number[] = [], fromDecisionId?: number, opts: { dueAt?: number } = {}): number {
    const sid = text(sessionId, 100, 'INVALID_SESSION'), name = realPerson(person), key = keyOf(name), body = text(assignText, 2000, 'INVALID_ASSIGNMENT_TEXT'), src = ids(sourceIds), at = this.now();
    if (fromDecisionId !== undefined && (!Number.isSafeInteger(fromDecisionId) || fromDecisionId < 1)) throw new Error('INVALID_DECISION_REF');
    for (const k of Object.keys(opts ?? {})) if (k !== 'dueAt') throw new Error('INVALID_ASSIGN_OPTION: ' + k);
    const dueAt = opts?.dueAt;
    if (dueAt !== undefined && (!Number.isSafeInteger(dueAt) || dueAt < 1)) throw new Error('INVALID_DUE');
    return tx(this.db, () => {
      const seat = this.latestSeat(sid, key);
      if (!seat) throw new Error('NO_SEAT: ' + name + ' chưa có phiên trong buổi này (vai giả lập hoặc Claude từ xa do owner ghi), nên chưa giao việc qua đây');
      if (fromDecisionId !== undefined) {
        const d: any = this.db.prepare('SELECT session_id, status FROM decisions WHERE id=?').get(fromDecisionId);
        if (!d || d.session_id !== sid) throw new Error('DECISION_NOT_FOUND: QĐ' + fromDecisionId);
        if (d.status !== 'decided') throw new Error('DECISION_NOT_DECIDED: QĐ' + fromDecisionId + ' đang ở trạng thái ' + d.status + ', chưa có người có thẩm quyền chốt');
      }
      const dup: any = this.db.prepare("SELECT id FROM cowork_assignments WHERE session_id=? AND person_key=? AND text=? AND COALESCE(from_decision_id,0)=? AND status IN ('open','accepted','answered') ORDER BY id").get(sid, key, body, fromDecisionId ?? 0);
      if (dup) return Number(dup.id);
      return Number(this.db.prepare("INSERT INTO cowork_assignments(session_id,person,person_key,text,source_ids,from_decision_id,status,due_at,seat_kind,created,updated) VALUES(?,?,?,?,?,?,'open',?,?,?,?)").run(sid, seat.person, key, body, JSON.stringify(src), fromDecisionId ?? null, dueAt ?? null, seat.kind, at, at).lastInsertRowid);
    });
  }
  get(id: number): Assignment | null { const r = this.db.prepare('SELECT * FROM cowork_assignments WHERE id=?').get(id); return r ? assignmentOf(r) : null; }
  assignments(sessionId: string, opts: { person?: string; status?: AssignmentStatus } = {}): Assignment[] {
    const where = ['session_id=?'], args: (string | number)[] = [sessionId];
    if (opts.person !== undefined) { where.push('person_key=?'); args.push(keyOf(opts.person)); }
    if (opts.status) { where.push('status=?'); args.push(opts.status); }
    return this.db.prepare('SELECT * FROM cowork_assignments WHERE ' + where.join(' AND ') + ' ORDER BY id').all(...args).map(assignmentOf);
  }
  replies(sessionId: string, opts: { assignmentId?: number } = {}): Reply[] {
    const rows = opts.assignmentId !== undefined ? this.db.prepare('SELECT * FROM cowork_replies WHERE session_id=? AND assignment_id=? ORDER BY id').all(sessionId, opts.assignmentId) : this.db.prepare('SELECT * FROM cowork_replies WHERE session_id=? ORDER BY id').all(sessionId);
    return rows.map(replyOf);
  }

  // true when this call moved it to accepted; the same call again is a no-op (false).
  accept(id: number, person: string, from: Caller = {}): boolean {
    const at = this.now();
    return tx(this.db, () => {
      const a = this.assignmentRow(id); this.authorize(a, person, from);
      if (a.status === 'accepted') return false;
      if (a.status !== 'open') throw new Error('ASSIGNMENT_CLOSED: việc #' + id + ' đang ở trạng thái ' + a.status);
      this.db.prepare("UPDATE cowork_assignments SET status='accepted', updated=? WHERE id=?").run(at, id);
      return true;
    });
  }
  // Declining is the assignee's answer "not me / not now"; it goes to the central session. The seat kind at that moment is kept.
  decline(id: number, person: string, reason: string, from: Caller = {}): boolean {
    const why = text(reason, 1000, 'INVALID_DECLINE_REASON'), at = this.now();
    return tx(this.db, () => {
      const a = this.assignmentRow(id), seat = this.authorize(a, person, from);
      if (a.status === 'declined') return false;
      if (a.status !== 'open' && a.status !== 'accepted') throw new Error('ASSIGNMENT_CLOSED: việc #' + id + ' đang ở trạng thái ' + a.status);
      this.db.prepare("UPDATE cowork_assignments SET status='declined', note=?, seat_kind=?, updated=? WHERE id=?").run(why, seat.kind, at, id);
      return true;
    });
  }
  // A reply is the assignee's words, stamped with the seat kind (a simulated role is marked simulated). It NEVER decides:
  // the result says decided:false, and when `opts.propose` is given it carries the arguments for DecisionLedger.propose. Nothing
  // reaches the decision ledger from here; the central session calls propose/decide, and `linkProposal` records the link.
  reply(id: number, person: string, replyText: string, sourceIds: readonly number[] = [], opts: ReplyOptions = {}): ReplyResult {
    const body = text(replyText, 4000, 'INVALID_REPLY_TEXT'), src = ids(sourceIds), at = this.now();
    for (const k of Object.keys(opts ?? {})) if (!REPLY_KEYS.includes(k)) throw new Error('INVALID_REPLY_OPTION: ' + k + ' (một câu trả lời không chốt gì; chỉ đề xuất qua propose)');
    const proposal = opts.propose === undefined ? null : text(opts.propose, 2000, 'INVALID_PROPOSAL');
    return tx(this.db, () => {
      const a = this.assignmentRow(id), seat = this.authorize(a, person, opts);
      if (a.status === 'declined') throw new Error('ASSIGNMENT_CLOSED: việc #' + id + ' đã bị từ chối');
      if (!opts.context && this.opts.requireContext) throw new Error('CONTEXT_REQUIRED: trả lời phải kèm context của host (phiên này đã đọc bản context hiện tại chưa)');
      if (opts.context) {
        const r = readiness({ pack: opts.context.pack, sessionId: a.session_id, asrListening: true, bindings: opts.context.bindings, role: seat.role, consumerId: seat.consumerId ?? opts.consumerId ?? a.person_key, generation: opts.generation });
        if (!(r.state === 'READY' || (r.state === 'DEGRADED' && r.reasons.every(x => x.startsWith('MISSING:'))))) throw new Error('CONTEXT_NOT_CURRENT: ' + r.state + ' ' + r.reasons.join(','));
      }
      const simulated = seat.kind === 'simulated_role';
      const replyId = Number(this.db.prepare('INSERT INTO cowork_replies(assignment_id,session_id,person,text,source_ids,proposal,seat_kind,simulated,created) VALUES(?,?,?,?,?,?,?,?,?)').run(id, a.session_id, seat.person, body, JSON.stringify(src), proposal, seat.kind, simulated ? 1 : 0, at).lastInsertRowid);
      this.db.prepare("UPDATE cowork_assignments SET status='answered', seat_kind=?, updated=? WHERE id=?").run(seat.kind, at, id);
      const out: ReplyResult = { id: replyId, assignmentId: id, seatKind: seat.kind, simulated, decided: false };
      if (proposal) out.proposal = { sessionId: a.session_id, text: proposal, sourceIds: src, provenance: { who: seat.person, seatKind: seat.kind, simulated, sourceIds: src, at } };
      return out;
    });
  }
  // The central session turned a reply's proposal into a decision-ledger row (DecisionLedger.propose returned `decisionId`).
  // From here DecisionLedger tracks it, so it leaves the convergence list. true when newly linked; the same link again is false.
  linkProposal(replyId: number, decisionId: number): boolean {
    return tx(this.db, () => {
      const r: any = this.db.prepare('SELECT * FROM cowork_replies WHERE id=?').get(replyId);
      if (!r) throw new Error('REPLY_NOT_FOUND: ' + replyId);
      if (!r.proposal) throw new Error('NOT_A_PROPOSAL: câu trả lời #' + replyId + ' không có đề xuất');
      const d: any = Number.isSafeInteger(decisionId) ? this.db.prepare('SELECT session_id FROM decisions WHERE id=?').get(decisionId) : undefined;
      if (!d || d.session_id !== r.session_id) throw new Error('DECISION_NOT_FOUND: QĐ' + decisionId);
      if (r.decision_id === decisionId) return false;
      if (r.decision_id !== null) throw new Error('PROPOSAL_ALREADY_LINKED: QĐ' + r.decision_id);
      this.db.prepare('UPDATE cowork_replies SET decision_id=? WHERE id=?').run(decisionId, replyId);
      return true;
    });
  }
  // Who proposed a decision-ledger row that came from a reply (so a simulated proposal is never mistaken for a real person's).
  provenanceOfDecision(decisionId: number): (Provenance & { replyId: number }) | null {
    const r: any = this.db.prepare('SELECT * FROM cowork_replies WHERE decision_id=? ORDER BY id LIMIT 1').get(decisionId);
    return r ? { replyId: r.id, who: r.person, seatKind: r.seat_kind, simulated: !!r.simulated, sourceIds: parseIds(r.source_ids), at: r.created } : null;
  }

  // ---- marks: "for these people only" ----------------------------------------------------------------------------------
  // A decision, action or assignment marked for some people is hidden from everyone else's role view; a question marked for a
  // person is that person's (addressed to them). Returns how many marks were newly added.
  mark(sessionId: string, refKind: MarkKind, refId: number, persons: readonly string[]): number {
    const sid = text(sessionId, 100, 'INVALID_SESSION'), at = this.now();
    if (!MARK_KINDS.includes(refKind)) throw new Error('INVALID_MARK_KIND: ' + String(refKind));
    if (!Number.isSafeInteger(refId) || refId < 1) throw new Error('INVALID_REF');
    if (!Array.isArray(persons) || !persons.length) throw new Error('INVALID_PERSON');
    const names = persons.map(realPerson);
    return tx(this.db, () => names.reduce((n, name) => n + Number(this.db.prepare('INSERT OR IGNORE INTO cowork_marks(session_id,ref_kind,ref_id,person_key,person,created) VALUES(?,?,?,?,?,?)').run(sid, refKind, refId, keyOf(name), name, at).changes), 0));
  }
  marks(sessionId: string): Mark[] {
    const out = new Map<string, Mark>();
    for (const r of this.db.prepare('SELECT * FROM cowork_marks WHERE session_id=? ORDER BY created, ref_kind, ref_id, person_key').all(sessionId) as any[]) {
      const k = r.ref_kind + ':' + r.ref_id, m = out.get(k) ?? { refKind: r.ref_kind as MarkKind, refId: r.ref_id as number, persons: [] };
      m.persons.push(r.person); out.set(k, m);
    }
    return [...out.values()];
  }
  // The role view for one person with this ledger's seat, marks and assignments filled in. Decisions, actions and questions come
  // from the caller (DecisionLedger.list / .actions, QuestionBoard.parked / .open), grants from DecisionLedger.grants.
  view(pack: ContextPack | null | undefined, person: string, grants: readonly Grant[], data: { decisions?: readonly Decision[]; actions?: readonly Action[]; questions?: readonly OwnerQuestion[] } = {}): RoleView {
    const sid = pack?.meeting.sessionId;
    return roleView(pack, person, grants, {
      ...data, seat: sid ? this.seatFor(sid, person) : null,
      assignments: sid ? this.assignments(sid) : [], marks: sid ? this.marks(sid) : [],
    });
  }

  // ---- convergence into the central session --------------------------------------------------------------------------
  // What Dũng's session must handle, oldest first: replies that propose a decision (and are not yet in DecisionLedger),
  // assignments declined or overdue (due date given by the caller, no reply yet), and owner questions parked for an authority.
  // Each carries who / seat kind / source ids / time. Items the central session recorded as handled (`handle`) drop out.
  convergeToCentral(sessionId: string): CentralItem[] {
    const now = this.now(), items: CentralItem[] = [];
    const handled = (kind: HandledKind, id: number) => !!this.db.prepare('SELECT 1 FROM cowork_handled WHERE ref_kind=? AND ref_id=?').get(kind, id);
    const marks = this.marks(sessionId), addressed = (id: number) => marks.find(m => m.refKind === 'question' && m.refId === id)?.persons ?? [];

    for (const r of this.db.prepare('SELECT * FROM cowork_replies WHERE session_id=? AND proposal IS NOT NULL AND decision_id IS NULL ORDER BY id').all(sessionId).map(replyOf)) {
      if (handled('reply', r.id)) continue;
      const provenance: Provenance = { who: r.person, seatKind: r.seatKind, simulated: r.simulated, sourceIds: r.sourceIds, at: r.created };
      items.push({
        kind: 'proposal', refKind: 'reply', refId: r.id, assignmentId: r.assignmentId, person: r.person, addressedTo: [], text: r.proposal!, detail: r.text, provenance,
        proposal: { sessionId, text: r.proposal!, sourceIds: r.sourceIds, provenance },
        needs: 'Đây mới là đề xuất' + (r.simulated ? ' của một vai giả lập' : '') + ', chưa phải quyết định: đưa vào DecisionLedger.propose rồi để người được owner giao thẩm quyền chốt, hoặc hỏi owner',
      });
    }
    for (const a of this.assignments(sessionId, { status: 'declined' })) {
      if (handled('assignment', a.id)) continue;
      items.push({
        kind: 'declined', refKind: 'assignment', refId: a.id, assignmentId: a.id, person: a.person, addressedTo: [], text: a.text, detail: a.note,
        provenance: { who: a.person, seatKind: a.seatKind, simulated: a.seatKind === 'simulated_role', sourceIds: a.sourceIds, at: a.updated },
        needs: a.person + ' từ chối việc này: giao lại cho người khác hoặc hỏi owner (không tự gán)',
      });
    }
    for (const a of [...this.assignments(sessionId, { status: 'open' }), ...this.assignments(sessionId, { status: 'accepted' })]) {
      if (a.dueAt === null || a.dueAt >= now || handled('assignment', a.id)) continue;
      items.push({
        kind: 'overdue', refKind: 'assignment', refId: a.id, assignmentId: a.id, person: a.person, addressedTo: [], text: a.text, detail: a.status === 'open' ? 'chưa nhận, chưa trả lời' : 'đã nhận, chưa trả lời',
        provenance: { who: a.person, seatKind: a.seatKind, simulated: a.seatKind === 'simulated_role', sourceIds: a.sourceIds, at: a.dueAt },
        needs: 'Quá hạn mà ' + a.person + ' chưa trả lời: nhắc, giao lại hoặc hỏi owner',
      });
    }
    for (const q of this.db.prepare("SELECT * FROM owner_questions WHERE session_id=? AND status='parked' ORDER BY id").all(sessionId).map(questionOf)) {
      if (handled('question', q.id)) continue;
      items.push({
        kind: 'parked_question', refKind: 'question', refId: q.id, assignmentId: null, person: null, addressedTo: addressed(q.id), text: q.text, detail: null,
        provenance: { who: null, seatKind: null, simulated: false, sourceIds: q.sourceIds, at: q.closed ?? q.asked },
        needs: 'Câu hỏi chưa ai trả lời: cần người có thẩm quyền do owner giao, hoặc chính owner',
      });
    }
    return items.sort((x, y) => x.provenance.at - y.provenance.at || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.refId - y.refId);
  }
  // The central session has dealt with an item (it recorded it, answered it, reassigned it). Only moves it out of the list; the
  // row, the reply and the history stay. true when newly recorded.
  handle(refKind: HandledKind, refId: number, by: string, note: string): boolean {
    if (!HANDLED_KINDS.includes(refKind)) throw new Error('INVALID_REF_KIND: ' + String(refKind));
    const who = text(by, 120, 'INVALID_PERSON'), n = text(note, 1000, 'INVALID_NOTE'), at = this.now();
    return tx(this.db, () => {
      const table = refKind === 'reply' ? 'cowork_replies' : refKind === 'assignment' ? 'cowork_assignments' : 'owner_questions';
      const row: any = Number.isSafeInteger(refId) ? this.db.prepare('SELECT session_id FROM ' + table + ' WHERE id=?').get(refId) : undefined;
      if (!row) throw new Error('REF_NOT_FOUND: ' + refKind + ' #' + refId);
      return this.db.prepare('INSERT OR IGNORE INTO cowork_handled(ref_kind,ref_id,session_id,by,note,at) VALUES(?,?,?,?,?,?)').run(refKind, refId, row.session_id, who, n, at).changes > 0;
    });
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------
  private latestSeat(sessionId: string, personKey: string): Seat | null {
    const r = this.db.prepare('SELECT * FROM cowork_seats WHERE session_id=? AND person_key=? ORDER BY id DESC LIMIT 1').get(sessionId, personKey);
    return r ? seatOf(r) : null;
  }
  private assignmentRow(id: number): any {
    const r = Number.isSafeInteger(id) ? this.db.prepare('SELECT * FROM cowork_assignments WHERE id=?').get(id) : undefined;
    if (!r) throw new Error('ASSIGNMENT_NOT_FOUND: ' + String(id));
    return r;
  }
  // "Only the assignee's seat may answer": the person must be the assignee (by name, nothing else is consulted), must have a seat,
  // and the caller must be the consumer and generation that seat is bound to.
  private authorize(a: any, person: string, from: Caller): Seat {
    const name = realPerson(person);
    if (keyOf(name) !== a.person_key) throw new Error('NOT_ASSIGNEE: việc #' + a.id + ' giao cho ' + a.person + ', không phải ' + name);
    const seat = this.latestSeat(a.session_id, a.person_key);
    if (!seat) throw new Error('NO_SEAT: ' + a.person + ' không còn phiên trong buổi này');
    const caller = from ?? {};
    if (seat.consumerId !== null) {
      if (caller.consumerId !== seat.consumerId) throw new Error('WRONG_CONSUMER: phiên của ' + seat.person + ' gắn với một consumer khác');
      if (caller.generation === undefined) throw new Error('GENERATION_REQUIRED: phiên của ' + seat.person + ' gắn với consumer, cần nêu thế hệ');
    }
    if (caller.generation !== undefined) {
      if (!Number.isSafeInteger(caller.generation) || caller.generation < 0) throw new Error('INVALID_GENERATION');
      if (caller.generation < seat.generation) throw new Error('STALE_GENERATION: thế hệ ' + caller.generation + ' đã cũ, phiên đang ở thế hệ ' + seat.generation);
      if (caller.generation > seat.generation) throw new Error('NOT_BOUND: thế hệ ' + caller.generation + ' chưa được gắn lại cho phiên của ' + seat.person);
    }
    return seat;
  }
}
