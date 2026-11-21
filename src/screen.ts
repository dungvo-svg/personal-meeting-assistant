// What the meeting window showed (tools/meeting_screen.ps1 → <audio dir>/screen/screen.jsonl): who Zoom outlined as speaking, who
// shared and when, frames of the shared screen. Built and tried live in the 21/11 tender meeting. The CLI only reads that file:
// names go on transcript lines, share events and frames are printed by `follow`. Nothing here talks to the host.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type ScreenEvent = { at: string; utc: string; type: string; name?: string; by?: string | null; file?: string; tab?: string; window?: string; message?: string; note?: string; diff?: number };

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

// The speaker of each line from the outline Zoom drew at that time. Lines cut from one chunk share the chunk's range (no word
// timestamps), so the range is split by text length: an estimate. Microphone lines are the owner's and get no Zoom name. A change of
// outline inside a line gives every name ("A→B"); no outline in the last 30 s gives none (never a guess).
export function speakersOf(items: any[], events: ScreenEvent[], isMic: (item: any) => boolean): Map<number, string> {
  const marks = events.filter(e => e.type === 'speaker' && e.name).map(e => ({ t: Date.parse(e.utc), name: e.name as string })).filter(m => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
  const names = new Map<number, string>();
  if (!marks.length) return names;
  const chunks = new Map<string, any[]>();
  for (const item of items) {
    if (!item.wall || item.origin === 'system_gap') continue;
    const key = `${item.wall}|${item.start}|${item.end}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key)!.push(item);
  }
  for (const group of chunks.values()) {
    const total = group.reduce((n, item) => n + String(item.text ?? '').length, 0) || 1;
    const duration = Math.max(0, (Number(group[0].end) - Number(group[0].start)) * 1000) || 0;
    let at = Date.parse(group[0].wall);
    for (const item of group) {
      const from = at, to = at + duration * String(item.text ?? '').length / total;
      at = to;
      if (isMic(item)) continue;
      let i = -1;
      for (let lo = 0, hi = marks.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (marks[mid].t <= from) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      const who: string[] = [];
      if (i >= 0 && from - marks[i].t <= STALE_MS) who.push(marks[i].name);
      for (let j = i + 1; j < marks.length && marks[j].t <= to; j++) if (who.at(-1) !== marks[j].name) who.push(marks[j].name);
      if (who.length) names.set(item.id, who.join('→'));
    }
  }
  return names;
}

// Share events and frames as lines for `follow` (frames as full paths, so Claude can open the image).
export function screenLine(event: ScreenEvent, audioDir: string): string | null {
  const when = `MÀN HÌNH ${event.at}`;
  switch (event.type) {
    case 'share_start': return `${when}: ${event.by ?? '(không đọc được tên)'} bắt đầu chia sẻ màn hình`;
    case 'share_stop': return `${when}: ${event.by ?? 'người đang chia sẻ'} dừng chia sẻ màn hình`;
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
export function startWatcher(root: string, audioDir: string, session: string, interval?: string) {
  const current = watcher(audioDir);
  if (current?.running) return { started: false, already: true, pid: current.pid, dir: screenDir(audioDir) };
  mkdirSync(screenDir(audioDir), { recursive: true });
  // Live 21/11: a Node `detached` child gets no console and PowerShell dies before its first line. Start-Process gives the watcher its
  // own hidden console and outlives this command.
  const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${root}/tools/meeting_screen.ps1"`, '-OutDir', `"${screenDir(audioDir)}"`, ...(interval && /^\d+(\.\d+)?$/.test(interval) ? ['-Interval', interval] : [])];
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
  const w = watcher(audioDir);
  return {
    watcher: w ? { pid: w.pid, running: w.running, since: w.startedAt } : null,
    dir: screenDir(audioDir),
    events: events.length,
    sharing: share?.type === 'share_start' ? { by: share.by ?? null, since: share.at } : false,
    speaker: last('speaker') ? { name: last('speaker')!.name, at: last('speaker')!.at } : null,
    frames: events.filter(e => e.type === 'frame').length,
    lastFrame: last('frame') ? `${screenDir(audioDir)}/${last('frame')!.file}` : null,
    errors: events.filter(e => e.type === 'error').length,
  };
}
