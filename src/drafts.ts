// Drafts: the PURE contract that any host interface must satisfy when the agent hands content to the host (the whole-meeting
// picture, a translation batch, the participants list, SUMMARY, tasks). Pure functions and types only: no files, no process,
// no network, no database, no clock of its own (`now` is passed in). The host stores the DraftState this file returns; this
// file only decides and computes. It is NOT a route to write anything anywhere: a draft is CONTENT, never a location and never
// an instruction, and nothing here opens, writes, runs or sends. (The route that would have let the host write into .local,
// `pma owner` / saveOwner / `--file -`, stays stopped and is not implemented, wired or worked around here.)
//
// Rules, first match wins (the order is part of the contract and is tested):
//   admit(state, envelope, now)
//     1  envelope malformed (unknown key, path-like or command-like field, bad id/int)             INVALID_ENVELOPE
//     2  session unknown to this host, or open but not the active meeting                          OTHER_SESSION
//     3  content breaks the kind's schema (unknown key anywhere, forbidden key, size, source ids)  INVALID_CONTENT
//     4  this consumer already used this idempotencyKey in this session
//          same content hash                                                                       ok, duplicate, SAME revision (no new revision)
//          different content hash (or a different kind)                                            KEY_CONFLICT
//        A replay is answered from the record BEFORE any freshness check (5-8): it writes nothing, and a timeout after a save
//        must be answered "saved at revision N", never "stale", never "closed", never silence (no unknown outcome left over).
//     5  session ended and the kind is not an afterwards kind, or session withdrawn                SESSION_CLOSED
//     6  generation older than the last seen for this consumer (a late result of an old run)      STALE_GENERATION
//     7  consumer has no binding at this generation, or the session has no context yet            NOT_BOUND
//     8  binding version, envelope contextVersion and the session's current version are not all equal   STALE_CONTEXT
//     9  expectedRevision != current revision of (session, kind)                                   STALE_REVISION
//    10  content identical to the latest revision of that kind (new key)                           ok, duplicate, no new revision (as savePicture)
//    11  a confirmed participants/tasks entry of the latest revision is dropped or not carried as confirmed   CONFIRMED_OVERRIDE
//    12  otherwise                                                                                 ok, revision = current + 1, SAVED fact written
//   A refusal returns the SAME state object. ok:true is only ever returned together with a `saved` fact in the returned state.
//
// Receipts are four separate facts, kept in four separate collections and never folded into one flag:
//   saved                  the host stored revision N                     written only by admit
//   delivered              the host handed revision N to a consumer       written only by markDelivered (a host or transport ACK is this and nothing more)
//   confirmedByConsumer    THAT consumer, at THAT generation, says it got revision N of THAT content hash and THAT context version   written only by confirm
//   actionDone             the action a draft leads to was done           written only by markActionDone
// receiptOf() returns the four side by side; there is no "complete" field to read instead of them.
//
// Authority: a draft never grants approval. Content keys are closed, so `approved`, `decision`, `grant`, `authority` as KEYS are
// rejected as unknown keys; as TEXT inside a text field they are plain words with no effect. Nothing in this file reads content to
// decide anything except the shape rules above and the confirmed-entries rule (11). A `basis` in content is a claim recorded as
// data; stickiness protects what is already stored as confirmed, it does not make a claim true (see the report: undecided).
import { createHash } from 'node:crypto';

export const DRAFT_KINDS = ['picture', 'translations', 'participants', 'summary', 'tasks'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
// Kinds the host still accepts after the meeting ENDED (they are written afterwards, from the RAW). A withdrawn session accepts none.
export const AFTERWARDS_KINDS: readonly DraftKind[] = ['summary', 'tasks'];
// Kinds that lead to an action whose completion can be recorded as `actionDone`.
export const ACTION_KINDS: readonly DraftKind[] = ['participants', 'tasks'];

// Same sizes as the daemon's schemas (picture 30000 as PICTURE_MAX_CHARS; translate items; participants; summary; tasks).
export const DRAFT_LIMITS = {
  pictureChars: 30000, pictureSources: 50,
  translationItems: 100, translationChars: 2000,
  participants: 50, nameChars: 120, roleChars: 120, variants: 20, variantChars: 80,
  summaryChars: 40000, summarySources: 200,
  tasks: 200, taskChars: 2000, ownerChars: 200, dueChars: 200, taskSources: 50,
  actionChars: 500, byChars: 120,
} as const;

export type PictureContent = { text: string; sourceIds: number[] };
export type TranslationsContent = { items: { sourceId: number; text: string }[] };
export type ParticipantBasis = 'user_confirmed' | 'owner_stated' | 'inferred';
export type ParticipantItem = { name: string; role?: string; languages?: string[]; variants?: string[]; basis?: ParticipantBasis };
export type ParticipantsContent = { participants: ParticipantItem[] };
export type SummaryContent = { markdown: string; sourceIds: number[] };
export type TaskBasis = 'stated' | 'confirmed' | 'inferred';
export type TaskItem = { task: string; owner?: string; due?: string; ownerBasis?: TaskBasis; sourceIds: number[] };
export type TasksContent = { tasks: TaskItem[] };
export type DraftContent = PictureContent | TranslationsContent | ParticipantsContent | SummaryContent | TasksContent;

export type DraftEnvelope = {
  kind: DraftKind; sessionId: string; consumerId: string; generation: number; contextVersion: string;
  expectedRevision: number; idempotencyKey: string; content: unknown;
};

// ---- Strict validators (throw Invalid internally; the public functions return a result) --------------------------------------
class Invalid extends Error { constructor(readonly code: string, readonly path: string) { super(code + ' at ' + path); } }

// Reason-precision only: every key not listed in a schema is refused anyway; these names just get a clearer code. A draft has
// no field that names a place or runs anything.
const FORBIDDEN_KEY = /^(?:__proto__|constructor|prototype|paths?|files?|filepath|filename|dirs?|directory|folder|cwd|urls?|uris?|href|links?|cmd|commands?|exec|run|shell|script|argv|args|eval|spawn)$/i;
// Ids are opaque tokens (uuid, hex version, a consumer name). No slash, backslash, space or colon-path shape can pass.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LANGS: readonly string[] = ['vi', 'lo', 'th'];
const PARTICIPANT_BASES: readonly string[] = ['user_confirmed', 'owner_stated', 'inferred'];
const TASK_BASES: readonly string[] = ['stated', 'confirmed', 'inferred'];

// A closed plain object: own, enumerable-by-listing, DATA properties only (no getters that could answer differently the second
// time), no symbol keys, no prototype tricks. `undefined` counts as absent.
function obj(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid('NOT_AN_OBJECT', path);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Invalid('NOT_PLAIN_OBJECT', path);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Invalid('SYMBOL_KEY', path);
    if (!required.includes(key) && !optional.includes(key)) throw new Invalid(FORBIDDEN_KEY.test(key) ? 'FORBIDDEN_KEY' : 'UNKNOWN_KEY', path + '.' + key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Invalid('ACCESSOR_KEY', path + '.' + key);
    if (descriptor.value !== undefined) out[key] = descriptor.value;
  }
  for (const key of required) if (!(key in out)) throw new Invalid('MISSING_KEY', path + '.' + key);
  return out;
}
function arr(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Invalid('NOT_AN_ARRAY', path);
  if (value.length < min || value.length > max) throw new Invalid('BAD_LENGTH', path);
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new Invalid('NOT_PLAIN_ARRAY', path);
  return value.map((_, i) => { const d = Object.getOwnPropertyDescriptor(value, i); if (!d || !('value' in d)) throw new Invalid('BAD_ELEMENT', path + '[' + i + ']'); return d.value; });
}
function str(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Invalid('NOT_A_STRING', path);
  if (value.includes('\0')) throw new Invalid('NUL_IN_TEXT', path);
  const text = value.normalize('NFC').trim();
  if (text.length < min || text.length > max) throw new Invalid('BAD_LENGTH', path);
  return text;
}
const optStr = (value: unknown, path: string, max: number) => (value === undefined ? undefined : str(value, path, 1, max));
function id(value: unknown, path: string): string { if (typeof value !== 'string' || !ID_RE.test(value)) throw new Invalid('BAD_ID', path); return value; }
function int(value: unknown, path: string, min: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Invalid('BAD_INTEGER', path); return value; }
function oneOf<T extends string>(value: unknown, path: string, allowed: readonly string[]): T { if (typeof value !== 'string' || !allowed.includes(value)) throw new Invalid('BAD_VALUE', path); return value as T; }
// Source ids are provenance (same rule as jobs.ts / decisions.ts): positive safe integers, unique, sorted.
function sourceIds(value: unknown, path: string, max: number): number[] {
  const list = arr(value, path, 1, max).map((n, i) => int(n, path + '[' + i + ']', 1));
  return [...new Set(list)].sort((a, b) => a - b);
}
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lower = (text: string) => text.toLowerCase();

function validatePicture(value: unknown): PictureContent {
  const o = obj(value, 'content', ['text', 'sourceIds']);
  return { text: str(o.text, 'content.text', 1, DRAFT_LIMITS.pictureChars), sourceIds: sourceIds(o.sourceIds, 'content.sourceIds', DRAFT_LIMITS.pictureSources) };
}
function validateTranslations(value: unknown): TranslationsContent {
  const o = obj(value, 'content', ['items']);
  const seen = new Set<number>();
  const items = arr(o.items, 'content.items', 1, DRAFT_LIMITS.translationItems).map((raw, i) => {
    const p = 'content.items[' + i + ']'; const item = obj(raw, p, ['sourceId', 'text']);
    const sourceId = int(item.sourceId, p + '.sourceId', 1);
    if (seen.has(sourceId)) throw new Invalid('DUPLICATE_ENTRY', p + '.sourceId'); seen.add(sourceId);
    return { sourceId, text: str(item.text, p + '.text', 1, DRAFT_LIMITS.translationChars) };
  });
  return { items: items.sort((a, b) => a.sourceId - b.sourceId) };
}
function validateParticipants(value: unknown): ParticipantsContent {
  const o = obj(value, 'content', ['participants']);
  const seen = new Set<string>();
  const people = arr(o.participants, 'content.participants', 1, DRAFT_LIMITS.participants).map((raw, i) => {
    const p = 'content.participants[' + i + ']'; const item = obj(raw, p, ['name'], ['role', 'languages', 'variants', 'basis']);
    const name = str(item.name, p + '.name', 1, DRAFT_LIMITS.nameChars);
    if (seen.has(lower(name))) throw new Invalid('DUPLICATE_ENTRY', p + '.name'); seen.add(lower(name));
    const out: ParticipantItem = { name };
    const role = optStr(item.role, p + '.role', DRAFT_LIMITS.roleChars); if (role) out.role = role;
    if (item.languages !== undefined) { const languages = [...new Set(arr(item.languages, p + '.languages', 0, LANGS.length).map((v, j) => oneOf<string>(v, p + '.languages[' + j + ']', LANGS)))].sort(); if (languages.length) out.languages = languages; }
    if (item.variants !== undefined) { const variants = [...new Set(arr(item.variants, p + '.variants', 0, DRAFT_LIMITS.variants).map((v, j) => str(v, p + '.variants[' + j + ']', 1, DRAFT_LIMITS.variantChars)))].sort(byText); if (variants.length) out.variants = variants; }
    if (item.basis !== undefined) out.basis = oneOf<ParticipantBasis>(item.basis, p + '.basis', PARTICIPANT_BASES);
    return out;
  });
  return { participants: people.sort((a, b) => byText(lower(a.name), lower(b.name))) };
}
function validateSummary(value: unknown): SummaryContent {
  const o = obj(value, 'content', ['markdown', 'sourceIds']);
  return { markdown: str(o.markdown, 'content.markdown', 1, DRAFT_LIMITS.summaryChars), sourceIds: sourceIds(o.sourceIds, 'content.sourceIds', DRAFT_LIMITS.summarySources) };
}
function validateTasks(value: unknown): TasksContent {
  const o = obj(value, 'content', ['tasks']);
  const seen = new Set<string>();
  const tasks = arr(o.tasks, 'content.tasks', 0, DRAFT_LIMITS.tasks).map((raw, i) => {
    const p = 'content.tasks[' + i + ']'; const item = obj(raw, p, ['task', 'sourceIds'], ['owner', 'due', 'ownerBasis']);
    const task = str(item.task, p + '.task', 1, DRAFT_LIMITS.taskChars);
    if (seen.has(lower(task))) throw new Invalid('DUPLICATE_ENTRY', p + '.task'); seen.add(lower(task));
    const out: TaskItem = { task, sourceIds: sourceIds(item.sourceIds, p + '.sourceIds', DRAFT_LIMITS.taskSources) };
    const owner = optStr(item.owner, p + '.owner', DRAFT_LIMITS.ownerChars); if (owner) out.owner = owner;
    const due = optStr(item.due, p + '.due', DRAFT_LIMITS.dueChars); if (due) out.due = due;
    if (item.ownerBasis !== undefined) out.ownerBasis = oneOf<TaskBasis>(item.ownerBasis, p + '.ownerBasis', TASK_BASES);
    return out;
  });
  return { tasks };
}
const VALIDATORS: Record<DraftKind, (value: unknown) => DraftContent> = { picture: validatePicture, translations: validateTranslations, participants: validateParticipants, summary: validateSummary, tasks: validateTasks };

// Same value, same text: keys sorted, undefined dropped (same idea as context_pack.canonical).
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item === undefined ? null : item)).join(',') + ']';
  if (value && typeof value === 'object') {
    const body = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => byText(a, b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v));
    return '{' + body.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
// The hash covers the KIND and the NORMALISED content, so the same words under another kind are another hash, and key order,
// source-id order or surrounding blanks do not change it.
export const hashOf = (kind: DraftKind, content: DraftContent) => createHash('sha256').update('pma-draft/1\n' + kind + '\n' + canonical(content)).digest('hex');

export type ValidatedDraft = { ok: true; content: DraftContent; contentHash: string } | { ok: false; code: string; path: string };
export function validateDraft(kind: DraftKind, content: unknown): ValidatedDraft {
  const validator = (DRAFT_KINDS as readonly string[]).includes(kind) ? VALIDATORS[kind] : undefined;
  if (!validator) return { ok: false, code: 'UNKNOWN_KIND', path: 'kind' };
  try { const normalised = validator(content); return { ok: true, content: normalised, contentHash: hashOf(kind, normalised) }; }
  catch (error) { if (error instanceof Invalid) return { ok: false, code: error.code, path: error.path }; throw error; }
}

// ---- State ---------------------------------------------------------------------------------------------------------------------
export type SessionStatus = 'open' | 'ended' | 'withdrawn';
export type SessionInfo = { status: SessionStatus; contextVersion: string | null; opened: number; closed: number | null };
export type DraftBinding = { sessionId: string; consumerId: string; generation: number; version: string; boundAt: number };
export type SavedFact = { sessionId: string; kind: DraftKind; revision: number; contentHash: string; content: DraftContent; contextVersion: string; authorConsumerId: string; authorGeneration: number; idempotencyKey: string; savedAt: number };
export type KeyRecord = { kind: DraftKind; revision: number; contentHash: string; firstSeen: number };
type FactBase = { sessionId: string; kind: DraftKind; revision: number; contentHash: string };
export type DeliveredFact = FactBase & { consumerId: string; generation: number; contextVersion: string; at: number };
export type ConfirmedFact = FactBase & { consumerId: string; generation: number; contextVersion: string; at: number };
export type ActionFact = FactBase & { action: string; by: string; at: number };

// Keys are JSON arrays of their parts, so no part can bleed into another:
//   sessions[sessionId]; bindings/lastGeneration[session,consumer]; revisions[session,kind]; keys[session,consumer,idempotencyKey];
//   saved/delivered/confirmed/actions[session,kind,revision]
export type DraftState = Readonly<{
  activeSessionId: string | null;
  sessions: Readonly<Record<string, SessionInfo>>;
  bindings: Readonly<Record<string, DraftBinding>>;
  lastGeneration: Readonly<Record<string, number>>;
  revisions: Readonly<Record<string, number>>;
  keys: Readonly<Record<string, KeyRecord>>;
  saved: Readonly<Record<string, SavedFact>>;
  delivered: Readonly<Record<string, readonly DeliveredFact[]>>;
  confirmed: Readonly<Record<string, readonly ConfirmedFact[]>>;
  actions: Readonly<Record<string, readonly ActionFact[]>>;
}>;
export const emptyState = (): DraftState => ({ activeSessionId: null, sessions: {}, bindings: {}, lastGeneration: {}, revisions: {}, keys: {}, saved: {}, delivered: {}, confirmed: {}, actions: {} });

const k = (...parts: (string | number)[]) => JSON.stringify(parts);
const maxGeneration = (state: DraftState, consumerKey: string, generation: number) => Math.max(state.lastGeneration[consumerKey] ?? 0, generation);
function needClock(now: number) { if (!Number.isFinite(now)) throw new Error('INVALID_CLOCK'); }
const acceptsKind = (status: SessionStatus, kind: DraftKind) => status === 'open' || (status === 'ended' && AFTERWARDS_KINDS.includes(kind));

// ---- Session transitions (programmer errors throw; nothing is ever deleted) ----------------------------------------------------
// One active meeting at a time (the machine lock already guarantees it). Re-opening an id that was closed is refused: a closed
// meeting stays closed, so a late draft of it can never come back to life.
export function openSession(state: DraftState, sessionId: string, contextVersion: string | null, now: number): DraftState {
  needClock(now); id(sessionId, 'sessionId'); if (contextVersion !== null) id(contextVersion, 'contextVersion');
  if (state.sessions[sessionId]) throw new Error('SESSION_ALREADY_KNOWN: ' + sessionId);
  if (state.activeSessionId) throw new Error('SESSION_ALREADY_ACTIVE: ' + state.activeSessionId);
  return { ...state, activeSessionId: sessionId, sessions: { ...state.sessions, [sessionId]: { status: 'open', contextVersion, opened: now, closed: null } } };
}
// A new pack version: every consumer bound to an older version is stale from this moment (nothing else to do).
export function setContextVersion(state: DraftState, sessionId: string, contextVersion: string, now: number): DraftState {
  needClock(now); id(contextVersion, 'contextVersion');
  const session = state.sessions[sessionId]; if (!session) throw new Error('UNKNOWN_SESSION: ' + sessionId);
  if (session.status === 'withdrawn') throw new Error('SESSION_CLOSED: ' + sessionId);
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, contextVersion } } };
}
export function endSession(state: DraftState, sessionId: string, now: number): DraftState {
  needClock(now); const session = state.sessions[sessionId]; if (!session) throw new Error('UNKNOWN_SESSION: ' + sessionId);
  if (session.status !== 'open') return state;
  return { ...state, activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId, sessions: { ...state.sessions, [sessionId]: { ...session, status: 'ended', closed: now } } };
}
// Withdrawn is final and beats ended: nothing more is accepted, not even an afterwards kind. Saved drafts stay as history.
export function withdrawSession(state: DraftState, sessionId: string, now: number): DraftState {
  needClock(now); const session = state.sessions[sessionId]; if (!session) throw new Error('UNKNOWN_SESSION: ' + sessionId);
  if (session.status === 'withdrawn') return state;
  return { ...state, activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId, sessions: { ...state.sessions, [sessionId]: { ...session, status: 'withdrawn', closed: session.closed ?? now } } };
}

export type StepResult = { ok: true; duplicate?: boolean; state: DraftState } | { ok: false; reason: string; detail?: string; state: DraftState };
const refuseStep = (state: DraftState, reason: string, detail?: string): StepResult => ({ ok: false, reason, detail, state });

// The consumer says which context version it read, at which generation (same idea as context_pack.bindRole). A bind from an
// OLDER generation than the last seen is refused (a zombie must not overwrite its replacement). Binding an old version is
// recorded as it is; admit then says STALE_CONTEXT. Does not make anything "confirmed".
export function bindConsumer(state: DraftState, input: { sessionId: string; consumerId: string; generation: number; version: string }, now: number): StepResult {
  needClock(now);
  let sessionId: string, consumerId: string, generation: number, version: string;
  try { sessionId = id(input?.sessionId, 'sessionId'); consumerId = id(input?.consumerId, 'consumerId'); generation = int(input?.generation, 'generation', 0); version = id(input?.version, 'version'); }
  catch (error) { if (error instanceof Invalid) return refuseStep(state, 'INVALID_INPUT', error.message); throw error; }
  const session = state.sessions[sessionId];
  if (!session || (session.status === 'open' && state.activeSessionId !== sessionId)) return refuseStep(state, 'OTHER_SESSION');
  if (session.status === 'withdrawn') return refuseStep(state, 'SESSION_CLOSED');
  const consumerKey = k(sessionId, consumerId);
  if (generation < (state.lastGeneration[consumerKey] ?? 0)) return refuseStep(state, 'STALE_GENERATION');
  return { ok: true, state: { ...state, bindings: { ...state.bindings, [consumerKey]: { sessionId, consumerId, generation, version, boundAt: now } }, lastGeneration: { ...state.lastGeneration, [consumerKey]: maxGeneration(state, consumerKey, generation) } } };
}

// ---- admit ---------------------------------------------------------------------------------------------------------------------
export type RefusalReason = 'INVALID_ENVELOPE' | 'INVALID_CONTENT' | 'OTHER_SESSION' | 'SESSION_CLOSED' | 'NOT_BOUND' | 'STALE_CONTEXT' | 'STALE_GENERATION' | 'STALE_REVISION' | 'KEY_CONFLICT' | 'CONFIRMED_OVERRIDE';
export type AdmitResult =
  | { ok: true; revision: number; duplicate: boolean; kind: DraftKind; contentHash: string; state: DraftState }
  | { ok: false; reason: RefusalReason; detail?: string; currentRevision?: number; state: DraftState };
const refuse = (state: DraftState, reason: RefusalReason, detail?: string, currentRevision?: number): AdmitResult => ({ ok: false, reason, detail, ...(currentRevision === undefined ? {} : { currentRevision }), state });

type ParsedEnvelope = { kind: DraftKind; sessionId: string; consumerId: string; generation: number; contextVersion: string; expectedRevision: number; idempotencyKey: string; content: unknown };
function parseEnvelope(input: unknown): { ok: true; envelope: ParsedEnvelope } | { ok: false; detail: string } {
  try {
    const o = obj(input, 'envelope', ['kind', 'sessionId', 'consumerId', 'generation', 'contextVersion', 'expectedRevision', 'idempotencyKey', 'content']);
    return { ok: true, envelope: { kind: oneOf<DraftKind>(o.kind, 'envelope.kind', DRAFT_KINDS), sessionId: id(o.sessionId, 'envelope.sessionId'), consumerId: id(o.consumerId, 'envelope.consumerId'), generation: int(o.generation, 'envelope.generation', 0), contextVersion: id(o.contextVersion, 'envelope.contextVersion'), expectedRevision: int(o.expectedRevision, 'envelope.expectedRevision', 0), idempotencyKey: id(o.idempotencyKey, 'envelope.idempotencyKey'), content: o.content } };
  } catch (error) { if (error instanceof Invalid) return { ok: false, detail: error.message }; throw error; }
}

// Entries of kinds that carry a basis: key -> is it confirmed. Participants: user_confirmed or owner_stated. Tasks: ownerBasis
// 'confirmed' only ('stated' is what was said in the meeting, not what the owner confirmed). Absent basis = inferred.
function entriesOf(kind: DraftKind, content: DraftContent): Map<string, boolean> | null {
  if (kind === 'participants') return new Map((content as ParticipantsContent).participants.map(p => [lower(p.name), p.basis === 'user_confirmed' || p.basis === 'owner_stated']));
  if (kind === 'tasks') return new Map((content as TasksContent).tasks.map(t => [lower(t.task), t.ownerBasis === 'confirmed']));
  return null;
}

export function admit(state: DraftState, input: unknown, now: number): AdmitResult {
  needClock(now);
  const parsed = parseEnvelope(input); if (!parsed.ok) return refuse(state, 'INVALID_ENVELOPE', parsed.detail);
  const env = parsed.envelope;

  const session = state.sessions[env.sessionId];
  if (!session || (session.status === 'open' && state.activeSessionId !== env.sessionId)) return refuse(state, 'OTHER_SESSION', env.sessionId);

  const checked = validateDraft(env.kind, env.content); if (!checked.ok) return refuse(state, 'INVALID_CONTENT', checked.code + ' at ' + checked.path);
  const { content, contentHash } = checked;

  const consumerKey = k(env.sessionId, env.consumerId);
  // A replay: answered from the record, writes no revision, and wins over every freshness check below (see the rule table).
  const prior = state.keys[k(env.sessionId, env.consumerId, env.idempotencyKey)];
  if (prior) {
    if (prior.contentHash !== contentHash) return refuse(state, 'KEY_CONFLICT', 'idempotencyKey ' + env.idempotencyKey + ' đã dùng cho nội dung khác (revision ' + prior.revision + ')');
    return { ok: true, revision: prior.revision, duplicate: true, kind: prior.kind, contentHash, state };
  }

  if (!acceptsKind(session.status, env.kind)) return refuse(state, 'SESSION_CLOSED', session.status);
  if (env.generation < (state.lastGeneration[consumerKey] ?? 0)) return refuse(state, 'STALE_GENERATION', 'đã thấy generation ' + state.lastGeneration[consumerKey]);

  const binding = state.bindings[consumerKey];
  if (!binding) return refuse(state, 'NOT_BOUND', 'consumer chưa đọc context');
  if (binding.generation !== env.generation) return refuse(state, 'NOT_BOUND', 'generation ' + env.generation + ' chưa đọc context (đã đọc ở generation ' + binding.generation + ')');
  if (session.contextVersion === null) return refuse(state, 'NOT_BOUND', 'cuộc họp chưa có context');
  if (binding.version !== session.contextVersion || env.contextVersion !== session.contextVersion) return refuse(state, 'STALE_CONTEXT', 'hiện tại ' + session.contextVersion + ', consumer đọc ' + binding.version + ', bản nháp ghi ' + env.contextVersion);

  const kindKey = k(env.sessionId, env.kind);
  const current = state.revisions[kindKey] ?? 0;
  if (env.expectedRevision !== current) return refuse(state, 'STALE_REVISION', 'revision hiện tại ' + current, current);

  const latest = current ? state.saved[k(env.sessionId, env.kind, current)] : undefined;
  const remember = (revision: number, extra: Partial<DraftState>): DraftState => ({
    ...state, ...extra,
    keys: { ...state.keys, [k(env.sessionId, env.consumerId, env.idempotencyKey)]: { kind: env.kind, revision, contentHash, firstSeen: now } },
    lastGeneration: { ...state.lastGeneration, [consumerKey]: maxGeneration(state, consumerKey, env.generation) },
  });
  // Same content as the latest revision under a new key: not a new revision (as savePicture). The key is remembered.
  if (latest && latest.contentHash === contentHash) return { ok: true, revision: current, duplicate: true, kind: env.kind, contentHash, state: remember(current, {}) };

  // Confirmed entries are sticky: only a confirmed entry may replace a confirmed entry; an inferred or missing one may not.
  if (latest) {
    const before = entriesOf(env.kind, latest.content), after = entriesOf(env.kind, content);
    if (before && after) for (const [entry, confirmed] of before) if (confirmed && after.get(entry) !== true) return refuse(state, 'CONFIRMED_OVERRIDE', entry);
  }

  const revision = current + 1;
  const fact: SavedFact = { sessionId: env.sessionId, kind: env.kind, revision, contentHash, content, contextVersion: env.contextVersion, authorConsumerId: env.consumerId, authorGeneration: env.generation, idempotencyKey: env.idempotencyKey, savedAt: now };
  return { ok: true, revision, duplicate: false, kind: env.kind, contentHash, state: remember(revision, { revisions: { ...state.revisions, [kindKey]: revision }, saved: { ...state.saved, [k(env.sessionId, env.kind, revision)]: fact } }) };
}

// After a timeout the caller does not know whether its save landed (UNKNOWN OUTCOME). This answers from the state, never from
// the caller's belief: saved:true means the `saved` fact exists. saved:false means it does not, so retrying admit is safe and
// cannot double-save (the same key is a replay when it landed, a fresh save when it did not). Either way nothing is lost: the
// retry carries the same content, and a different content under the same key is KEY_CONFLICT.
export type SaveOutcome = { saved: true; kind: DraftKind; revision: number; contentHash: string } | { saved: false };
export function saveOutcome(state: DraftState, sessionId: string, consumerId: string, idempotencyKey: string): SaveOutcome {
  const prior = state.keys[k(sessionId, consumerId, idempotencyKey)];
  if (!prior || !state.saved[k(sessionId, prior.kind, prior.revision)]) return { saved: false };
  return { saved: true, kind: prior.kind, revision: prior.revision, contentHash: prior.contentHash };
}

// ---- Receipts: delivered / confirmedByConsumer / actionDone -------------------------------------------------------------------
type Ref = { sessionId: string; kind: DraftKind; revision: number };
function refOf(input: any): Ref {
  return { sessionId: id(input?.sessionId, 'sessionId'), kind: oneOf<DraftKind>(input?.kind, 'kind', DRAFT_KINDS), revision: int(input?.revision, 'revision', 1) };
}
function sessionGate(state: DraftState, sessionId: string, allowClosed: boolean): StepResult | null {
  const session = state.sessions[sessionId];
  if (!session || (session.status === 'open' && state.activeSessionId !== sessionId)) return refuseStep(state, 'OTHER_SESSION');
  if (session.status === 'withdrawn' && !allowClosed) return refuseStep(state, 'SESSION_CLOSED');
  return null;
}

// The host handed revision N to a consumer (a host or transport ACK is exactly this and nothing more). Refused when that
// consumer is not bound at this generation to the context version the draft was saved under: handing content to a consumer
// that does not hold the right context is not a delivery to be counted. Never writes confirmedByConsumer.
export function markDelivered(state: DraftState, input: { sessionId: string; kind: DraftKind; revision: number; consumerId: string; generation: number }, now: number): StepResult {
  needClock(now);
  let ref: Ref, consumerId: string, generation: number;
  try { const o = obj(input, 'delivered', ['sessionId', 'kind', 'revision', 'consumerId', 'generation']); ref = refOf(o); consumerId = id(o.consumerId, 'consumerId'); generation = int(o.generation, 'generation', 0); }
  catch (error) { if (error instanceof Invalid) return refuseStep(state, 'INVALID_INPUT', error.message); throw error; }
  const gate = sessionGate(state, ref.sessionId, false); if (gate) return gate;
  const fact = state.saved[k(ref.sessionId, ref.kind, ref.revision)]; if (!fact) return refuseStep(state, 'UNKNOWN_REVISION');
  const consumerKey = k(ref.sessionId, consumerId);
  if (generation < (state.lastGeneration[consumerKey] ?? 0)) return refuseStep(state, 'STALE_GENERATION');
  const binding = state.bindings[consumerKey];
  if (!binding || binding.generation !== generation) return refuseStep(state, 'NOT_BOUND');
  if (binding.version !== fact.contextVersion) return refuseStep(state, 'STALE_CONTEXT', 'consumer đọc ' + binding.version + ', bản nháp lưu dưới ' + fact.contextVersion);
  const key = k(ref.sessionId, ref.kind, ref.revision), list = state.delivered[key] ?? [];
  if (list.some(d => d.consumerId === consumerId && d.generation === generation)) return { ok: true, duplicate: true, state };
  const entry: DeliveredFact = { ...ref, contentHash: fact.contentHash, consumerId, generation, contextVersion: fact.contextVersion, at: now };
  return { ok: true, state: { ...state, delivered: { ...state.delivered, [key]: [...list, entry] } } };
}

// THAT consumer, at THAT generation, says it got revision N of THAT content hash and THAT context version. The input is
// closed: an `ack`, `ok`, `host` or any other extra key is INVALID_INPUT. Refuses (first match):
//   unknown session OTHER_SESSION; unknown revision UNKNOWN_REVISION; hash differs WRONG_HASH; context version differs from the
//   one the draft was saved under WRONG_CONTEXT; the revision was never delivered to anyone NOT_DELIVERED; delivered only to
//   other consumers WRONG_CONSUMER; this consumer's generation is older than the last seen or than every delivery to it
//   STALE_GENERATION; that generation was never handed the draft NOT_DELIVERED.
// Allowed after the meeting ended or was withdrawn: it records what the consumer really got, it never revives anything.
// The pure function cannot tell WHO is calling: the host interface must route this call only from the consumer's own channel,
// never from a transport/host ACK (those are markDelivered).
export function confirm(state: DraftState, input: { sessionId: string; kind: DraftKind; consumerId: string; generation: number; revision: number; contentHash: string; contextVersion: string }, now: number): StepResult {
  needClock(now);
  let ref: Ref, consumerId: string, generation: number, contentHash: string, contextVersion: string;
  try {
    const o = obj(input, 'confirm', ['sessionId', 'kind', 'consumerId', 'generation', 'revision', 'contentHash', 'contextVersion']);
    ref = refOf(o); consumerId = id(o.consumerId, 'consumerId'); generation = int(o.generation, 'generation', 0);
    if (typeof o.contentHash !== 'string' || !HASH_RE.test(o.contentHash)) throw new Invalid('BAD_HASH', 'contentHash');
    contentHash = o.contentHash; contextVersion = id(o.contextVersion, 'contextVersion');
  } catch (error) { if (error instanceof Invalid) return refuseStep(state, 'INVALID_INPUT', error.message); throw error; }
  const gate = sessionGate(state, ref.sessionId, true); if (gate) return gate;
  const key = k(ref.sessionId, ref.kind, ref.revision);
  const fact = state.saved[key]; if (!fact) return refuseStep(state, 'UNKNOWN_REVISION');
  if (contentHash !== fact.contentHash) return refuseStep(state, 'WRONG_HASH');
  if (contextVersion !== fact.contextVersion) return refuseStep(state, 'WRONG_CONTEXT', 'bản nháp lưu dưới ' + fact.contextVersion);
  const handed = state.delivered[key] ?? [];
  if (!handed.length) return refuseStep(state, 'NOT_DELIVERED');
  const mine = handed.filter(d => d.consumerId === consumerId);
  if (!mine.length) return refuseStep(state, 'WRONG_CONSUMER');
  const consumerKey = k(ref.sessionId, consumerId);
  if (generation < (state.lastGeneration[consumerKey] ?? 0) || mine.every(d => d.generation > generation)) return refuseStep(state, 'STALE_GENERATION');
  if (!mine.some(d => d.generation === generation)) return refuseStep(state, 'NOT_DELIVERED', 'generation ' + generation + ' chưa được giao bản nháp này');
  const list = state.confirmed[key] ?? [];
  if (list.some(c => c.consumerId === consumerId && c.generation === generation)) return { ok: true, duplicate: true, state };
  const entry: ConfirmedFact = { ...ref, contentHash, consumerId, generation, contextVersion, at: now };
  return { ok: true, state: { ...state, confirmed: { ...state.confirmed, [key]: [...list, entry] }, lastGeneration: { ...state.lastGeneration, [consumerKey]: maxGeneration(state, consumerKey, generation) } } };
}

// The action a draft leads to was done (kinds in ACTION_KINDS only). A separate fact: it does not need, imply or produce a
// confirmedByConsumer, and nothing in the draft's content decides whether it may be recorded. `action` and `by` are plain text
// for the record; they are never run. A true fact is never refused for the session's status (the draft must exist and match).
export function markActionDone(state: DraftState, input: { sessionId: string; kind: DraftKind; revision: number; contentHash: string; action: string; by: string }, now: number): StepResult {
  needClock(now);
  let ref: Ref, contentHash: string, action: string, by: string;
  try {
    const o = obj(input, 'actionDone', ['sessionId', 'kind', 'revision', 'contentHash', 'action', 'by']);
    ref = refOf(o); action = str(o.action, 'action', 1, DRAFT_LIMITS.actionChars); by = str(o.by, 'by', 1, DRAFT_LIMITS.byChars);
    if (typeof o.contentHash !== 'string' || !HASH_RE.test(o.contentHash)) throw new Invalid('BAD_HASH', 'contentHash');
    contentHash = o.contentHash;
  } catch (error) { if (error instanceof Invalid) return refuseStep(state, 'INVALID_INPUT', error.message); throw error; }
  const gate = sessionGate(state, ref.sessionId, true); if (gate) return gate;
  if (!ACTION_KINDS.includes(ref.kind)) return refuseStep(state, 'ACTION_NOT_APPLICABLE', ref.kind);
  const key = k(ref.sessionId, ref.kind, ref.revision);
  const fact = state.saved[key]; if (!fact) return refuseStep(state, 'UNKNOWN_REVISION');
  if (contentHash !== fact.contentHash) return refuseStep(state, 'WRONG_HASH');
  const list = state.actions[key] ?? [];
  if (list.some(a => a.action === action && a.by === by)) return { ok: true, duplicate: true, state };
  return { ok: true, state: { ...state, actions: { ...state.actions, [key]: [...list, { ...ref, contentHash, action, by, at: now }] } } };
}

// The four facts side by side. No field says "done" or "ok" on their behalf.
export type Receipt = { saved: SavedFact | null; delivered: readonly DeliveredFact[]; confirmedByConsumer: readonly ConfirmedFact[]; actionDone: readonly ActionFact[] };
export function receiptOf(state: DraftState, sessionId: string, kind: DraftKind, revision: number): Receipt {
  const key = k(sessionId, kind, revision);
  return { saved: state.saved[key] ?? null, delivered: state.delivered[key] ?? [], confirmedByConsumer: state.confirmed[key] ?? [], actionDone: state.actions[key] ?? [] };
}
