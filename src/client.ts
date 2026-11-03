// Reaches the single meeting runtime (daemon) of THIS MACHINE, starting it only when no host holds the machine.
// 0.12.2: one activation point from any cwd. On 03/11 a second checkout (other folder, other port, other data dir) started its
// own host and recorded the same meeting twice; the machine lock (ENG-36) refuses a second host, but a command run from that
// checkout still tried to start ITS OWN and just failed RUNTIME_BUSY. Now it finds the host that holds the machine and attaches.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { machineHolder } from './machine_lock.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.PMA_DATA_DIR || join(root, '.local', 'runtime');
export const DAEMON_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH', 'PMA_LOCK_DIR', 'PMA_MIC'];
type Info ={ url: string; pid: number; token: string; version: string; startedAt: string };
type Holder = NonNullable<ReturnType<typeof machineHolder>>;
// How the host was reached: 'local' = this data dir's daemon.json; 'machine' = the machine-lock holder's, from another data dir.
export type Attached = { via: 'local' | 'machine'; dataDir: string; port: number | null; pid: number };
type Found = { info: Info; attached: Attached };

export function daemonInfo(): Info | null { return readInfo(dataDir); }
function readInfo(dir: string): Info | null {
  try { return JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')); } catch { return null; }
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

async function ping(info: Info): Promise<any | null> {
  try { const pong = await post(info, 'ping', {}, 2000); return pong?.ok === true ? pong : null; } catch { return null; }
}

// The token goes only to a loopback URL of a well-formed daemon.json (a file in a folder is not proof of who listens behind it).
const loopback = (url: unknown) => { try { const u = new URL(String(url)); return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } };
const wellFormed = (info: Info | null): info is Info => !!info && typeof info.url === 'string' && typeof info.token === 'string' && Number.isInteger(info.pid) && loopback(info.url);
const portOf = (url: string) => Number(new URL(url).port) || null;

// Discovery, in order. (a) This data dir's daemon.json, if its host answers. (b) Otherwise the machine-lock holder: if it is alive
// and ITS data dir's daemon.json names the same pid as the lock (and a loopback URL, and the lock's port when it has one), that
// host is the machine's one meeting host, and we attach to it. A daemon.json that does not match the lock's holder is not trusted,
// and its token is never sent anywhere: the pid is compared before the first request. `holder` is read only when (a) failed, since on
// Windows judging a foreign holder costs a PowerShell call. `why` says, for a live holder we could not attach to, what was missing.
// Fail closed in a diagnostic run: a client with PMA_TEST_MODE=1 talks only to a host that says it is a test host too (ping.testMode),
// whatever daemon.json it finds; anything else is not used at all: no prepare, finish, shutdown or purge reaches it (Astra review of
// 75feff5). With the test lock namespace of machine_lock.ts it does not even find the user's host; this is the second wall.
const testClient = process.env.PMA_TEST_MODE === '1';
const allowed = (pong: any) => !!pong && (!testClient || pong.testMode === true);
async function locate(): Promise<{ found: Found | null; holder: Holder | null; why: string }> {
  const own = readInfo(dataDir);
  if (wellFormed(own) && allowed(await ping(own))) return { found: { info: own, attached: { via: 'local', dataDir: resolve(dataDir), port: portOf(own.url), pid: own.pid } }, holder: null, why: '' };
  const holder = machineHolder();
  if (!holder?.alive) return { found: null, holder, why: '' };
  const theirs = resolve(holder.dataDir);
  const no = (why: string) => ({ found: null, holder, why });
  if (theirs === resolve(dataDir)) return no(own ? 'daemon.json của nó không trả lời' : 'không có daemon.json trong thư mục dữ liệu của nó');   // the file (a) already tried
  const info = readInfo(theirs);
  if (!info) return no('không có daemon.json trong thư mục dữ liệu của nó');
  if (!Number.isInteger(info.pid) || info.pid !== holder.pid) return no(`daemon.json ghi pid ${info.pid}, không khớp pid giữ khoá nên không tin`);
  if (!wellFormed(info)) return no('daemon.json không hợp lệ hoặc không trỏ về máy này');
  if (holder.port && portOf(info.url) !== holder.port) return no(`daemon.json ghi cổng ${portOf(info.url)}, khoá ghi cổng ${holder.port}`);
  const pong = await ping(info);
  if (!pong) return no('không trả lời');
  if (!allowed(pong)) return no('không phải host thử (lệnh đang ở chế độ thử)');
  if (pong.pid !== undefined && pong.pid !== holder.pid) return no(`trả lời từ pid ${pong.pid}, không phải pid giữ khoá`);
  return { found: { info, attached: { via: 'machine', dataDir: theirs, port: portOf(info.url), pid: holder.pid } }, holder, why: '' };
}

const busy = (holder: Holder, why: string) => `RUNTIME_BUSY: host PMA của máy đang chạy (pid ${holder.pid}${holder.port ? `, cổng ${holder.port}` : ''}, dữ liệu ${holder.dataDir}) nhưng ${why || 'chưa kết nối được'}. Không mở host thứ hai. Kiểm host đó (pma status) hoặc dừng nó trước (pma stop/shutdown ở thư mục dữ liệu của nó).`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Tests only: stand in for the launcher and shorten the waits, so nothing real is ever spawned from a test.
const hooks = { launch: null as null | (() => void), graceMs: 8000, startMs: 20000 };
export function setClientForTests(change: { launch?: (() => void) | null; graceMs?: number; startMs?: number }) { Object.assign(hooks, change); }

function launch() {
  // The runtime must outlive the Claude session, shell command or MCP adapter that starts it, and must not
  // hold their stdout pipes. On Windows a detached child still inherits those handles and the caller's job,
  // so it is created through WMI instead, with its console hidden. Settings travel as --env arguments because WMI drops the environment.
  const settings = DAEMON_ENV.filter(key => process.env[key]).flatMap(key => ['--env', `${key}=${process.env[key]}`]);
  const argv = [process.execPath, '--no-warnings', join(root, 'dist', 'daemon.js'), ...settings];
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:PMA_LAUNCH; CurrentDirectory = $env:PMA_LAUNCH_DIR; ProcessStartupInformation = $s }; exit $r.ReturnValue'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, PMA_LAUNCH: argv.map(a => `"${a}"`).join(' '), PMA_LAUNCH_DIR: root } })
    : spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
}

// A host is started only when nobody holds the machine. A live holder that cannot be reached (its daemon.json is missing or does not
// match, it does not answer) is waited for briefly, as it may be starting, then reported as RUNTIME_BUSY: never a second host.
export async function ensureDaemon(): Promise<Info> {
  const known = daemonInfo();
  let seen = await locate();
  if (seen.found) return seen.found.info;
  const until = Date.now() + hooks.graceMs;
  while (seen.holder?.alive) {
    if (Date.now() >= until) throw new Error(busy(seen.holder, seen.why));
    await sleep(1000);
    seen = await locate();
    if (seen.found) return seen.found.info;
  }
  (hooks.launch ?? launch)();
  const deadline = Date.now() + hooks.startMs;
  while (Date.now() < deadline) {
    await sleep(hooks.startMs < 1000 ? 50 : 300);
    seen = await locate();
    // Our own host may lose the race to another one; whichever holds the machine is the host.
    if (seen.found && (seen.found.attached.via === 'machine' || seen.found.info.startedAt !== known?.startedAt)) return seen.found.info;
  }
  if (seen.holder?.alive) throw new Error(busy(seen.holder, seen.why));
  throw new Error(`DAEMON_NOT_STARTED: port ${process.env.PMA_PORT || 8796} may be held by another meeting runtime (an older MCP server still running a meeting?)`);
}

// Status without side effects: the reachable host's status with `attached` (how it was found), or (no host) who holds the machine.
// Never starts a host or loads a model.
export async function inspect() {
  const { found, holder, why } = await locate();
  if (found) return { ...(await post(found.info, 'status', {}, 15000)), attached: found.attached };
  const machine = holder ? (({ token, ...rest }) => rest)(holder) : null;
  const note = holder?.alive ? `Một host khác đang giữ máy nhưng chưa kết nối được (${why || 'chưa rõ'}); lệnh status không tự khởi động host.` : 'Không có host nào chạy trên máy này; lệnh status không tự khởi động host.';
  return { host: 'NOT_RUNNING', dataDir, machine, attached: null, note };
}

export async function call(method: string, args: unknown = {}, timeoutMs = 60000) {
  const info = await ensureDaemon();
  return post(info, method, args, timeoutMs);
}

// Drafts (picture, translations, participants, summary, tasks, job results) only go to a host that is already running and answers
// as this checkout's or the machine's host (Codex review of 9b02494): handing over content is never a reason to start a host.
export async function attach(method: string, args: unknown = {}, timeoutMs = 60000) {
  const { found, holder, why } = await locate();
  if (!found) throw new Error(holder?.alive ? busy(holder, why) : 'HOST_NOT_RUNNING: không có host nào đang chạy; nội dung nháp không tự mở host. Mở host bằng một lệnh đọc (vd. pma history) hoặc pma start, rồi chạy lại');
  return post(found.info, method, args, timeoutMs);
}
