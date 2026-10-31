// Reaches the single meeting runtime (daemon), starting it when it is not running.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
export const DAEMON_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH'];
type Info ={ url: string; pid: number; token: string; version: string; startedAt: string };

export function daemonInfo(): Info | null {
  try { return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')); } catch { return null; }
}

async function post(info: Info, method: string, args: unknown, timeoutMs: number) {
  const response = await fetch(info.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(timeoutMs) });
  const reply = await response.json() as { ok: boolean; result?: any; error?: string };
  if (response.status === 401) throw Object.assign(new Error('RPC_UNAUTHORIZED'), { stale: true });
  if (!reply.ok) throw new Error(reply.error || 'RPC_FAILED');
  return reply.result;
}

async function alive(info: Info | null) {
  if (!info) return false;
  try { return (await post(info, 'ping', {}, 2000)).ok === true; } catch { return false; }
}

export async function ensureDaemon(): Promise<Info> {
  const known = daemonInfo();
  if (await alive(known)) return known!;
  // The runtime must outlive the Claude session, shell command or MCP adapter that starts it, and must not
  // hold their stdout pipes. On Windows a detached child still inherits those handles and the caller's job,
  // so it is created through WMI instead, with its console hidden. Settings travel as --env arguments because WMI drops the environment.
  const settings = DAEMON_ENV.filter(key => process.env[key]).flatMap(key => ['--env', `${key}=${process.env[key]}`]);
  const argv = [process.execPath, '--no-warnings', join(root, 'dist', 'daemon.js'), ...settings];
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:PMA_LAUNCH; CurrentDirectory = $env:PMA_LAUNCH_DIR; ProcessStartupInformation = $s }; exit $r.ReturnValue'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, PMA_LAUNCH: argv.map(a => `"${a}"`).join(' '), PMA_LAUNCH_DIR: root } })
    : spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const info = daemonInfo();
    if (info && info.startedAt !== known?.startedAt && await alive(info)) return info;
  }
  throw new Error(`DAEMON_NOT_STARTED: port ${process.env.PMA_PORT || 8796} may be held by another meeting runtime (an older MCP server still running a meeting?)`);
}

export async function call(method: string, args: unknown = {}, timeoutMs = 60000) {
  const info = await ensureDaemon();
  return post(info, method, args, timeoutMs);
}
