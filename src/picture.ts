// The cumulative meeting picture (0.13.x, plan item 10). 23/11 OTC: the central session rewrote the WHOLE picture every 60 s batch, so
// facts it did not carry forward were lost (per-person figures present in revision 12 were gone by revision 26) and one failed save
// dropped a whole discussion. The host now keeps the cumulative part as STRUCTURED, sourced items and renders the Markdown picture
// itself; the session only sends what is new or corrected, plus the free-text "đang bàn" (what is being discussed now).
//
// Pure functions and types only: no database, no files, no clock of its own (the host stores what this file returns). Nothing here
// reads item text to decide anything except the shape rules and the invariants below.
//
// Model: every change is an immutable EVENT stored as one row (an item). Nothing is edited or deleted:
//   add   a new item {id, kind, text, sourceIds, ...}
//   fix   a NEW item with `supersedes` = the old item's id; the old item stays and is shown as "đã sửa: cũ → mới"
// Resolving a question, marking a task done or cancelled are fixes too (a status change with sources and a reason).
//
// Invariant (the analogue of CONFIRMED_OVERRIDE in drafts.ts, for the picture): an update can never drop an item or rewrite one
// silently. Structurally there is no delete and no edit-in-place; `assertNoLoss` re-checks it on the result of every update, and a fix
// must name the text it replaces (`expectedOld`), a reason and sources, so a stale or careless rewrite is refused, not applied.
import { createHash } from 'node:crypto';
import { arr, canonical, Invalid, obj, oneOf, optBlank, sourceIds as sourceIdList, str } from './drafts.js';

export const ITEM_KINDS = ['decision', 'task', 'number', 'question', 'fact'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_STATUSES = ['open', 'resolved', 'done', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemCertainty = 'firm' | 'tentative';

// Limits are per operation and per item now, not on the whole picture (which only grows with the meeting).
export const PICTURE_LIMITS = {
  itemChars: 1500, itemSources: 20, personChars: 120, deadlineChars: 200, reasonChars: 300,
  addPerUpdate: 40, fixPerUpdate: 20, dangBanChars: 4000, updateSources: 50,
  itemsPerMeeting: 3000, pageChars: 15000,
} as const;

const PREFIX: Record<ItemKind, string> = { decision: 'D', task: 'T', number: 'N', question: 'Q', fact: 'F' };
const ITEM_ID = /^[DTNQF][1-9]\d{0,5}$/;
// Which statuses a kind may carry. A decision, number or fact has none (a wrong one is corrected, not closed).
const STATUSES_OF: Record<ItemKind, readonly ItemStatus[]> = { decision: [], task: ['open', 'done', 'cancelled'], number: [], question: ['open', 'resolved'], fact: [] };

// One stored item = one immutable event. `createdRev` is the picture revision the event was saved in.
export type StoredItem = {
  id: string; kind: ItemKind; text: string; sourceIds: number[]; certainty?: ItemCertainty; person?: string; deadline?: string; status?: ItemStatus;
  createdRev: number; supersedes?: string; reason?: string;
};
export type NewItem = { kind: ItemKind; text: string; sourceIds: number[]; certainty?: ItemCertainty; person?: string; deadline?: string; status?: ItemStatus };
export type Replacement = { kind?: ItemKind; text: string; certainty?: ItemCertainty; person?: string; deadline?: string; status?: ItemStatus };
export type FixOp = { targetId: string; expectedOld: string; replacement: Replacement; sourceIds: number[]; reason: string };
export type PictureUpdate = { add: NewItem[]; fix: FixOp[]; dangBan?: string; sourceIds?: number[] };

// A refusal with a stable code and a Vietnamese sentence that says what to do. The code leads the message (as everywhere else).
export class PictureError extends Error { constructor(readonly code: string, text: string) { super(code + ': ' + text); } }

// ---- Validation (shape only; closed keys, same helpers as the other drafts) ---------------------------------------------------
const text = (value: unknown, path: string, max: number) => str(value, path, 1, max);
function itemId(value: unknown, path: string): string { if (typeof value !== 'string' || !ITEM_ID.test(value)) throw new Invalid('BAD_ID', path); return value; }

function validateNew(raw: unknown, path: string): NewItem {
  const o = obj(raw, path, ['kind', 'text', 'sourceIds'], ['certainty', 'person', 'deadline', 'status']);
  const kind = oneOf<ItemKind>(o.kind, path + '.kind', ITEM_KINDS);
  const status = o.status === undefined ? undefined : oneOf<ItemStatus>(o.status, path + '.status', ITEM_STATUSES);
  // A new item is open. Closing, resolving or cancelling is a fix: it needs a reason and a source of its own.
  if (status !== undefined && status !== 'open') throw new Invalid('BAD_VALUE', path + '.status');
  return clean({ kind, text: text(o.text, path + '.text', PICTURE_LIMITS.itemChars), sourceIds: sourceIdList(o.sourceIds, path + '.sourceIds', PICTURE_LIMITS.itemSources),
    certainty: o.certainty === undefined ? undefined : oneOf<ItemCertainty>(o.certainty, path + '.certainty', ['firm', 'tentative']),
    person: optBlank(o.person, path + '.person', PICTURE_LIMITS.personChars), deadline: optBlank(o.deadline, path + '.deadline', PICTURE_LIMITS.deadlineChars), status }) as NewItem;
}
function validateFix(raw: unknown, path: string): FixOp {
  const o = obj(raw, path, ['targetId', 'expectedOld', 'replacement', 'sourceIds', 'reason']);
  const r = obj(o.replacement, path + '.replacement', ['text'], ['kind', 'certainty', 'person', 'deadline', 'status']);
  const replacement = clean({ text: text(r.text, path + '.replacement.text', PICTURE_LIMITS.itemChars),
    kind: r.kind === undefined ? undefined : oneOf<ItemKind>(r.kind, path + '.replacement.kind', ITEM_KINDS),
    certainty: r.certainty === undefined ? undefined : oneOf<ItemCertainty>(r.certainty, path + '.replacement.certainty', ['firm', 'tentative']),
    person: optBlank(r.person, path + '.replacement.person', PICTURE_LIMITS.personChars), deadline: optBlank(r.deadline, path + '.replacement.deadline', PICTURE_LIMITS.deadlineChars),
    status: r.status === undefined ? undefined : oneOf<ItemStatus>(r.status, path + '.replacement.status', ITEM_STATUSES) }) as Replacement;
  return { targetId: itemId(o.targetId, path + '.targetId'), expectedOld: text(o.expectedOld, path + '.expectedOld', PICTURE_LIMITS.itemChars), replacement,
    sourceIds: sourceIdList(o.sourceIds, path + '.sourceIds', PICTURE_LIMITS.itemSources), reason: text(o.reason, path + '.reason', PICTURE_LIMITS.reasonChars) };
}
const clean = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export type ValidatedUpdate = { ok: true; update: PictureUpdate; contentHash: string } | { ok: false; code: string; path: string };
export function validatePictureUpdate(value: unknown): ValidatedUpdate {
  try {
    const o = obj(value, 'content', [], ['add', 'fix', 'dangBan', 'sourceIds']);
    const add = o.add === undefined ? [] : arr(o.add, 'content.add', 0, PICTURE_LIMITS.addPerUpdate).map((raw, i) => validateNew(raw, 'content.add[' + i + ']'));
    const fix = o.fix === undefined ? [] : arr(o.fix, 'content.fix', 0, PICTURE_LIMITS.fixPerUpdate).map((raw, i) => validateFix(raw, 'content.fix[' + i + ']'));
    const dangBan = o.dangBan === undefined ? undefined : text(o.dangBan, 'content.dangBan', PICTURE_LIMITS.dangBanChars);
    const extra = o.sourceIds === undefined ? [] : sourceIdList(o.sourceIds, 'content.sourceIds', PICTURE_LIMITS.updateSources);
    if (!add.length && !fix.length && dangBan === undefined) throw new Invalid('EMPTY_UPDATE', 'content');
    const all = sourcesOf({ add, fix, sourceIds: extra });
    if (!all.length) throw new Invalid('NO_SOURCES', 'content.sourceIds');   // an update with only "đang bàn" still names the rows it was written from
    const update: PictureUpdate = { add, fix, ...(dangBan !== undefined ? { dangBan } : {}), ...(extra.length ? { sourceIds: extra } : {}) };
    return { ok: true, update, contentHash: createHash('sha256').update('pma-picture-update/1\n' + canonical(update)).digest('hex') };
  } catch (error) { if (error instanceof Invalid) return { ok: false, code: error.code, path: error.path }; throw error; }
}
// Every source the update cites (items, fixes, and the update's own list): what its coverage and its sources check are computed from.
export const sourcesOf = (u: PictureUpdate): number[] => [...new Set([...u.add.flatMap(i => i.sourceIds), ...u.fix.flatMap(f => f.sourceIds), ...(u.sourceIds ?? [])])].sort((a, b) => a - b);

// ---- Applying an update (pure) --------------------------------------------------------------------------------------------
const norm = (s: string) => s.normalize('NFC').trim();
const sameText = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase();
export const supersededIds = (items: readonly StoredItem[]) => new Set(items.flatMap(i => (i.supersedes ? [i.supersedes] : [])));
export const liveItems = (items: readonly StoredItem[]) => { const gone = supersededIds(items); return items.filter(i => !gone.has(i.id)); };

function nextId(items: readonly StoredItem[], kind: ItemKind): string {
  const p = PREFIX[kind]; let max = 0;
  for (const i of items) if (i.id.startsWith(p)) max = Math.max(max, Number(i.id.slice(1)));
  return p + (max + 1);
}

export type PlannedUpdate = { events: StoredItem[]; added: { id: string; kind: ItemKind }[]; fixed: { targetId: string; newId: string }[]; skipped: string[] };
// `items` = everything stored so far (oldest first); `revision` = the revision this update will be saved as. Throws PictureError.
export function planUpdate(items: readonly StoredItem[], update: PictureUpdate, revision: number): PlannedUpdate {
  const work: StoredItem[] = [...items]; const events: StoredItem[] = []; const added: PlannedUpdate['added'] = []; const fixed: PlannedUpdate['fixed'] = []; const skipped: string[] = [];
  if (items.length + update.add.length + update.fix.length > PICTURE_LIMITS.itemsPerMeeting) throw new PictureError('PICTURE_TOO_MANY_ITEMS', `bức tranh đã có ${items.length} mục, quá ${PICTURE_LIMITS.itemsPerMeeting}; báo người dùng, không tự bỏ bớt`);
  for (const item of update.add) {
    // The same item sent twice (a retry under a new key) is not added twice.
    const twin = liveItems(work).find(i => i.kind === item.kind && sameText(i.text, item.text));
    if (twin) { skipped.push(twin.id); continue; }
    const stored: StoredItem = { ...item, id: nextId(work, item.kind), createdRev: revision };
    work.push(stored); events.push(stored); added.push({ id: stored.id, kind: stored.kind });
  }
  for (const [n, op] of update.fix.entries()) {
    const at = `fix[${n}] ${op.targetId}`;
    const target = work.find(i => i.id === op.targetId);
    if (!target) throw new PictureError('PICTURE_FIX_TARGET_UNKNOWN', `${at}: không có mục ${op.targetId}; đọc lại pma picture (mã mục in trong ngoặc vuông)`);
    const successor = work.find(i => i.supersedes === target.id);
    if (successor) throw new PictureError('PICTURE_FIX_TARGET_SUPERSEDED', `${at}: mục này đã được sửa thành ${successor.id} (“${successor.text}”); sửa ${successor.id}, đọc lại pma picture rồi gộp`);
    if (!sameText(op.expectedOld, target.text)) throw new PictureError('PICTURE_FIX_OLD_MISMATCH', `${at}: nội dung cũ bạn nêu không khớp mục đang có (“${target.text}”); đọc lại pma picture rồi gộp, không sửa theo trí nhớ`);
    const r = op.replacement;
    if (r.kind !== undefined && r.kind !== target.kind) throw new PictureError('PICTURE_FIX_KIND_CHANGE', `${at}: không đổi loại mục (${target.kind} → ${r.kind}); thêm mục mới đúng loại và sửa mục này nếu cần`);
    const status = r.status ?? target.status;
    if (status !== undefined && status !== 'open' && !STATUSES_OF[target.kind].includes(status)) throw new PictureError('PICTURE_FIX_BAD_STATUS', `${at}: loại ${target.kind} không có trạng thái ${status}`);
    // What the replacement leaves out is carried over, so a fix of the text cannot drop the person, the deadline or the certainty.
    const next: StoredItem = { id: nextId(work, target.kind), kind: target.kind, text: norm(r.text), sourceIds: op.sourceIds, createdRev: revision, supersedes: target.id, reason: op.reason,
      ...(r.certainty ?? target.certainty ? { certainty: (r.certainty ?? target.certainty)! } : {}), ...(r.person ?? target.person ? { person: (r.person ?? target.person)! } : {}),
      ...(r.deadline ?? target.deadline ? { deadline: (r.deadline ?? target.deadline)! } : {}), ...(status !== undefined ? { status } : {}) };
    if (norm(next.text) === norm(target.text) && next.certainty === target.certainty && next.person === target.person && next.deadline === target.deadline && next.status === target.status)
      throw new PictureError('PICTURE_FIX_NO_CHANGE', `${at}: bản sửa giống hệt mục hiện có`);
    work.push(next); events.push(next); fixed.push({ targetId: target.id, newId: next.id });
  }
  assertNoLoss(items, work);
  return { events, added, fixed, skipped };
}

// ---- The invariant: nothing earlier is dropped or silently rewritten ------------------------------------------------------------
const same = (a: StoredItem, b: StoredItem) => canonical(a) === canonical(b);
export function assertNoLoss(before: readonly StoredItem[], after: readonly StoredItem[]): void {
  const byId = new Map(after.map(i => [i.id, i])); if (byId.size !== after.length) throw new PictureError('PICTURE_ITEM_OVERRIDE', 'hai mục trùng mã');
  for (const old of before) {
    const now = byId.get(old.id);
    if (!now) throw new PictureError('PICTURE_ITEM_LOST', `mục ${old.id} bị mất khỏi bức tranh`);
    if (!same(old, now)) throw new PictureError('PICTURE_ITEM_OVERRIDE', `mục ${old.id} bị viết đè; chỉ được sửa bằng bản sửa mới (đã sửa: cũ → mới)`);
  }
  const known = new Set(before.map(i => i.id)); const replaced = new Map<string, string>();
  for (const i of after) if (!known.has(i.id) && i.supersedes) {
    if (!byId.has(i.supersedes)) throw new PictureError('PICTURE_ITEM_OVERRIDE', `${i.id} sửa một mục không có (${i.supersedes})`);
    if (replaced.has(i.supersedes) || before.some(b => b.supersedes === i.supersedes)) throw new PictureError('PICTURE_ITEM_OVERRIDE', `mục ${i.supersedes} bị sửa hai lần cùng lúc`);
    replaced.set(i.supersedes, i.id);
  }
}

// ---- Rendering (Markdown the readers see) -------------------------------------------------------------------------------------------
const ids = (list: readonly number[]) => '#' + list.join(', #');
function line(i: StoredItem): string {
  const tag = i.status === 'done' ? '[xong] ' : i.status === 'cancelled' ? '[huỷ] ' : '';
  const meta = [i.person ? 'người: ' + i.person : '', i.deadline ? 'hạn: ' + i.deadline : '', i.certainty === 'tentative' ? 'tạm' : ''].filter(Boolean).join(' · ');
  return `- [${i.id}] ${tag}${i.text}${meta ? ' — ' + meta : ''} (${ids(i.sourceIds)})`;
}
// Corrections of a live item, newest first: “đã sửa: cũ → mới”.
function history(i: StoredItem, byId: Map<string, StoredItem>): string[] {
  const out: string[] = [];
  for (let cur: StoredItem | undefined = i; cur?.supersedes;) {
    const prev = byId.get(cur.supersedes); if (!prev) break;
    out.push(`  ↳ đã sửa (bản ${cur.createdRev}): “${prev.text}” → “${cur.text}” — lý do: ${cur.reason ?? '?'} (${ids(cur.sourceIds)})`); cur = prev;
  }
  return out;
}
const SECTIONS: { title: string; pick: (i: StoredItem) => boolean }[] = [
  { title: 'Đã chốt (quyết định)', pick: i => i.kind === 'decision' },
  { title: 'Việc – người – hạn', pick: i => i.kind === 'task' },
  { title: 'Số liệu', pick: i => i.kind === 'number' },
  { title: 'Câu hỏi mở', pick: i => i.kind === 'question' && i.status !== 'resolved' },
  { title: 'Câu hỏi đã có trả lời', pick: i => i.kind === 'question' && i.status === 'resolved' },
  { title: 'Ghi nhận khác', pick: i => i.kind === 'fact' },
];
export type RenderInput = { revision: number; purpose?: { label: string; rule?: string }; dangBan?: string; items: readonly StoredItem[]; legacy?: { revision: number; text: string } };
export function renderPicture(input: RenderInput): string {
  const items = [...input.items]; const byId = new Map(items.map(i => [i.id, i])); const live = liveItems(items); const corrections = items.filter(i => i.supersedes).length;
  const rootOf = (i: StoredItem) => { let cur = i; while (cur.supersedes && byId.has(cur.supersedes)) cur = byId.get(cur.supersedes)!; return items.indexOf(cur); };
  const counts = ITEM_KINDS.map(k => [k, live.filter(i => i.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${({ decision: 'quyết định', task: 'việc', number: 'số liệu', question: 'câu hỏi', fact: 'ghi nhận' })[k]}`);
  const out = [`Bản ${input.revision} · ${live.length} mục đang dùng${counts.length ? ' (' + counts.join(', ') + ')' : ''} · ${corrections} lần đính chính. Chỉ mục lục chưa kiểm: RAW và nghe lại mới là gốc.`, ''];
  out.push(`## Mục đích họp`, input.purpose ? `${input.purpose.label}${input.purpose.rule ? ' — ' + input.purpose.rule : ''}` : 'chưa chọn (pma purpose)', '');
  out.push('## Đang bàn', input.dangBan?.trim() || '(chưa ghi)', '');
  for (const section of SECTIONS) {
    const rows = live.filter(section.pick).sort((a, b) => rootOf(a) - rootOf(b)); if (!rows.length) continue;
    out.push(`## ${section.title}`); for (const i of rows) out.push(line(i), ...history(i, byId)); out.push('');
  }
  if (input.legacy) out.push(`## Bản viết tay trước đó (bản ${input.legacy.revision}; chưa tách thành mục có nguồn, giữ nguyên để không mất)`, input.legacy.text, '');
  return out.join('\n').trimEnd() + '\n';
}

// What a reader of the whole thing gets as data: the live items with their correction history (oldest first).
export function describeItems(items: readonly StoredItem[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  return liveItems(items).map(i => {
    const past: { id: string; text: string; reason?: string; sourceIds: number[]; rev: number }[] = [];
    for (let cur: StoredItem | undefined = i; cur?.supersedes;) { const prev = byId.get(cur.supersedes); if (!prev) break; past.unshift({ id: prev.id, text: prev.text, ...(cur.reason ? { reason: cur.reason } : {}), sourceIds: cur.sourceIds, rev: cur.createdRev }); cur = prev; }
    return { ...i, history: past };
  });
}

// Pages for reading a big picture: whole lines, nothing cut or left out; a single line longer than a page is split, never dropped.
export function pagesOf(body: string, size: number = PICTURE_LIMITS.pageChars): string[] {
  const pages: string[] = []; let page = '';
  for (const raw of body.split('\n')) {
    for (let rest = raw; ; ) {
      const piece = rest.slice(0, size); rest = rest.slice(size);
      if (page && page.length + piece.length + 1 > size) { pages.push(page); page = ''; }
      page += (page ? '\n' : '') + piece; if (!rest) break;
      pages.push(page); page = '';
    }
  }
  if (page || !pages.length) pages.push(page);
  return pages;
}
