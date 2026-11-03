// Context pack: the pre-meeting context as ONE versioned, provenance-stamped object, plus the rule that says whether a
// given role/consumer has read the RIGHT pack for the RIGHT meeting (EXCEPTIONS_0_12: "chưa có ràng buộc phiên bản/hash
// context"). Pure functions only: no files, no process, no network. The caller (runtime) stores packs and bindings and
// decides what to do with the state; this file only computes. Nothing here is specific to one company or meeting.
import { createHash } from 'node:crypto';

export type Basis = 'user_confirmed' | 'inferred';
export type CorrectionScope = 'meeting' | 'company';
export type RosterItem = { name: string; role?: string; languages: string[]; aliases: string[]; source: string; basis: string };
export type EntityItem = { name: string; kind?: string; aliases: string[]; source: string };
export type DocItem = { label: string; pointer: string; source: string };
export type Correction = { raw: string; corrected: string; sourceId?: string; at: string; basis: Basis; scope: CorrectionScope; by?: string };
export type ContextPack = {
  version: string; createdAt: string;
  meeting: { sessionId: string; title: string; scheduledStart?: string };
  me?: string; roster: RosterItem[]; topics: string[]; entities: EntityItem[]; docs: DocItem[]; corrections: Correction[]; missing: string[];
};

// What the runtime already has at prepare(): agenda text, participants file rows, glossary entries. Every list item may
// say where it came from; the defaults name the file or step it normally comes from.
export type PackInput = {
  sessionId: string; title?: string; scheduledStart?: string; me?: string;
  agenda?: string; topics?: string[];
  participants?: { name: string; role?: string; languages?: string[]; variants?: string[]; source?: string; basis?: string }[];
  glossary?: { name: string; kind?: string; variants?: string[]; source?: string }[];
  docs?: { label: string; pointer: string; source?: string }[];
  corrections?: (Partial<Correction> & { raw: string; corrected: string })[];
  createdAt?: string; // injectable so tests and replays are deterministic
};

const MAX_TOPICS = 40;
const clip = (value: unknown, max = 200) => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;
const low = (text: string) => text.toLowerCase();
// Aliases: trimmed, unique ignoring case, never the name itself.
function aliasesOf(name: string, raw: unknown) {
  const out = new Map<string, string>();
  if (Array.isArray(raw)) for (const item of raw) { const alias = clip(item, 120); if (alias && low(alias) !== low(name) && !out.has(low(alias))) out.set(low(alias), alias); }
  return [...out.values()].sort();
}

// Same value, same text: keys sorted, undefined dropped. The version is a hash of this, so it must not depend on
// object key order or on optional fields being present-but-undefined.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item === undefined ? null : item)).join(',') + ']';
  if (value && typeof value === 'object') {
    const body = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v));
    return '{' + body.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
const versionOf = (body: unknown) => createHash('sha256').update('pma-context-pack/1\n' + canonical(body)).digest('hex').slice(0, 16);

// Agenda free text becomes topic lines (bullets stripped). The pack keeps the lines, not the raw blob, so a changed
// word in the agenda changes the version and a role can tell its copy is old.
function topicsOf(agenda?: string, topics?: string[]) {
  const lines = [...(topics ?? []), ...(agenda ? agenda.split(/\r?\n/) : [])].map(line => clip(String(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''), 300)).filter((line): line is string => !!line);
  return [...new Set(lines)].slice(0, MAX_TOPICS);
}

export function buildPack(input: PackInput): ContextPack {
  const sessionId = clip(input.sessionId, 100); if (!sessionId) throw new Error('INVALID_CONTEXT_PACK: thiếu sessionId');
  const title = clip(input.title, 300) ?? '';
  const scheduledStart = clip(input.scheduledStart, 40);
  const me = clip(input.me, 120);

  // Same person twice is one person; aliases and languages merge. Sorted so the file's row order does not change the version.
  const people = new Map<string, RosterItem>();
  for (const raw of input.participants ?? []) {
    const name = clip(raw?.name, 120); if (!name) continue;
    const languages = Array.isArray(raw.languages) ? raw.languages.map(v => low(String(v).trim())).filter(Boolean) : [];
    const prev = people.get(low(name));
    const merged: RosterItem = { name: prev?.name ?? name, role: prev?.role ?? clip(raw.role, 120), languages: [...new Set([...(prev?.languages ?? []), ...languages])].sort(), aliases: [], source: prev?.source ?? clip(raw.source, 60) ?? 'participants_file', basis: prev?.basis ?? clip(raw.basis, 40) ?? 'owner_stated' };
    merged.aliases = aliasesOf(merged.name, [...(prev?.aliases ?? []), ...(Array.isArray(raw.variants) ? raw.variants : [])]);
    people.set(low(name), merged);
  }
  const roster = [...people.values()].sort((a, b) => (low(a.name) < low(b.name) ? -1 : low(a.name) > low(b.name) ? 1 : 0));

  const things = new Map<string, EntityItem>();
  for (const raw of input.glossary ?? []) {
    const name = clip(raw?.name, 120); if (!name) continue;
    const prev = things.get(low(name));
    const merged: EntityItem = { name: prev?.name ?? name, kind: prev?.kind ?? clip(raw.kind, 40), aliases: [], source: prev?.source ?? clip(raw.source, 60) ?? 'glossary' };
    merged.aliases = aliasesOf(merged.name, [...(prev?.aliases ?? []), ...(Array.isArray(raw.variants) ? raw.variants : [])]);
    things.set(low(name), merged);
  }
  const entities = [...things.values()].sort((a, b) => (low(a.name) < low(b.name) ? -1 : low(a.name) > low(b.name) ? 1 : 0));

  const docs: DocItem[] = []; const seenDocs = new Set<string>();
  for (const raw of input.docs ?? []) {
    const label = clip(raw?.label, 160), pointer = clip(raw?.pointer, 500); if (!label || !pointer || seenDocs.has(label + '\n' + pointer)) continue;
    seenDocs.add(label + '\n' + pointer); docs.push({ label, pointer, source: clip(raw.source, 60) ?? 'owner_docs' });
  }
  docs.sort((a, b) => (a.label + a.pointer < b.label + b.pointer ? -1 : 1));

  // Corrections keep the caller's order (a later one on the same raw string wins in applyCorrections). `inferred` is the
  // safe default: only an explicit user confirmation says otherwise.
  const corrections: Correction[] = [];
  for (const raw of input.corrections ?? []) {
    const rawText = typeof raw?.raw === 'string' ? raw.raw.trim() : '', corrected = clip(raw?.corrected, 300); if (!rawText || !corrected) continue;
    corrections.push({ raw: rawText.slice(0, 300), corrected, sourceId: clip(raw.sourceId, 60), at: clip(raw.at, 40) ?? '', basis: raw.basis === 'user_confirmed' ? 'user_confirmed' : 'inferred', scope: raw.scope === 'company' ? 'company' : 'meeting', by: clip(raw.by, 80) });
  }

  const topics = topicsOf(input.agenda, input.topics);
  // Missing is information, not a block: capture never waits for context, and the caller reports DEGRADED with these.
  const missing = [!me && 'me', !topics.length && 'agenda', !roster.length && 'roster', !entities.length && 'entities'].filter((item): item is string => !!item);

  const body = { meeting: { sessionId, title, scheduledStart }, me, roster, topics, entities, docs, corrections, missing };
  return { version: versionOf(body), createdAt: clip(input.createdAt, 40) ?? new Date().toISOString(), ...body };
}

// ---- Bindings: which consumer of which role read which pack version, at which generation ----------------------------
// A role is a kind of reader (chinh, dich, a background analyst); a consumer is one concrete reader of it; a restart of
// that reader's process is generation + 1 and has to read the pack again.
export type Binding = { sessionId: string; role: string; consumerId: string; generation: number; version: string; boundAt: string };
export type Bindings = Readonly<Record<string, Binding>>;
export const bindingKey = (sessionId: string, role: string, consumerId: string) => JSON.stringify([sessionId, role, consumerId]);

// Immutable update. A bind from an OLDER generation than the recorded one is ignored: a zombie of the previous process
// must not overwrite what its replacement has read.
export function bindRole(bindings: Bindings, input: { sessionId: string; role: string; consumerId: string; generation: number; version: string; boundAt?: string }): Bindings {
  const key = bindingKey(input.sessionId, input.role, input.consumerId);
  const prev = bindings[key]; if (prev && prev.generation > input.generation) return bindings;
  return { ...bindings, [key]: { sessionId: input.sessionId, role: input.role, consumerId: input.consumerId, generation: input.generation, version: input.version, boundAt: input.boundAt ?? new Date().toISOString() } };
}

export type ReadinessState = 'READY' | 'DEGRADED' | 'NOT_READY' | 'NEEDS_REBIND';
export type Readiness = { state: ReadinessState; reasons: string[] };

// Rules, first match wins:
//   no pack, ASR listening         DEGRADED     NO_CONTEXT       capture is never blocked by missing context, but NOTHING may be
//                                                                 published as a decision, owner or deadline on this basis
//   no pack, ASR not listening     NOT_READY    ASR_NOT_LISTENING, NO_CONTEXT
//   pack of another session        NOT_READY    OTHER_SESSION
//   ASR not listening              NOT_READY    ASR_NOT_LISTENING
//   this consumer bound, current   READY (DEGRADED + MISSING:<what> when pack.missing is not empty)
//   this consumer bound, older     NEEDS_REBIND STALE_CONTEXT    caller rebinds on the next brief; the owner is never asked to reload
//   (optional `generation` given)  older record -> NEEDS_REBIND STALE_GENERATION; newer record -> NOT_READY SUPERSEDED
//   not bound, another reader has  NOT_READY    WRONG_CONSUMER   the current version, or this consumer is bound only in another session -> OTHER_SESSION
//   not bound anywhere             NEEDS_REBIND NOT_BOUND
export function readiness(input: { pack?: ContextPack | null; sessionId: string; asrListening: boolean; bindings: Bindings; role: string; consumerId: string; generation?: number }): Readiness {
  const { pack, sessionId, asrListening, bindings, role, consumerId } = input;
  if (!pack) return asrListening ? { state: 'DEGRADED', reasons: ['NO_CONTEXT'] } : { state: 'NOT_READY', reasons: ['ASR_NOT_LISTENING', 'NO_CONTEXT'] };
  if (pack.meeting.sessionId !== sessionId) return { state: 'NOT_READY', reasons: ['OTHER_SESSION'] };
  if (!asrListening) return { state: 'NOT_READY', reasons: ['ASR_NOT_LISTENING'] };

  const own = bindings[bindingKey(sessionId, role, consumerId)];
  if (own) {
    if (input.generation !== undefined && own.generation > input.generation) return { state: 'NOT_READY', reasons: ['SUPERSEDED'] };
    if (own.version !== pack.version) return { state: 'NEEDS_REBIND', reasons: ['STALE_CONTEXT'] };
    if (input.generation !== undefined && own.generation < input.generation) return { state: 'NEEDS_REBIND', reasons: ['STALE_GENERATION'] };
    return pack.missing.length ? { state: 'DEGRADED', reasons: pack.missing.map(item => 'MISSING:' + item) } : { state: 'READY', reasons: [] };
  }
  const all = Object.values(bindings);
  if (all.some(b => b.sessionId === sessionId && b.version === pack.version && (b.role !== role || b.consumerId !== consumerId))) return { state: 'NOT_READY', reasons: ['WRONG_CONSUMER'] };
  if (all.some(b => b.sessionId !== sessionId && b.role === role && b.consumerId === consumerId)) return { state: 'NOT_READY', reasons: ['OTHER_SESSION'] };
  return { state: 'NEEDS_REBIND', reasons: ['NOT_BOUND'] };
}

const REASONS: Record<string, string> = {
  NO_CONTEXT: 'chưa có context trước họp (vẫn ghi và nghe, nhưng không chốt quyết định, người phụ trách, hạn từ nền này)',
  ASR_NOT_LISTENING: 'bộ nghe chưa chạy',
  OTHER_SESSION: 'context đang đọc là của cuộc họp khác',
  WRONG_CONSUMER: 'context đã được đọc bởi vai/phiên khác, không phải phiên này',
  STALE_CONTEXT: 'context đã đổi, cần đọc lại brief (tự đọc lại, không cần owner làm gì)',
  STALE_GENERATION: 'tiến trình đã khởi động lại, cần đọc lại brief',
  SUPERSEDED: 'đã có tiến trình mới hơn của vai này thay thế',
  NOT_BOUND: 'vai này chưa đọc context',
};
const MISSING: Record<string, string> = { me: 'chưa biết owner là ai', agenda: 'chưa có chương trình họp', roster: 'chưa có danh sách người dự', entities: 'chưa có bảng tên riêng/thuật ngữ' };
// One Vietnamese line for the owner or a status line, from the machine codes.
export const describeReadiness = (result: Readiness) => result.reasons.map(code => code.startsWith('MISSING:') ? 'thiếu: ' + (MISSING[code.slice(8)] ?? code.slice(8)) : REASONS[code] ?? code).join('; ');

// ---- Corrections: display only ------------------------------------------------------------------------------------
// Mirrors applyGlossary in text.ts: the stored text is never changed, only what is shown. A raw string matches only as
// the exact, whole, case-sensitive token (not inside a longer word), in ONE pass so a replacement is never corrected again.
// Nothing is guessed: "Ta"/"tôi" are untouched unless that exact string is listed.
// scope 'meeting' = this meeting's display: meeting AND company corrections; 'company' = company-wide display: company only
// (a correction made for one meeting must not leak into every other meeting).
// A user_confirmed correction replaces the text; an inferred one keeps the heard form visible, "corrected (nghe: raw)".
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function applyCorrections(text: string, corrections: Correction[] | undefined, scope: CorrectionScope = 'meeting') {
  const usable = (corrections ?? []).filter(c => c.raw && c.corrected && c.raw !== c.corrected && (scope === 'meeting' || c.scope === 'company'));
  if (!usable.length) return text;
  const byRaw = new Map<string, Correction>();
  for (const c of [...usable].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) byRaw.set(c.raw, c); // later `at` wins; ties keep list order
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...byRaw.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  return text.replace(pattern, match => { const c = byRaw.get(match)!; return c.basis === 'user_confirmed' ? c.corrected : `${c.corrected} (nghe: ${match})`; });
}

// Suggested storage; the runtime wires it. One pack per (session, version) so older versions stay for audit; one binding
// per (session, role, consumer), overwritten by a newer generation or version.
export const CONTEXT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS context_packs(session_id TEXT NOT NULL, version TEXT NOT NULL, created TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(session_id, version));
CREATE TABLE IF NOT EXISTS context_bindings(session_id TEXT NOT NULL, role TEXT NOT NULL, consumer_id TEXT NOT NULL, generation INTEGER NOT NULL, version TEXT NOT NULL, bound_at TEXT NOT NULL, PRIMARY KEY(session_id, role, consumer_id));
`;
