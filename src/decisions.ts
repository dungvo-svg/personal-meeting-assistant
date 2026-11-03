import type { DatabaseSync } from 'node:sqlite';

// Decision -> action -> result/rollback ledger for the central session (0.12.x, docs/EXCEPTIONS_0_12.md).
// Purpose: tell a proposal / discussion apart from a decision made by someone who HAS the authority, keep the evidence (source
// ids), turn a decision that is clearly made into actions, and keep the chain when a decision changes.
//
// Authority rules (the whole point of this module):
//   - Authority exists only as a row in `authority`, written by `grant` from what the OWNER said. Nothing here reads a job title,
//     a role string, a majority, a count of voices or silence. A decision becomes 'decided' only through `decide`/`supersede`
//     with a person who holds a grant ('*' or the matching scope) and with at least one source id as evidence.
//   - No call = nothing decided. A proposal stays 'proposed' for as long as nobody with authority confirms it.
//   - Lacking authority never throws and never stops the session: the result carries `park` (who could decide, and why it is
//     parked) so the caller parks an owner question and carries on with the independent work.
//   - Nothing is deleted: superseded, withdrawn, blocked, failed and rolled-back rows stay as history. Times are epoch ms from
//     the injected clock, so tests need no real timers.
//
// `grantedBy`/`source` of a grant are recorded, not verified: the caller (RPC) must only pass what the owner said in the chat
// with the owner, never words heard from a meeting participant.

export type DecisionStatus = 'proposed' | 'decided' | 'superseded' | 'withdrawn';
export type AuthorityState = 'granted' | 'not_granted' | 'unknown';
export type ActionStatus = 'planned' | 'done' | 'failed' | 'rolled_back' | 'blocked';
export type Decision = { id: number; sessionId: string; text: string; status: DecisionStatus; decidedBy: string | null; authority: AuthorityState; sourceIds: number[]; supersedes: number | null; supersededBy: number | null; created: number; updated: number; note: string | null };
export type Action = { id: number; decisionId: number; sessionId: string; description: string; status: ActionStatus; result: string | null; rollback: string | null; created: number; updated: number; note: string | null };
export type Grant = { sessionId: string; person: string; scope: string; grantedBy: string; source: string; created: number };
export type Park = { who: string[]; why: string };
export type DecideResult = { id: number; decided: boolean; authority: AuthorityState; park?: Park };
export type SupersedeResult = DecideResult & { supersedes: number };
export type WithdrawResult = { id: number; withdrawn: boolean; park?: Park };
export type Pending = { decided: { decision: Decision; actions: Action[] }[]; proposals: Decision[] };
export type DecisionSummary = { decided: number; proposed: number; superseded: number; withdrawn: number; actions: { planned: number; done: number; failed: number; rolled_back: number; blocked: number } };

const ANY = '*';
const STATUSES: readonly string[] = ['proposed', 'decided', 'superseded', 'withdrawn'];

export const DECISIONS_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, authority TEXT NOT NULL DEFAULT 'unknown', source_ids TEXT NOT NULL DEFAULT '[]', supersedes INTEGER, superseded_by INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, note TEXT);
  CREATE INDEX IF NOT EXISTS decisions_by_session ON decisions(session_id, status);
  CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id INTEGER NOT NULL, session_id TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, result TEXT, rollback TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, note TEXT);
  CREATE INDEX IF NOT EXISTS actions_by_decision ON actions(decision_id, status);
  CREATE INDEX IF NOT EXISTS actions_by_session ON actions(session_id, status);
  CREATE TABLE IF NOT EXISTS authority(session_id TEXT NOT NULL, person TEXT NOT NULL, scope TEXT NOT NULL, granted_by TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(session_id, person, scope));`;

type Clock = () => number;

// Source ids are provenance: only real positive integers, sorted and unique (same rule as jobs.ts).
function ids(sourceIds: readonly number[] | undefined): number[] {
  const list = sourceIds ?? [];
  if (!Array.isArray(list) || list.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('INVALID_SOURCE_IDS');
  return [...new Set(list)].sort((a, b) => a - b);
}
const parseIds = (raw: unknown): number[] => { try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.filter(Number.isSafeInteger) : []; } catch { return []; } };
const union = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
const text = (value: unknown, max: number, code: string) => { const s = String(value ?? '').normalize('NFC').trim(); if (!s || s.length > max) throw new Error(code); return s; };
const same = (a: string, b: string) => a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();
const joinNote = (prev: unknown, add: string) => [prev ? String(prev) : '', add].filter(Boolean).join(' | ').slice(-1000);
const src = (s: number[]) => (s.length ? ' (nguồn ' + s.map(n => '#' + n).join(', ') + ')' : '');

const decisionOf = (r: any): Decision => ({ id: r.id, sessionId: r.session_id, text: r.text, status: r.status, decidedBy: r.decided_by ?? null, authority: r.authority, sourceIds: parseIds(r.source_ids), supersedes: r.supersedes ?? null, supersededBy: r.superseded_by ?? null, created: r.created, updated: r.updated, note: r.note ?? null });
const actionOf = (r: any): Action => ({ id: r.id, decisionId: r.decision_id, sessionId: r.session_id, description: r.description, status: r.status, result: r.result ?? null, rollback: r.rollback ?? null, created: r.created, updated: r.updated, note: r.note ?? null });
const grantOf = (r: any): Grant => ({ sessionId: r.session_id, person: r.person, scope: r.scope, grantedBy: r.granted_by, source: r.source, created: r.created });

// Small write transactions; join the caller's transaction if one is already open (same as jobs.ts).
function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class DecisionLedger {
  constructor(private db: DatabaseSync, private now: Clock = Date.now) { db.exec(DECISIONS_TABLES_SQL); }

  // ---- authority: only what the owner gave ------------------------------------------------------------------------------
  // True when this call recorded a new grant. The same (person, scope) again keeps the first record (who gave it, when).
  grant(sessionId: string, person: string, scope: string, grantedBy: string, source: string): boolean {
    const p = text(person, 120, 'INVALID_PERSON'), s = text(scope, 120, 'INVALID_SCOPE'), by = text(grantedBy, 120, 'INVALID_GRANTED_BY'), why = text(source, 500, 'INVALID_GRANT_SOURCE'), at = this.now();
    return tx(this.db, () => this.db.prepare('INSERT OR IGNORE INTO authority(session_id,person,scope,granted_by,source,created) VALUES(?,?,?,?,?,?)').run(sessionId, p, s, by, why, at).changes > 0);
  }
  grants(sessionId: string): Grant[] { return this.db.prepare('SELECT * FROM authority WHERE session_id=? ORDER BY created, person, scope').all(sessionId).map(grantOf); }
  // Does this person hold authority for `scope`? A grant on '*' covers everything; a topic grant covers only that topic, and
  // only when the caller names the topic. Names compare case-insensitively; nothing else (title, role, text) is consulted.
  canDecide(sessionId: string, person: string, scope?: string): boolean { return this.check(sessionId, person, scope).state === 'granted'; }

  // ---- decisions ----------------------------------------------------------------------------------------------------------
  // A proposal or a point under discussion. It is never 'decided' by being said, repeated, agreed to by many, or left unanswered.
  propose(sessionId: string, decisionText: string, sourceIds: readonly number[] = []): number {
    const t = text(decisionText, 2000, 'INVALID_DECISION_TEXT'), src = ids(sourceIds), at = this.now();
    return tx(this.db, () => Number(this.db.prepare("INSERT INTO decisions(session_id,text,status,authority,source_ids,created,updated) VALUES(?,?,'proposed','unknown',?,?,?)").run(sessionId, t, JSON.stringify(src), at, at).lastInsertRowid));
  }
  // `by` made the decision, with `sourceIds` as the evidence. Becomes 'decided' only when `by` has authority (opts.scope = the
  // topic, when the owner's grant is per topic). Otherwise it stays 'proposed' and `park` says who could confirm it.
  // Deciding something already decided is a no-op (a re-sent call must not change the record).
  decide(id: number, by: string, sourceIds: readonly number[], opts: { scope?: string } = {}): DecideResult {
    const who = text(by, 120, 'INVALID_PERSON'), evidence = ids(sourceIds), scope = this.scopeOf(opts);
    if (!evidence.length) throw new Error('EVIDENCE_REQUIRED: chốt một quyết định cần ít nhất một nguồn (#id)');
    const at = this.now();
    return tx(this.db, () => {
      const row = this.row(id);
      if (row.status === 'decided') return { id, decided: true, authority: 'granted' as AuthorityState };
      if (row.status !== 'proposed') throw new Error('DECISION_CLOSED: QĐ' + id + ' đang ở trạng thái ' + row.status);
      return this.settle(row, who, evidence, scope, at);
    });
  }
  // The decision changes. The new text is recorded linked to the old one. If `by` has authority: the new one is 'decided', the
  // old one 'superseded' (superseded_by set) and the old one's planned actions become 'blocked' for review (never silently
  // kept; done ones stay done and are listed for review in the report). If `by` has no authority: the new text is only a
  // 'proposed' replacement, the old decision stays in force (a proposal cannot cancel a decision), and the replacement waits
  // for someone with authority; `decide(newId, ...)` then completes the supersession. Re-sending the same text is a no-op.
  supersede(oldId: number, newText: string, by: string, sourceIds: readonly number[], opts: { scope?: string } = {}): SupersedeResult {
    const t = text(newText, 2000, 'INVALID_DECISION_TEXT'), who = text(by, 120, 'INVALID_PERSON'), evidence = ids(sourceIds), scope = this.scopeOf(opts);
    if (!evidence.length) throw new Error('EVIDENCE_REQUIRED: đổi một quyết định cần ít nhất một nguồn (#id)');
    const at = this.now();
    return tx(this.db, () => {
      const old = this.row(oldId);
      const prior = this.db.prepare("SELECT * FROM decisions WHERE supersedes=? AND text=? AND status IN ('proposed','decided') ORDER BY id").get(oldId, t) as any;
      if (prior) {
        const result = prior.status === 'decided' ? { id: prior.id, decided: true, authority: 'granted' as AuthorityState } : this.settle(prior, who, evidence, scope, at);
        return { ...result, supersedes: oldId };
      }
      if (old.status !== 'decided' && old.status !== 'proposed') throw new Error('DECISION_CLOSED: QĐ' + oldId + ' đang ở trạng thái ' + old.status);
      const newId = Number(this.db.prepare("INSERT INTO decisions(session_id,text,status,authority,source_ids,supersedes,created,updated) VALUES(?,?,'proposed','unknown',?,?,?,?)").run(old.session_id, t, JSON.stringify(evidence), oldId, at, at).lastInsertRowid);
      const result = this.settle(this.row(newId), who, evidence, scope, at);
      if (!result.decided) this.db.prepare('UPDATE decisions SET note=?, updated=? WHERE id=?').run(joinNote(old.note, 'Có đề xuất thay thế QĐ' + newId + ' đang chờ người có thẩm quyền; quyết định này vẫn còn hiệu lực'), at, oldId);
      return { ...result, supersedes: oldId };
    });
  }
  // Take a decision back. A proposal can be withdrawn by anyone; a decided one only by someone with authority (otherwise
  // `park`, it stays decided). Planned actions of a withdrawn decision become 'blocked' for review.
  withdraw(id: number, by: string, note: string, opts: { scope?: string } = {}): WithdrawResult {
    const who = text(by, 120, 'INVALID_PERSON'), n = text(note, 1000, 'INVALID_NOTE'), scope = this.scopeOf(opts), at = this.now();
    return tx(this.db, () => {
      const row = this.row(id);
      if (row.status === 'withdrawn') return { id, withdrawn: true };
      if (row.status === 'superseded') throw new Error('DECISION_CLOSED: QĐ' + id + ' đã bị thay thế');
      if (row.status === 'decided') {
        const auth = this.check(row.session_id, who, scope);
        if (auth.state !== 'granted') return { id, withdrawn: false, park: this.park(auth, who, scope, 'rút') };
      }
      this.db.prepare("UPDATE decisions SET status='withdrawn', note=?, updated=? WHERE id=?").run(joinNote(row.note, 'Rút bởi ' + who + ': ' + n), at, id);
      this.block(id, 'Quyết định QĐ' + id + ' đã bị rút: xem xét lại việc này', at);
      return { id, withdrawn: true };
    });
  }

  // ---- actions: only for a decided decision ---------------------------------------------------------------------------------
  // Same description again while it is still planned returns the same action (a re-sent call makes no duplicate).
  plan(decisionId: number, description: string): number {
    const d = text(description, 1000, 'INVALID_ACTION_DESCRIPTION'), at = this.now();
    return tx(this.db, () => {
      const row = this.row(decisionId);
      if (row.status !== 'decided') throw new Error('DECISION_NOT_DECIDED: QĐ' + decisionId + ' đang ở trạng thái ' + row.status + ', chưa có người có thẩm quyền chốt nên chưa tạo việc');
      const dup = this.db.prepare("SELECT id FROM actions WHERE decision_id=? AND description=? AND status='planned'").get(decisionId, d) as any;
      if (dup) return Number(dup.id);
      return Number(this.db.prepare("INSERT INTO actions(decision_id,session_id,description,status,created,updated) VALUES(?,?,?,'planned',?,?)").run(decisionId, row.session_id, d, at, at).lastInsertRowid);
    });
  }
  // True when this call recorded the result. The same result again is a no-op; a different result for an action already done
  // is refused so the first record stays. A 'blocked' action may still be reported done (it happened before the block was
  // seen); it stays visible in the report as belonging to a decision that needs review.
  done(actionId: number, result: string): boolean {
    const r = text(result, 20_000, 'INVALID_ACTION_RESULT'), at = this.now();
    return tx(this.db, () => {
      const a = this.actionRow(actionId);
      if (a.status === 'done' && a.result === r) return false;
      if (a.status !== 'planned' && a.status !== 'blocked' && a.status !== 'failed') throw new Error('ACTION_NOT_OPEN: V' + actionId + ' đang ở trạng thái ' + a.status);
      this.db.prepare("UPDATE actions SET status='done', result=?, updated=? WHERE id=?").run(r, at, actionId);
      return true;
    });
  }
  // Only an open action (planned/blocked) can fail; a late failure on a closed action changes nothing (returns false).
  fail(actionId: number, note: string): boolean {
    const n = text(note, 1000, 'INVALID_ACTION_NOTE'), at = this.now();
    return tx(this.db, () => {
      const a = this.actionRow(actionId);
      if (a.status === 'done' || a.status === 'rolled_back') throw new Error('ACTION_NOT_OPEN: V' + actionId + ' đang ở trạng thái ' + a.status);
      if (a.status === 'failed') return false;
      this.db.prepare("UPDATE actions SET status='failed', note=?, updated=? WHERE id=?").run(joinNote(a.note, n), at, actionId);
      return true;
    });
  }
  // `how` records how it was undone. Only an action that was done (or failed half-way) can be rolled back. The same `how`
  // again is a no-op; a different one is refused so the first record stays.
  rollback(actionId: number, how: string): boolean {
    const h = text(how, 20_000, 'INVALID_ROLLBACK'), at = this.now();
    return tx(this.db, () => {
      const a = this.actionRow(actionId);
      if (a.status === 'rolled_back' && a.rollback === h) return false;
      if (a.status !== 'done' && a.status !== 'failed') throw new Error('ACTION_NOT_DONE: V' + actionId + ' đang ở trạng thái ' + a.status + ', không có gì để hoàn tác');
      this.db.prepare("UPDATE actions SET status='rolled_back', rollback=?, updated=? WHERE id=?").run(h, at, actionId);
      return true;
    });
  }

  // ---- reading --------------------------------------------------------------------------------------------------------------
  get(id: number): Decision | null { const r = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id); return r ? decisionOf(r) : null; }
  getAction(id: number): Action | null { const r = this.db.prepare('SELECT * FROM actions WHERE id=?').get(id); return r ? actionOf(r) : null; }
  list(sessionId: string, opts: { status?: DecisionStatus } = {}): Decision[] {
    if (opts.status && !STATUSES.includes(opts.status)) throw new Error('INVALID_DECISION_STATUS: ' + opts.status);
    const rows = opts.status ? this.db.prepare('SELECT * FROM decisions WHERE session_id=? AND status=? ORDER BY id').all(sessionId, opts.status) : this.db.prepare('SELECT * FROM decisions WHERE session_id=? ORDER BY id').all(sessionId);
    return rows.map(decisionOf);
  }
  actions(sessionId: string, opts: { decisionId?: number; status?: ActionStatus } = {}): Action[] {
    const where = ['session_id=?'], args: (string | number)[] = [sessionId];
    if (opts.decisionId !== undefined) { where.push('decision_id=?'); args.push(opts.decisionId); }
    if (opts.status) { where.push('status=?'); args.push(opts.status); }
    return this.db.prepare('SELECT * FROM actions WHERE ' + where.join(' AND ') + ' ORDER BY id').all(...args).map(actionOf);
  }
  // The supersession chain this decision belongs to, oldest first. Follows `supersedes` back to the root, then `superseded_by`
  // forward to the current one; replacement proposals still waiting for authority are listed last.
  chain(id: number): Decision[] {
    let cur = this.get(id);
    if (!cur) return [];
    // Each walk has its own cycle guard: the forward walk must pass again over the nodes the backward walk visited (review of
    // 8822601: chain(latest) returned only the root because both walks shared one set).
    const back = new Set<number>([cur.id]);
    while (cur.supersedes != null && !back.has(cur.supersedes)) { const prev = this.get(cur.supersedes); if (!prev) break; back.add(prev.id); cur = prev; }
    const seen = new Set<number>([cur.id]);
    const out: Decision[] = [cur];
    while (cur.supersededBy != null && !seen.has(cur.supersededBy)) { const next = this.get(cur.supersededBy); if (!next) break; seen.add(next.id); out.push(next); cur = next; }
    const waiting = this.db.prepare("SELECT * FROM decisions WHERE supersedes=? AND status='proposed' ORDER BY id").all(cur.id).map(decisionOf).filter(d => !seen.has(d.id));
    return [...out, ...waiting];
  }
  // What is still open: decided decisions with no action yet or with an action not finished (planned/blocked/failed), and every
  // proposal (each one waits for someone with authority).
  pending(sessionId: string): Pending {
    const all = this.actions(sessionId), byDecision = new Map<number, Action[]>();
    for (const a of all) byDecision.set(a.decisionId, [...(byDecision.get(a.decisionId) ?? []), a]);
    const decided = this.list(sessionId, { status: 'decided' }).map(decision => ({ decision, actions: byDecision.get(decision.id) ?? [] }))
      .filter(({ actions }) => actions.length === 0 || actions.some(a => a.status === 'planned' || a.status === 'blocked' || a.status === 'failed'));
    return { decided, proposals: this.list(sessionId, { status: 'proposed' }) };
  }
  summaryOf(sessionId: string): DecisionSummary {
    const count = (table: string, status: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=? AND status=?`).get(sessionId, status) as any).n);
    return {
      decided: count('decisions', 'decided'), proposed: count('decisions', 'proposed'), superseded: count('decisions', 'superseded'), withdrawn: count('decisions', 'withdrawn'),
      actions: { planned: count('actions', 'planned'), done: count('actions', 'done'), failed: count('actions', 'failed'), rolled_back: count('actions', 'rolled_back'), blocked: count('actions', 'blocked') },
    };
  }
  // SUMMARY lines (Vietnamese), grouped; an empty group is left out. Decisions are "QĐ<n>", actions "V<n>", sources "#<id>".
  reportLines(sessionId: string): string[] {
    const decisions = this.list(sessionId), byId = new Map(decisions.map(d => [d.id, d] as const)), actions = this.actions(sessionId);
    const holders = this.grants(sessionId);
    const lines: string[] = [];
    const group = (title: string, items: string[]) => { if (items.length) lines.push(title, ...items); };
    group('Đã chốt:', decisions.filter(d => d.status === 'decided').map(d => '- QĐ' + d.id + ' ' + d.text + ' — ' + (d.decidedBy ?? '?') + ' chốt' + (d.supersedes != null ? ', thay QĐ' + d.supersedes : '') + src(d.sourceIds)));
    group('Đề xuất chờ người có thẩm quyền:', decisions.filter(d => d.status === 'proposed').map(d => {
      const who = [...new Set(holders.map(g => g.person + (g.scope === ANY ? '' : ' (' + g.scope + ')')))];
      const wait = who.length ? 'chờ ' + who.join(', ') + ' chốt' : 'chưa ai được owner giao thẩm quyền, cần hỏi owner';
      return '- QĐ' + d.id + ' ' + d.text + ' — ' + wait + (d.supersedes != null ? '; đề xuất thay QĐ' + d.supersedes + ' (QĐ đó vẫn còn hiệu lực)' : '') + src(d.sourceIds);
    }));
    group('Đã bị thay thế hoặc rút:', decisions.filter(d => d.status === 'superseded' || d.status === 'withdrawn').map(d => '- QĐ' + d.id + ' ' + d.text + ' — ' + (d.status === 'superseded' ? 'đã bị thay bằng QĐ' + d.supersededBy : 'đã rút' + (d.note ? ': ' + d.note : '')) + src(d.sourceIds)));
    const line = (a: Action) => {
      const d = byId.get(a.decisionId);
      const review = a.status !== 'rolled_back' && d && (d.status === 'superseded' || d.status === 'withdrawn') && a.status === 'done' ? ' — quyết định gốc đã ' + (d.status === 'superseded' ? 'bị thay' : 'bị rút') + ', cần xem xét hoàn tác' : '';
      const tag = a.status === 'done' ? 'đã làm' : a.status === 'blocked' ? 'bị chặn' : a.status === 'rolled_back' ? 'đã hoàn tác' : a.status === 'failed' ? 'lỗi' : 'chưa làm';
      const detail = [a.result ? 'kết quả: ' + a.result : '', a.rollback ? 'hoàn tác: ' + a.rollback : '', a.note ?? ''].filter(Boolean).join('; ');
      return '- [' + tag + '] V' + a.id + ' ' + a.description + (detail ? ' — ' + detail : '') + review + ' · QĐ' + a.decisionId + src(d?.sourceIds ?? []);
    };
    group('Việc đã làm / bị chặn / đã hoàn tác:', actions.filter(a => a.status === 'done' || a.status === 'blocked' || a.status === 'rolled_back').map(line));
    group('Việc chưa xong (đã lên kế hoạch / lỗi):', actions.filter(a => a.status === 'planned' || a.status === 'failed').map(line));
    return lines;
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------
  private scopeOf(opts: { scope?: string }): string | undefined { return opts.scope === undefined ? undefined : text(opts.scope, 120, 'INVALID_SCOPE'); }
  private row(id: number): any { const r = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id); if (!r) throw new Error('DECISION_NOT_FOUND: ' + id); return r; }
  private actionRow(id: number): any { const r = this.db.prepare('SELECT * FROM actions WHERE id=?').get(id); if (!r) throw new Error('ACTION_NOT_FOUND: ' + id); return r; }
  // 'granted' when `person` holds a grant on '*' or on the named scope; else 'unknown' when the session has no grants at all
  // (nobody was given authority yet), else 'not_granted'. `who` = everyone who could decide for this scope.
  private check(sessionId: string, person: string, scope?: string): { state: AuthorityState; who: string[]; any: boolean } {
    const rows = this.grants(sessionId);
    const eligible = rows.filter(g => g.scope === ANY || (scope !== undefined && same(g.scope, scope)));
    const who = [...new Set(eligible.map(g => g.person))];
    return { state: eligible.some(g => same(g.person, person)) ? 'granted' : rows.length ? 'not_granted' : 'unknown', who, any: rows.length > 0 };
  }
  private park(auth: { state: AuthorityState; who: string[]; any: boolean }, by: string, scope: string | undefined, verb: string): Park {
    const topic = scope ? ' về "' + scope + '"' : '';
    const why = !auth.any ? 'Chưa có ai được owner giao thẩm quyền trong buổi này: hỏi owner trước khi coi là đã ' + (verb === 'rút' ? 'rút' : 'chốt') + topic
      : auth.who.length ? by + ' chưa được owner giao thẩm quyền ' + verb + topic + '; cần ' + auth.who.join(', ') + ' xác nhận'
      : 'Chưa ai được owner giao thẩm quyền ' + verb + topic + ': hỏi owner';
    return { who: auth.who, why };
  }
  // Inside a transaction: record the evidence, then decide if `who` has authority, else leave it proposed with the park info.
  private settle(row: any, who: string, evidence: number[], scope: string | undefined, at: number): DecideResult {
    const auth = this.check(row.session_id, who, scope), merged = JSON.stringify(union(parseIds(row.source_ids), evidence));
    if (auth.state !== 'granted') {
      this.db.prepare("UPDATE decisions SET authority=?, source_ids=?, note=?, updated=? WHERE id=? AND status='proposed'").run(auth.state, merged, joinNote(row.note, 'Chưa chốt: ' + who + ' không có thẩm quyền được owner giao'), at, row.id);
      return { id: row.id, decided: false, authority: auth.state, park: this.park(auth, who, scope, 'chốt') };
    }
    this.db.prepare("UPDATE decisions SET status='decided', decided_by=?, authority='granted', source_ids=?, updated=? WHERE id=?").run(who, merged, at, row.id);
    if (row.supersedes != null) this.applySupersede(Number(row.supersedes), row.id, at);
    return { id: row.id, decided: true, authority: 'granted' };
  }
  private applySupersede(oldId: number, newId: number, at: number) {
    const old = this.row(oldId);
    if (old.status !== 'decided' && old.status !== 'proposed') {
      // Already replaced (or withdrawn) by another change: keep both records, say so on the new one.
      this.db.prepare('UPDATE decisions SET note=? WHERE id=?').run(joinNote(this.row(newId).note, 'QĐ' + oldId + ' đã ở trạng thái ' + old.status + ' trước khi QĐ này được chốt'), newId);
      return;
    }
    this.db.prepare("UPDATE decisions SET status='superseded', superseded_by=?, note=?, updated=? WHERE id=?").run(newId, joinNote(old.note, 'Bị thay bởi QĐ' + newId), at, oldId);
    this.block(oldId, 'Quyết định QĐ' + oldId + ' đã bị thay bởi QĐ' + newId + ': xem xét lại việc này', at);
  }
  // Planned actions of a decision that is no longer in force become 'blocked' with the reason, never kept as if still valid.
  private block(decisionId: number, why: string, at: number) {
    const open = this.db.prepare("SELECT id, note FROM actions WHERE decision_id=? AND status='planned'").all(decisionId) as any[];
    for (const a of open) this.db.prepare("UPDATE actions SET status='blocked', note=?, updated=? WHERE id=?").run(joinNote(a.note, why), at, a.id);
  }
}
