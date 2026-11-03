// One meeting runtime per machine (0.12.1, ENG-36). On 03/11 a second host started from another checkout (other port, other
// data folder) recorded the same speaker and ran a second ASR on the one 6 GB GPU; the meeting's ASR stalled for 20 minutes.
// Before a host loads models, opens a device, records or listens again, it takes this machine-wide lock; another host is refused
// with RUNTIME_BUSY and told who holds it. The lock lives outside every checkout (PMA_LOCK_DIR, default %LOCALAPPDATA%\pma).
//
// The lock has no time limit: it is stale only when its holder is gone. "Gone" is checked by PID and by the process's start time
// (a reused PID is another process). A host that died while its recorder or ASR worker goes on still holds the machine; only a host
// of the same data folder may take that meeting over (reattach), as the recorder belongs to it.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type LockOwner = { pid: number; pidStartedAt: string; token: string; dataDir: string; root: string; port: number | null; since: string; sessionId: string | null; recorderPid: number | null; workerPid: number | null };

export const lockDir = () => process.env.PMA_LOCK_DIR || join(process.env.LOCALAPPDATA || homedir(), 'pma');
const lockFile = () => join(lockDir(), 'runtime.lock');
const pidAlive = (pid: number | null | undefined) => { if (!pid || !Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };
const ownStart = new Date(Date.now() - process.uptime() * 1000).toISOString();

// When the process with this PID started (ISO), or null when it cannot be told. Only asked when a lock's PID is alive and not ours.
export function processStartedAt(pid: number): string | null {
  try {
    const out = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).stdout;
    const at = Date.parse(String(out).trim()); return Number.isFinite(at) ? new Date(at).toISOString() : null;
  } catch { return null; }
}
// The holder is the same live process: its PID is alive and (when the start time can be read) started when the lock says.
function holderAlive(owner: LockOwner) {
  if (!pidAlive(owner.pid)) return false;
  const started = processStartedAt(owner.pid);
  return started === null || Math.abs(Date.parse(started) - Date.parse(owner.pidStartedAt)) < 5000;
}
export function readLock(): LockOwner | null { try { return JSON.parse(readFileSync(lockFile(), 'utf8')); } catch { return null; } }
const mine = (owner: LockOwner | null, token: string) => !!owner && owner.pid === process.pid && owner.token === token;
const describe = (o: LockOwner) => `pid ${o.pid}${o.port ? `, cổng ${o.port}` : ''}, dữ liệu ${o.dataDir}, từ ${o.since}${o.sessionId ? `, cuộc họp ${o.sessionId}` : ''}`;

// Takes the machine for this host, or throws RUNTIME_BUSY. Calling it again while holding it changes nothing.
// `hooks.onStale` (tests only): runs after this host has judged the lock stale and before it takes it, to replay a racing host.
export function claimMachine(me: { token: string; dataDir: string; root: string; port: number | null; sessionId?: string | null }, hooks: { onStale?: () => void } = {}) {
  mkdirSync(lockDir(), { recursive: true });
  const record: LockOwner = { pid: process.pid, pidStartedAt: ownStart, token: me.token, dataDir: resolve(me.dataDir), root: resolve(me.root), port: me.port, since: new Date().toISOString(), sessionId: me.sessionId ?? null, recorderPid: null, workerPid: null };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = openSync(lockFile(), 'wx'); try { writeSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
      return record;
    } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    const owner = readLock();
    if (!owner) continue;   // removed (or half-written) meanwhile: try again
    if (mine(owner, me.token)) return owner;
    if (holderAlive(owner)) throw new Error(`RUNTIME_BUSY: một host PMA khác đang giữ máy (${describe(owner)}). Không mở thêm bộ ghi, bộ nghe hay model. Dừng host đó trước (pma stop/shutdown ở đúng thư mục dữ liệu của nó).`);
    const orphans = [owner.recorderPid, owner.workerPid].filter(pid => pidAlive(pid));
    if (orphans.length && resolve(owner.dataDir) !== record.dataDir) throw new Error(`RUNTIME_BUSY: host cũ đã dừng nhưng bộ ghi/bộ nghe của nó còn chạy (pid ${orphans.join(', ')}, dữ liệu ${owner.dataDir}). Chỉ host của thư mục dữ liệu đó được nhận lại.`);
    hooks.onStale?.();
    takeOver(owner);
  }
  throw new Error('RUNTIME_BUSY: không giành được khoá máy (có host khác đang giành cùng lúc)');
}
// Moves a stale lock aside, one host at a time. Without this, two hosts that both judged the same lock stale could each move a lock
// away, and the second would move the FIRST host's fresh lock (review of 5e903de, finding a). Under the takeover guard the lock is
// read again and moved only if it is still the very record judged stale; a lock someone took meanwhile is left alone.
function takeOver(stale: LockOwner) {
  const guard = `${lockFile()}.takeover`; let fd: number;
  try { fd = openSync(guard, 'wx'); }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    // A guard is held for milliseconds; one left by a host that died, or older than 10 s, is removed and the claim tries again.
    let held: any = null; try { held = JSON.parse(readFileSync(guard, 'utf8')); } catch {}
    if (!held || !pidAlive(held.pid) || Date.now() - Number(held.at) > 10000) { try { rmSync(guard, { force: true }); } catch {} }
    return;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); closeSync(fd);
    const now = readLock();
    if (now && now.token === stale.token && now.pid === stale.pid) renameSync(lockFile(), `${lockFile()}.stale-${stale.pid}-${Date.now()}`);
  } finally { try { rmSync(guard, { force: true }); } catch {} }
}
// What daemon.json also says (session, recorder, worker), kept in the lock so a later host can judge it. Only by the holder.
export function updateMachine(token: string, change: Partial<Pick<LockOwner, 'sessionId' | 'recorderPid' | 'workerPid' | 'port'>>) {
  const owner = readLock(); if (!mine(owner, token)) return false;
  const next = { ...owner!, ...change }; const temp = `${lockFile()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next)); renameSync(temp, lockFile()); return true;
}
export function releaseMachine(token: string) {
  const owner = readLock(); if (!mine(owner, token)) return false;
  try { rmSync(lockFile(), { force: true }); return true; } catch { return false; }
}
// For status: who holds the machine, without touching anything.
export function machineHolder(): (LockOwner & { alive: boolean }) | null {
  const owner = readLock(); if (!owner) return null;
  return { ...owner, alive: owner.pid === process.pid || holderAlive(owner) };
}
