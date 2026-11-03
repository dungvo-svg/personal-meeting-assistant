// Reaches the single meeting runtime (daemon), starting it when it is not running.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { machineHolder } from './machine_lock.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
export const DAEMON_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH', 'PMA_LOCK_DIR'];
type Info ={ url: string; pid: number; token: string; version: string; startedAt: string };

export function daemonInfo(): Info | null {
  try { return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')); } catch { return null; }
}

// node:http, not fetch: fetch gives up after 300 s without response headers (UND_ERR_HEADERS_TIMEOUT, "fetch failed") whatever
// the caller allows, and recheck/stop may take longer. Here the only limit is timeoutMs.
function post(info: Info, method: string, args: unknown, timeoutMs: number) {
  const body = JSON.stringify({ method, args });
  return new Promise<any>((resolve, reject) => {
    const request = httpRequest(info.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(timeoutMs) }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === 401) return reject(Object.assign(new Error('RPC_UNAUTHORIZED'), { stale: true }));
        let reply: { ok: boolean; result?: any; error?: string };
        try { reply = JSON.parse(text); } catch { return reject(new Error('RPC_FAILED: ' + text.slice(0, 200))); }
        if (!reply.ok) return reject(new Error(reply.error || 'RPC_FAILED'));
        resolve(reply.result);
      });
    });
    request.on('error', reject); request.end(body);
  });
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

// Status without side effects: the running host's status, or (no host) who holds the machine. Never starts a host or loads a model.
export async function inspect() {
  const info = daemonInfo();
  if (await alive(info)) return post(info!, 'status', {}, 15000);
  const holder = machineHolder(); const machine = holder ? (({ token, ...rest }) => rest)(holder) : null;
  return { host: 'NOT_RUNNING', dataDir, machine, note: 'Không có host nào cho thư mục dữ liệu này; lệnh status không tự khởi động host.' };
}

export async function call(method: string, args: unknown = {}, timeoutMs = 60000) {
  const info = await ensureDaemon();
  return post(info, method, args, timeoutMs);
}
