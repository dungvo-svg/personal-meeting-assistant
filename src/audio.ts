// Saved audio (the black box of a meeting, owner 31/10/2026): where the WAV files go and how they are measured and deleted.
// Layout of <dataDir>/audio/<sessionId>/ (agreed in docs/PLAN_0_11.md, Q-1): seg-NNNN-speaker.wav / seg-NNNN-mic.wav (what
// tools/recorder.py wrote, at the device's rate), timeline.jsonl, meeting-mix.wav (tools/mix_audio.py: both channels at
// 16 kHz, the file for `pma replay`) and expires.json. Nothing here records audio; the recorder writes the files, this only
// names, measures and deletes them. Audio does NOT expire: it goes only when the user runs `pma audio purge` (0.11).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86400000;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META = 'expires.json';
export const MIX_FILE = 'meeting-mix.wav';
export const TIMELINE_FILE = 'timeline.jsonl';

// expiresAt null = kept until the user deletes it. Folders saved by 0.10 still carry a date and keep honouring it.
export type AudioMeta = { keepDays: number | null; savedAt: string; expiresAt: string | null };
// mix: finished mix files; mixing: the mix files that channel files are waiting for (not there yet).
export type AudioInfo = AudioMeta & { dir: string; files: number; bytes: number; mix: string[]; mixing: string[] };

export const audioRoot = (dataDir: string) => join(dataDir, 'audio');
export const audioDir = (dataDir: string, sessionId: string) => join(audioRoot(dataDir), sessionId);

function readMeta(dir: string): AudioMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, META), 'utf8'));
    if (meta.expiresAt !== null && !Number.isFinite(Date.parse(meta.expiresAt))) return null;
    return { keepDays: meta.keepDays ?? null, savedAt: meta.savedAt, expiresAt: meta.expiresAt ?? null };
  } catch { return null; }
}

// Creates the session's audio folder and records that it has no expiry. A folder that already has a legacy expiry keeps it.
export function markAudioDir(dataDir: string, sessionId: string, now = Date.now()): AudioMeta & { dir: string } {
  const dir = audioDir(dataDir, sessionId); mkdirSync(dir, { recursive: true });
  const before = readMeta(dir);
  const meta: AudioMeta = before ?? { keepDays: null, savedAt: new Date(now).toISOString(), expiresAt: null };
  if (!before) writeFileSync(join(dir, META), JSON.stringify(meta), 'utf8');
  return { ...meta, dir };
}

const CHANNEL_FILE = /^(.+)-(speaker|mic)\.wav$/;

// Finished mix files, and the mix a folder is still waiting for. Folders of 0.10 mixed one file per listening
// (<captureId>-mix.wav); 0.11 has one meeting-mix.wav for the whole session. <name>-mix.part never counts as finished.
function mixState(dir: string) {
  const names = readdirSync(dir); const have = new Set(names);
  const mix = names.filter(name => name.endsWith('-mix.wav')).sort().map(name => join(dir, name));
  const legacy = [...new Set(names.map(name => name.match(CHANNEL_FILE)?.[1]).filter((id): id is string => !!id && !id.startsWith('seg-')))].sort();
  const mixing = legacy.filter(id => !have.has(`${id}-mix.wav`)).map(id => join(dir, `${id}-mix.wav`));
  if (names.some(name => /^seg-\d+-(speaker|mic)\.wav$/.test(name)) && !have.has(MIX_FILE)) mixing.push(join(dir, MIX_FILE));
  return { mix, mixing };
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

// With olderThanDays: anything whose newest file is at least that old (0 = everything). Without: only a folder that carries
// a legacy expiry date which has passed; a folder with no expiry is never deleted by this.
export function isExpired(meta: AudioMeta | null, newestMs: number, now: number, olderThanDays?: number) {
  if (olderThanDays !== undefined) return now - newestMs >= olderThanDays * DAY_MS;
  return !!meta?.expiresAt && Date.parse(meta.expiresAt) <= now;
}

export function audioInfo(dataDir: string, sessionId: string): AudioInfo | null {
  const dir = audioDir(dataDir, sessionId);
  if (!SESSION_DIR.test(sessionId) || !existsSync(dir)) return null;
  const { files, bytes, newest } = measure(dir); if (!files) return null;
  const meta = readMeta(dir) ?? { keepDays: null, savedAt: new Date(newest).toISOString(), expiresAt: null };
  return { ...meta, dir, files, bytes, ...mixState(dir) };
}

export function listAudio(dataDir: string) {
  const root = audioRoot(dataDir); if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => SESSION_DIR.test(name)).map(name => ({ sessionId: name, ...audioInfo(dataDir, name) })).filter(item => item.dir) as (AudioInfo & { sessionId: string })[];
}

// Deletes session folders on the user's explicit request (`pma audio purge`). Only folders named like a session ID are ever
// touched, and `keep` (the session being recorded now) is left alone.
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
