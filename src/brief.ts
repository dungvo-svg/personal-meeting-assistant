// `pma brief`: the pre-meeting context a new Claude session reads first. Who the owner is, what the meeting is, who attends
// and in which language, which names ASR mishears, plus ONE status line. Markdown, at most 2 KB (bytes, not characters:
// Vietnamese is multi-byte). Read-only: it changes nothing and works at any point of a meeting.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingRuntime } from './runtime.js';
import type { GlossaryEntry } from './text.js';
import { audioDir } from './audio.js';
import { loadOwner, type Owner } from './owner.js';
import type { Participant } from './participants.js';
import { purposeOf } from './purpose.js';

export const BRIEF_MAX_BYTES = 2048;
const AGENDA_MAX_BYTES = 520;

export type BriefInput = {
  owner: Owner | null;
  session: { title: string; ended: string | null; languages?: string[]; context?: any } | null;
  glossary: GlossaryEntry[];
  captureState?: string; unread?: number; lastError?: string | null; minutesRecorded?: number | null;
  picture?: { revision: number; savedAt: string } | null;
};

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
// Longest prefix of `text` within `max` bytes, cut on a character and marked with an ellipsis.
function clipBytes(text: string, max: number) {
  if (bytes(text) <= max) return text;
  let out = ''; for (const ch of text) { if (bytes(out + ch + '…') > max) break; out += ch; }
  return out.trimEnd() + '…';
}
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const clock = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour12: false, hour: '2-digit', minute: '2-digit' });
// Items joined while they fit in `budget` bytes; the count left out is returned so the line can say so.
function take(items: string[], budget: number, separator: string) {
  let text = ''; let used = 0;
  for (const item of items) { const next = text ? text + separator + item : item; if (bytes(next) > budget) break; text = next; used++; }
  return { text, left: items.length - used };
}
const STATES: Record<string, string> = { LISTENING: 'đang nghe', OFF: 'không nghe', WARMING: 'đang nạp mô hình', LOADING_ASR: 'đang nạp mô hình', WARM_READY: 'sẵn sàng nghe', WAITING_FOR_SOURCE: 'chờ nguồn tiếng' };

export function buildBrief(input: BriefInput, maxBytes = BRIEF_MAX_BYTES) {
  const { owner, session, glossary } = input; const context = session?.context ?? {};
  // The purpose is the FIRST line (0.13.0): it leads how everything below is read. Not known yet: say so, so it is settled before the picture.
  const purpose = purposeOf(context.purpose);
  const head: string[] = session ? [purpose ? `**Mục đích họp:** ${purpose.label} — ${purpose.rule}` : '**Mục đích họp:** chưa rõ — xác định từ lời mời hoặc hỏi chủ một lần (pma purpose thong-bao|huong-dan|giao-viec|ban-quyet-dinh)'] : [];
  head.push('# Brief họp (context trước họp, chỉ đọc)');
  const me = owner?.name ?? context.me;
  if (me || owner) {
    const who = [me, owner?.role, owner?.company].filter(Boolean).join(' · ');
    const extra = [owner?.languages?.length ? 'nói ' + owner.languages.join(', ') : '', owner?.addressedAs?.length ? 'mọi người gọi: ' + owner.addressedAs.join(', ') : ''].filter(Boolean);
    head.push(`**Tôi:** ${[who, ...extra].filter(Boolean).join(' · ')}`);
  } else head.push('**Tôi:** chưa biết (pma start --me "Tên")');
  if (session) {
    const meeting = context.meeting?.meetingId ? (context.meeting.platform === 'meet' ? 'Google Meet ' : 'Zoom ') + context.meeting.meetingId : undefined;
    head.push('**Họp:** ' + [clipBytes(oneLine(session.title), 110), meeting, context.scheduledStart ? 'lịch ' + clock(context.scheduledStart) : undefined, session.languages?.length ? 'ngôn ngữ ' + session.languages.join('/') : undefined].filter(Boolean).join(' · '));
  } else head.push('**Họp:** chưa có phiên họp (pma start …)');

  // Status goes last and always survives; the body gives way to it.
  const state = !session ? 'chưa có phiên' : session.ended ? 'phiên đã kết thúc' : STATES[input.captureState ?? ''] ?? input.captureState ?? 'không rõ';
  const status = '**Tình trạng:** ' + [state,
    input.minutesRecorded != null ? `đã ghi ${input.minutesRecorded} phút` : undefined,
    input.unread != null && session && !session.ended ? `chưa đọc ${input.unread} đoạn` : undefined,
    session && !session.ended ? (input.lastError ? 'lỗi cuối: ' + clipBytes(oneLine(input.lastError), 110) : 'không lỗi') : undefined,
    input.picture ? `bức tranh bản ${input.picture.revision} lúc ${clock(input.picture.savedAt)} (pma picture)` : undefined].filter(Boolean).join(' · ');

  const agenda = typeof context.agenda === 'string' && context.agenda.trim() ? clipBytes(oneLine(context.agenda), AGENDA_MAX_BYTES) : '';
  const participants: Participant[] = Array.isArray(context.participants) ? context.participants : [];
  const people = participants.map(p => `- ${[p.name, p.role].filter(Boolean).join(' — ')}${p.languages?.length ? ' · ' + p.languages.join('/') : ''}`);
  // The rest of the name table (item 8): people spoken about but not in the meeting, nicknames ("Ta = Tar"), system names.
  const NAME_LABELS: Record<string, string> = { mentioned: 'được nhắc, không dự', system: 'hệ thống' };
  const others: string[] = (Array.isArray(context.names) ? context.names as Participant[] : []).map(n => n.kind === 'alias' ? `${n.name} = ${n.of ?? '?'}` : `${n.name} (${NAME_LABELS[n.kind ?? ''] ?? n.kind})`);
  // People first, then everything else the glossary knows, as "Name (hay nghe: a, b)".
  const named = new Set(participants.map(p => p.name.toLowerCase()));
  const terms = [...glossary.filter(e => named.has(e.name.toLowerCase())), ...glossary.filter(e => !named.has(e.name.toLowerCase()))]
    .map(e => e.variants.length ? `${e.name} (hay nghe: ${e.variants.slice(0, 4).join(', ')})` : e.name);

  const fixed = bytes([...head, status].join('\n')) + 2;
  let room = maxBytes - fixed - 80; // 80: section titles and "…" markers
  const body: string[] = [];
  if (agenda) { body.push('**Chương trình/mục tiêu (trích):** ' + agenda); room -= bytes(agenda); }
  if (people.length) {
    const shown = take(people, Math.max(0, Math.floor(room * 0.6)), '\n'); room -= bytes(shown.text);
    if (shown.text) body.push(`**Người dự (${people.length}):**\n${shown.text}${shown.left ? `\n- … và ${shown.left} người nữa (pma context)` : ''}`);
  }
  if (others.length) {
    const shown = take(others, Math.max(0, Math.floor(room * 0.5)), '; '); room -= bytes(shown.text);
    if (shown.text) body.push(`**Được nhắc / biệt danh / hệ thống (${others.length}):** ${shown.text}${shown.left ? `; … +${shown.left}` : ''}`);
  }
  if (terms.length) {
    const shown = take(terms, Math.max(0, room), '; ');
    if (shown.text) body.push(`**Tên/thuật ngữ cần để ý:** ${shown.text}${shown.left ? `; … +${shown.left}` : ''}`);
  }
  // Hard guard: whatever the inputs were, the whole is within the limit and ends with the status line.
  const top = clipBytes([...head, ...body].join('\n'), maxBytes - bytes(status) - 2); // 2: the newline before the status and the final one
  return top + '\n' + status + '\n';
}

// Minutes of audio the recorder's timeline covers (first to last line), or while listening without a timeline, minutes since
// listening began. Null when nothing was recorded.
function minutesRecorded(dataDir: string, sessionId: string, captureInfo: any, now = Date.now()) {
  try {
    const path = join(audioDir(dataDir, sessionId), 'timeline.jsonl');
    if (existsSync(path)) {
      const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      const opened = rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(r => r && r.type !== 'mic_state' && Number.isFinite(Date.parse(r.t)));
      if (opened.length > 1) return Math.max(0, Math.round((Date.parse(opened.at(-1).t) - Date.parse(opened[0].t)) / 60000));
    }
  } catch { /* fall through */ }
  const since = Date.parse(captureInfo?.listeningSince ?? '');
  return Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 60000)) : null;
}

// Gathers what the brief needs from the running runtime. `sessionId` picks an older session; without it, the current one.
export function composeBrief(runtime: MeetingRuntime, root: string, sessionId?: string) {
  const owner = loadOwner(root);
  const current = runtime.session;
  if (sessionId && sessionId !== current?.id) {
    const row: any = runtime.db.prepare('SELECT title,ended,context FROM sessions WHERE id=?').get(sessionId);
    if (!row) throw new Error('SESSION_NOT_FOUND');
    const context = JSON.parse(row.context);
    return buildBrief({ owner, glossary: runtime.glossary, session: { title: row.title, ended: row.ended, languages: context.languages, context }, minutesRecorded: minutesRecorded(runtime.dataDir, sessionId, null) });
  }
  if (!current) return buildBrief({ owner, glossary: runtime.glossary, session: null });
  const compact = runtime.compact();
  return buildBrief({ owner, glossary: runtime.glossary, session: { title: current.title, ended: current.ended, languages: current.languages, context: current.context }, captureState: compact.captureState, unread: compact.unread, lastError: compact.lastError, minutesRecorded: minutesRecorded(runtime.dataDir, current.id, compact.captureInfo), picture: runtime.picture(current.id) });
}
