// What the meeting window showed (tools/meeting_screen.ps1 → <audio dir>/screen/screen.jsonl): who Zoom outlined as speaking, who
// shared and when, frames of the shared screen. Built and tried live in the 21/11 tender meeting. The CLI only reads that file:
// names go on transcript lines, share events and frames are printed by `follow`. Nothing here talks to the host.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type ScreenEvent = { at: string; utc: string; type: string; name?: string; by?: string | null; file?: string; tab?: string; window?: string; message?: string; note?: string; diff?: number; self?: boolean; reason?: string; panel?: boolean; app?: string; mode?: string; title?: string };

// An outline older than this names nobody (Zoom outlines only while it hears someone).
const STALE_MS = 30000;
export const screenDir = (audioDir: string) => `${audioDir.split('\\').join('/')}/screen`;

let cache: { file: string; mtime: number; size: number; events: ScreenEvent[] } | null = null;
export function screenEvents(audioDir?: string): ScreenEvent[] {
  if (!audioDir) return [];
  const file = `${screenDir(audioDir)}/screen.jsonl`;
  if (!existsSync(file)) return [];
  const { mtimeMs, size } = statSync(file);
  if (cache && cache.file === file && cache.mtime === mtimeMs && cache.size === size) return cache.events;
  const events = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).flatMap(line => { try { return line.trim() ? [JSON.parse(line.replace(/^\uFEFF/, ''))] : []; } catch { return []; } });
  cache = { file, mtime: mtimeMs, size, events };
  return events;
}

// Names as OCR reads them are noisy (live 21/11): the mic icon read as "%" ("% Trang HN"), letters dropped ("% Mr - NNC Hå Nöi" next
// to "Mr Dirc - NNC Hå Nöi"), Vietnamese marks lost with the en-US engine. clean() drops the junk, nameKey() compares without marks,
// similar keys are one person shown by the most frequent spelling, and screen/names.json (`pma screen name`) gives the right one.
export function cleanName(raw: string): string {
  return raw.normalize('NFC').split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word) || word === '-').join(' ').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s-]+$/u, '').trim();
}
export function nameKey(name: string): string {
  return cleanName(name).normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const cur = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  }
  return row[b.length];
}
// One person: equal keys, or keys apart by at most 30% of the longer one (and at least 4 letters each, so "An" never swallows "Anh").
export function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return distance(a, b) <= Math.floor(0.3 * Math.max(a.length, b.length));
}
export function loadNames(audioDir?: string): Record<string, string> {
  if (!audioDir) return {};
  try { return JSON.parse(readFileSync(`${screenDir(audioDir)}/names.json`, 'utf8')); } catch { return {}; }
}
export function saveName(audioDir: string, seen: string, right: string) {
  const names = loadNames(audioDir);
  const key = nameKey(seen);
  if (!key || !cleanName(right)) throw new Error('pma screen name "<tên máy đọc>" "<tên đúng>"');
  names[key] = cleanName(right);
  mkdirSync(screenDir(audioDir), { recursive: true });
  writeFileSync(`${screenDir(audioDir)}/names.json`, JSON.stringify(names, null, 2));
  return { saved: true, seen: cleanName(seen), right: names[key], key };
}
// The shown name of each OCR reading, for this meeting's readings.
export function nameResolver(events: ScreenEvent[], fixed: Record<string, string>): (raw: string) => string {
  const counts = new Map<string, number>();
  for (const e of events) if (e.type === 'speaker' && e.name) { const n = cleanName(e.name); if (n) counts.set(n, (counts.get(n) ?? 0) + 1); }
  const fixedKeys = Object.keys(fixed);
  const spellings = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const memo = new Map<string, string>();
  return (raw: string) => {
    const name = cleanName(raw); const key = nameKey(name);
    if (!key) return name;
    if (memo.has(key)) return memo.get(key)!;
    const right = fixed[key] ?? fixedKeys.filter(k => sameName(k, key)).map(k => fixed[k])[0];
    const shown = right ?? spellings.find(s => sameName(nameKey(s), key)) ?? name;
    memo.set(key, shown);
    return shown;
  };
}

// Where a line lies in real time: its chunk's start (wall) plus the sentence's own range when the worker wrote it (SEG_RANGE a-b,
// Whisper segment times, 21/11). Older lines have only the chunk's range: split by text length, an estimate.
const SEG_RANGE = /SEG_RANGE (\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/;
export function lineTimes(items: any[]): Map<number, { from: number; to: number; estimated: boolean }> {
  const times = new Map<number, { from: number; to: number; estimated: boolean }>();
  const chunks = new Map<string, any[]>();
  for (const item of items) {
    if (!item.wall || item.origin === 'system_gap') continue;
    const key = `${item.wall}|${item.start}|${item.end}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key)!.push(item);
  }
  for (const group of chunks.values()) {
    const base = Date.parse(group[0].wall);
    if (!Number.isFinite(base)) continue;
    const total = group.reduce((n, item) => n + String(item.text ?? '').length, 0) || 1;
    const duration = Math.max(0, (Number(group[0].end) - Number(group[0].start)) * 1000) || 0;
    let at = base;
    for (const item of group) {
      const share = duration * String(item.text ?? '').length / total;
      const range = SEG_RANGE.exec(item.boundary ?? '');
      if (range) times.set(item.id, { from: base + Number(range[1]) * 1000, to: base + Number(range[2]) * 1000, estimated: false });
      else times.set(item.id, { from: at, to: at + share, estimated: group.length > 1 });
      at += share;
    }
  }
  return times;
}

// The speaker of each line from the outline Zoom drew during that line. Microphone lines are the owner's and get no Zoom name. A
// change of outline inside a line gives every name ("A→B"); no outline in the last 30 s gives none (never a guess).
export function speakersOf(items: any[], events: ScreenEvent[], isMic: (item: any) => boolean, fixed: Record<string, string> = {}): Map<number, string> {
  const shown = nameResolver(events, fixed);
  const marks = events.filter(e => e.type === 'speaker' && e.name).map(e => ({ t: Date.parse(e.utc), name: shown(e.name as string) })).filter(m => Number.isFinite(m.t) && m.name).sort((a, b) => a.t - b.t);
  const names = new Map<number, string>();
  if (!marks.length) return names;
  const times = lineTimes(items);
  for (const item of items) {
    const time = times.get(item.id);
    if (!time || isMic(item)) continue;
    const { from, to } = time;
    let i = -1;
    for (let lo = 0, hi = marks.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (marks[mid].t <= from) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    const who: string[] = [];
    if (i >= 0 && from - marks[i].t <= STALE_MS) who.push(marks[i].name);
    for (let j = i + 1; j < marks.length && marks[j].t <= to; j++) if (who.at(-1) !== marks[j].name) who.push(marks[j].name);
    if (who.length) names.set(item.id, who.join('→'));
  }
  return names;
}
// ---- Google Meet captions (0.13.10). tools/meeting_screen.ps1 logs the page text that is new each tick to screen/meet_text.jsonl, each
// string with the one before it on the page. With the owner's captions on, a caption is the speaker's tile name followed by the words,
// and the words grow and are rewritten while the person speaks. Real meeting 25/11: Meet's captions caught a line the ASR lost and
// named the speaker of each, while the RAW had no names and the shared minutes put one participant's answer in another's mouth.
// Here the log becomes caption lines {first, last, speaker, text}: page chrome (buttons, menus,
// tile tools) is dropped, a rewritten line keeps its first time and takes its newest words.
// `early`: already on the page when the log began (its first time is when the watcher started, not when it was said).
export type CaptionLine = { first: number; last: number; speaker: string; self: boolean; text: string; early?: boolean };
// Meet's own strings, Vietnamese and English UI (owner 25/11 uses Vietnamese; guests may use English). A string that is not a caption
// but slips through still needs a speaker before it to count, and repeats of the same string are dropped below.
// Long labels by their start; short ones ("Đóng", "Mọi người") only as the whole string, since a caption may begin with the same words
// ("Mọi người cùng xem…").
const MEET_UI = /^(Ghim video của|Bỏ ghim video|Tắt tiếng micrô|Bật tiếng micrô|Tu[ỳỷ] chọn khác cho|Bạn không thể bật|Hiển thị trong ô|Chế độ cài đặt âm|Micrô: |Loa: |Máy ảnh: |Gửi biểu tượng cảm xúc|Biểu tượng cảm xúc khác|Trò chuyện với mọi người|Bộ điều khiển của người tổ chức|Mở Gemini trong|Ghi chú bằng Gemini|Ảnh hồ sơ của|Vào chế độ toàn màn hình|Thoát chế độ toàn màn hình|Người tham gia bên ngoài|Meet - |Cuộc gọi này dành cho|Use the new |Có quyền truy cập|Pin .+ to your main screen|Unpin |Mute .+['’]s microphone|More options for|You can't (unmute|remotely)|Leave call$|Chat with everyone|Host controls|Turn (on|off) (camera|microphone|captions)|Send a reaction|Take notes with Gemini|Open Gemini|Profile picture|Remove this tile|External participants|Micrô của bạn đang tắt|Your microphone is off)/i;
const MEET_UI_EXACT = new Set(['nền và hiệu ứng', 'kiểm soát cuộc gọi', 'chia sẻ màn hình', 'rời khỏi cuộc gọi', 'công cụ cuộc họp', 'thẻ mới', 'hỏi gemini', 'xóa ô này', 'chi tiết về cuộc họp', 'ngôn ngữ trong cuộc họp', 'loại phụ đề', 'phụ đề trực tiếp', 'cỡ chữ', 'màu phông chữ', 'bật máy ảnh', 'tắt máy ảnh', 'bật micrô', 'tắt micrô', 'giơ tay', 'hạ tay', 'mọi người', 'thu nhỏ', 'khôi phục', 'đóng', 'quay lại', 'chuyển tiếp', 'tải lại', 'thanh địa chỉ và tìm kiếm', 'cài đặt google meet', 'đánh dấu thẻ này', 'tiện ích', 'công việc', 'chrome', 'add claude', 'tự động', 'backgrounds and effects', 'meeting tools', 'raise hand', 'lower hand', 'present now', 'captions', 'meeting details', 'audio settings', 'reactions', 'call controls', 'settings', 'people', 'chat', 'close', 'minimize', 'restore', 'back', 'forward', 'reload', 'extensions', 'bảng điều khiển bên trái', 'bảng điều khiển bên phải', 'đang lắng nghe…', 'đang lắng nghe...', 'không có bản dịch', 'listening…', 'listening...', 'no translation', 'thao tác khác', 'more actions']);
const SELF_NAMES = new Set(['bạn', 'you']);
// Tile names, from the tile tools Meet puts on the page for each person ("Ghim video của <tên> vào màn hình chính").
const ROSTER = [/^Ghim video của (.+?) vào màn hình chính$/i, /^Tắt tiếng micrô của (.+)$/i, /^Tu[ỳỷ] chọn khác cho (.+)$/i, /^Pin (.+?) to your main screen$/i, /^Mute (.+?)['’]s microphone$/i, /^More options for (.+)$/i];
const firstWords = (text: string, n = 3) => text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, n).join(' ');
export function parseMeetCaptions(records: { utc: string; texts: { text: string; before: string | null }[] }[]): { lines: CaptionLine[]; roster: string[] } {
  const roster = new Set<string>(); const lines: CaptionLine[] = []; const byText = new Map<string, CaptionLine>(); const seen = new Map<string, number>();
  for (const record of records) for (const { text } of record.texts ?? []) for (const pattern of ROSTER) { const m = pattern.exec(String(text ?? '').trim()); if (m) roster.add(m[1].trim()); }
  const isName = (s: string) => roster.has(s) || SELF_NAMES.has(s.toLowerCase());
  let opening = true;
  for (const record of records) {
    const t = Date.parse(record.utc); if (!Number.isFinite(t)) continue;
    for (const item of record.texts ?? []) {
      const text = String(item.text ?? '').trim(); const before = String(item.before ?? '').trim();
      if (!text || MEET_UI.test(text) || MEET_UI_EXACT.has(text.toLowerCase()) || isName(text) || /^\d{1,2}:\d{2}$/.test(text) || ![...text].some(c => /\p{L}/u.test(c))) continue;
      const count = (seen.get(text) ?? 0) + 1; seen.set(text, count); if (count > 2) continue;  // a string back again and again is page chrome
      // Who says it: the tile name just before it, or the caption line it continues.
      const from = byText.get(before);
      const speaker = isName(before) ? before : from?.speaker;
      if (speaker === undefined) continue;
      const self = isName(before) ? SELF_NAMES.has(before.toLowerCase()) : !!from?.self;
      // The same line rewritten while the person speaks: same speaker, same first words, seen in the last 30 s.
      const head = firstWords(text);
      const same = [...lines].reverse().find(line => line.speaker === speaker && t - line.last <= 30000 && head.length > 0 && (firstWords(line.text) === head || line.text.startsWith(text) || text.startsWith(line.text)));
      if (same) { if (text.length >= same.text.length || !same.text.startsWith(text)) same.text = text; same.last = t; byText.set(text, same); continue; }
      const line: CaptionLine = { first: t, last: t, speaker, self, text, ...(opening ? { early: true } : {}) }; lines.push(line); byText.set(text, line);
    }
    opening = false;
  }
  return { lines, roster: [...roster] };
}
let captionCache: { file: string; mtime: number; size: number; result: { lines: CaptionLine[]; roster: string[] } } | null = null;
export function meetCaptions(audioDir?: string): { lines: CaptionLine[]; roster: string[] } {
  const empty = { lines: [], roster: [] };
  if (!audioDir) return empty;
  const file = `${screenDir(audioDir)}/meet_text.jsonl`;
  if (!existsSync(file)) return empty;
  const { mtimeMs, size } = statSync(file);
  if (captionCache && captionCache.file === file && captionCache.mtime === mtimeMs && captionCache.size === size) return captionCache.result;
  const records = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).flatMap(line => { try { return line.trim() ? [JSON.parse(line.replace(/^﻿/, ''))] : []; } catch { return []; } });
  const result = parseMeetCaptions(records);
  captionCache = { file, mtime: mtimeMs, size, result };
  return result;
}
// A caption is on screen a second or two after the words are said: a line covers [first - LEAD, last].
const CAPTION_LEAD_MS = 2500; const CAPTION_TAIL_MS = 1000;
// The speaker of each transcript line from the Meet captions shown while it was said ("A→B" when the captions change hands inside it).
// Microphone lines are the owner's. No caption during the line gives no name (never a guess).
export function captionSpeakersOf(items: any[], captions: CaptionLine[], isMic: (item: any) => boolean, _me?: string): Map<number, string> {
  const names = new Map<number, string>(); if (!captions.length) return names;
  const times = lineTimes(items);
  for (const item of items) {
    const time = times.get(item.id); if (!time || isMic(item)) continue;
    const who: string[] = [];
    // The owner's own captions never name a speaker-channel line: the owner's voice is on the microphone, not in what the speakers play.
    for (const line of captions) if (!line.early && !line.self && line.first - CAPTION_LEAD_MS <= time.to && line.last + CAPTION_TAIL_MS >= time.from && !who.includes(line.speaker)) who.push(line.speaker);
    if (who.length) names.set(item.id, who.join('→'));
  }
  return names;
}
const hhmmss = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour12: false });
export function captionLine(line: CaptionLine, me?: string): string {
  return `PHỤ ĐỀ MEET ${line.early ? 'trước ' : ''}${hhmmss(line.first)}${line.last - line.first >= 1000 ? '–' + hhmmss(line.last) : ''} [${line.self ? (me || 'Tôi') : line.speaker}]: ${line.text}`;
}

// Share events and frames as lines for `follow` (frames as full paths, so Claude can open the image).
export function screenLine(event: ScreenEvent, audioDir: string): string | null {
  const when = `MÀN HÌNH ${event.at}`;
  switch (event.type) {
    case 'share_start': return `${when}: ${event.self ? 'Tôi (chủ máy)' : event.by ?? '(không đọc được tên)'} bắt đầu chia sẻ màn hình${event.self ? ' — Meet chỉ hiện khung giữ chỗ, không chụp ảnh màn hình của chính mình' : ''}`;
    case 'share_stop': return `${when}: ${event.self ? 'Tôi (chủ máy)' : event.by ?? 'người đang chia sẻ'} dừng chia sẻ màn hình`;
    // Meet: the presentation area is blank or covered (e.g. the People panel). No image is saved while it lasts.
    case 'screen_hidden': return `MÀN HÌNH ẨN ${event.at}: vùng trình bày${event.by ? ' của ' + event.by : ''} đang trống hoặc bị che (${event.panel ? 'khung bên phải như "Mọi người" đang mở — đóng khung đó' : 'không thấy nội dung'}); chưa chụp được ảnh — nhờ người chia sẻ/anh xem trực tiếp`;
    case 'screen_visible': return `${when}: vùng trình bày${event.by ? ' của ' + event.by : ''} đã hiện lại`;
    case 'meet_window': return event.window === 'visible' ? null : `${when}: cửa sổ Google Meet ${event.window === 'minimized' ? 'đang thu nhỏ — không chụp được, mở lại cửa sổ' : 'không thấy (cần tab "Meet - …" đang hiện của Chrome/Edge)'}`;
    case 'frame': return `${when}: ảnh màn hình chia sẻ${event.by ? ' của ' + event.by : ''}: ${screenDir(audioDir)}/${event.file}`;
    case 'frame_unreadable': return `${when}: không chụp được nội dung chia sẻ (ảnh đen) — xem trực tiếp trên Zoom`;
    case 'zoom': return event.window === 'visible' ? null : `${when}: cửa sổ họp Zoom ${event.window === 'minimized' ? 'đang thu nhỏ — không chụp được, mở lại cửa sổ Zoom' : 'không thấy'}`;
    case 'error': return `${when}: lỗi bộ canh màn hình: ${event.message}`;
    default: return null;
  }
}

// The watcher process: started detached by `pma screen start`, its pid kept next to its output. Only a process whose command line
// runs meeting_screen.ps1 is ever treated as ours (memory 03/11: never signal a pid not proven ours).
type PidFile = { pid: number; startedAt: string; session: string };
function commandLine(pid: number): string {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').trim();
}
export function watcher(audioDir: string): (PidFile & { running: boolean }) | null {
  const file = `${screenDir(audioDir)}/screen.pid`;
  if (!existsSync(file)) return null;
  try { const p = JSON.parse(readFileSync(file, 'utf8')) as PidFile; return { ...p, running: commandLine(p.pid).includes('meeting_screen.ps1') }; } catch { return null; }
}
// Which meeting app the watcher looks at: auto = whichever window is open (Zoom first when both), or forced with --mode.
export type WatchMode = 'auto' | 'zoom' | 'meet';
export function watchMode(mode?: string): WatchMode {
  if (mode === undefined || mode === '' || mode === 'auto') return 'auto';
  if (mode === 'zoom' || mode === 'meet') return mode;
  throw new Error('pma screen start --mode auto|zoom|meet');
}
export function startWatcher(root: string, audioDir: string, session: string, interval?: string, mode?: string) {
  const watch = watchMode(mode);
  const current = watcher(audioDir);
  if (current?.running) return { started: false, already: true, pid: current.pid, dir: screenDir(audioDir) };
  mkdirSync(screenDir(audioDir), { recursive: true });
  // Live 21/11: a Node `detached` child gets no console and PowerShell dies before its first line. Start-Process gives the watcher its
  // own hidden console and outlives this command.
  const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${root}/tools/meeting_screen.ps1"`, '-OutDir', `"${screenDir(audioDir)}"`, ...(interval && /^\d+(\.\d+)?$/.test(interval) ? ['-Interval', interval] : []), ...(watch !== 'auto' ? ['-Mode', watch] : [])];
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList ${q(args.join(' '))}).Id`], { encoding: 'utf8', windowsHide: true });
  const pid = Number((r.stdout ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`SCREEN_START_FAILED: ${(r.stderr ?? '').trim() || 'không lấy được pid'}`);
  writeFileSync(`${screenDir(audioDir)}/screen.pid`, JSON.stringify({ pid, startedAt: new Date().toISOString(), session }));
  return { started: true, pid, dir: screenDir(audioDir) };
}
export function stopWatcher(audioDir: string) {
  const current = watcher(audioDir);
  if (!current) return { stopped: false, why: 'chưa chạy bộ canh màn hình cho cuộc họp này' };
  if (!current.running) return { stopped: false, why: `pid ${current.pid} không còn là bộ canh màn hình (đã thoát)` };
  process.kill(current.pid);
  return { stopped: true, pid: current.pid };
}
export function screenStatus(audioDir: string) {
  const events = screenEvents(audioDir);
  const last = (type: string) => [...events].reverse().find(e => e.type === type);
  const share = [...events].reverse().find(e => e.type === 'share_start' || e.type === 'share_stop');
  const cover = [...events].reverse().find(e => e.type === 'screen_hidden' || e.type === 'screen_visible' || e.type === 'share_start' || e.type === 'share_stop');
  const app = events.some(e => e.type === 'meet_window' || (e.type === 'share_start' && e.app === 'meet')) ? 'meet' : events.some(e => e.type === 'zoom') ? 'zoom' : null;
  const w = watcher(audioDir);
  return {
    watcher: w ? { pid: w.pid, running: w.running, since: w.startedAt } : null,
    dir: screenDir(audioDir),
    events: events.length,
    app,
    sharing: share?.type === 'share_start' ? { by: share.by ?? null, self: !!share.self, since: share.at } : false,
    // Meet: true while the presentation area is blank or covered (MÀN HÌNH ẨN), no frames are saved then
    hidden: cover?.type === 'screen_hidden',
    speaker: last('speaker') ? { name: nameResolver(events, loadNames(audioDir))(last('speaker')!.name ?? ''), read: last('speaker')!.name, at: last('speaker')!.at } : null,
    names: [...new Set(events.filter(e => e.type === 'speaker' && e.name).map(e => nameResolver(events, loadNames(audioDir))(e.name!)))],
    frames: events.filter(e => e.type === 'frame').length,
    lastFrame: last('frame') ? `${screenDir(audioDir)}/${last('frame')!.file}` : null,
    errors: events.filter(e => e.type === 'error').length,
  };
}
