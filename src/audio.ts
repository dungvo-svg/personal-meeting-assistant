// Opt-in audio saving (`pma listen --save-audio`): where the WAV files go, when they expire, and how they are purged.
// Layout: <dataDir>/audio/<sessionId>/<captureId>-<speaker|mic>.wav plus expires.json. Nothing here records audio;
// the worker writes the files, this only names, measures and deletes them.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_KEEP_DAYS = 7;
const DAY_MS = 86400000;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META = 'expires.json';

export type AudioMeta = { keepDays: number; savedAt: string; expiresAt: string };
export type AudioInfo = AudioMeta & { dir: string; files: number; bytes: number };

export const audioRoot = (dataDir: string) => join(dataDir, 'audio');
export const audioDir = (dataDir: string, sessionId: string) => join(audioRoot(dataDir), sessionId);
export const keepDaysOf = (value?: number) => Number.isFinite(value) ? Math.max(1, Math.min(90, Math.floor(value!))) : DEFAULT_KEEP_DAYS;

function readMeta(dir: string): AudioMeta | null {
  try { const meta = JSON.parse(readFileSync(join(dir, META), 'utf8')); return Number.isFinite(Date.parse(meta.expiresAt)) ? meta : null; } catch { return null; }
}

// Creates the session's audio folder and records when it expires. A later listening in the same session never
// shortens an earlier expiry.
export function markAudioDir(dataDir: string, sessionId: string, keepDays: number, now = Date.now()): AudioMeta & { dir: string } {
  const dir = audioDir(dataDir, sessionId); mkdirSync(dir, { recursive: true });
  const before = readMeta(dir);
  const expiresAt = Math.max(now + keepDays * DAY_MS, before ? Date.parse(before.expiresAt) : 0);
  const meta: AudioMeta = { keepDays, savedAt: before?.savedAt ?? new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  writeFileSync(join(dir, META), JSON.stringify(meta), 'utf8');
  return { ...meta, dir };
}

function measure(dir: string) {
  // The age of a folder is the age of its newest audio, not of the expiry record next to it.
  let files = 0; let bytes = 0; let newest = 0;
  for (const name of readdirSync(dir)) {
    const stat = statSync(join(dir, name)); if (!stat.isFile() || !name.endsWith('.wav')) continue;
    files++; bytes += stat.size; newest = Math.max(newest, stat.mtimeMs);
  }
  return { files, bytes, newest: newest || statSync(dir).mtimeMs };
}

// With olderThanDays: anything whose newest file is at least that old (0 = everything). Without: what has reached its
// own expiry; a folder with no expiry record counts DEFAULT_KEEP_DAYS from its newest file.
export function isExpired(meta: AudioMeta | null, newestMs: number, now: number, olderThanDays?: number) {
  if (olderThanDays !== undefined) return now - newestMs >= olderThanDays * DAY_MS;
  return meta ? Date.parse(meta.expiresAt) <= now : now - newestMs >= DEFAULT_KEEP_DAYS * DAY_MS;
}

export function audioInfo(dataDir: string, sessionId: string): AudioInfo | null {
  const dir = audioDir(dataDir, sessionId);
  if (!SESSION_DIR.test(sessionId) || !existsSync(dir)) return null;
  const { files, bytes, newest } = measure(dir); if (!files) return null;
  const meta = readMeta(dir) ?? { keepDays: DEFAULT_KEEP_DAYS, savedAt: new Date(newest).toISOString(), expiresAt: new Date(newest + DEFAULT_KEEP_DAYS * DAY_MS).toISOString() };
  return { ...meta, dir, files, bytes };
}

export function listAudio(dataDir: string) {
  const root = audioRoot(dataDir); if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => SESSION_DIR.test(name)).map(name => ({ sessionId: name, ...audioInfo(dataDir, name) })).filter(item => item.dir) as (AudioInfo & { sessionId: string })[];
}

// Deletes expired session folders. Only folders named like a session ID are ever touched, and `keep` (the session being
// recorded now) is left alone.
export function purgeAudio(dataDir: string, options: { olderThanDays?: number; now?: number; keep?: string[] } = {}) {
  const root = audioRoot(dataDir); const now = options.now ?? Date.now();
  const removed: { sessionId: string; bytes: number }[] = []; let kept = 0;
  if (!existsSync(root)) return { removed, kept, freedBytes: 0 };
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!SESSION_DIR.test(name) || !statSync(dir).isDirectory()) continue;
    const { bytes, newest } = measure(dir);
    if (options.keep?.includes(name) || !isExpired(readMeta(dir), newest, now, options.olderThanDays)) { kept++; continue; }
    rmSync(dir, { recursive: true, force: true }); removed.push({ sessionId: name, bytes });
  }
  return { removed, kept, freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0) };
}
