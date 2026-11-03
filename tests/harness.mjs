// Test harness: the third wall (after machine_lock.ts lockDir() and client.ts locate()) between a test and the USER'S REAL meeting host.
// A test that starts a host gets a world of its own (temp root, data dir, lock dir, free loopback port, no inherited PMA_*), and every
// request the harness sends itself (shutdown in cleanup, mostly) goes out only after the target is PROVEN to be a host this test
// started: loopback url, a ping that says testMode: true and the same pid as daemon.json, and that pid recorded by recordHost() right
// after the test started it. Anything else is refused with HARNESS_REFUSED and nothing but (at most) a ping is sent: fail closed.
// No function here spawns a process or opens a device. Signals: ownedChildren().closeAll() stops, through its own handle, a child the
// test spawned itself (child.kill()); the only other process call is the existence probe process.kill(pid, 0) (nothing is delivered),
// only for a pid this test recorded, to know that its own host has exited before its files are removed. Nothing is found by name. Cleanup fails closed: while that is not proven, the root is kept and reported. The bearer token is never printed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

// What a test host is given. Every other PMA_* of the parent (PMA_PYTHON, PMA_IDLE_MINUTES, PMA_EXIT_AFTER_FINISH ...) is dropped.
const OWN = ['PMA_TEST_MODE', 'PMA_DATA_DIR', 'PMA_LOCK_DIR', 'PMA_STOP_HOOK', 'PMA_WARM', 'PMA_PORT'];
const isPma = key => /^PMA_/i.test(key);
const refused = reason => new Error('HARNESS_REFUSED: ' + reason);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = error => String(error?.message ?? error).replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 160);

// Where a path is. `strict` excludes the parent itself.
function inside(parent, child, strict = false) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return !strict;
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
const freePort = () => new Promise((res, rej) => { const s = createNet(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const loopback = url => { try { const u = new URL(String(url)); return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } };

// One entry per world made by isolatedEnv, found by its data dir. A data dir that is not here is not ours and is never contacted.
const worlds = new Map();
const keyOf = dir => { const key = resolve(String(dir)); return process.platform === 'win32' ? key.toLowerCase() : key; };

// A fresh world. Async only because the port must be proven free.
export async function isolatedEnv(label = 'test') {
  const safe = String(label).replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40) || 'test';
  const root = mkdtempSync(join(tmpdir(), `pma-${safe}-`));
  const data = join(root, 'data'), lock = join(root, 'lock');
  mkdirSync(data, { recursive: true }); mkdirSync(lock, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isPma(key)));
  Object.assign(env, { PMA_TEST_MODE: '1', PMA_DATA_DIR: data, PMA_LOCK_DIR: lock, PMA_STOP_HOOK: 'off', PMA_WARM: '0', PMA_PORT: String(await freePort()) });
  // unknownStarts: launch attempts (recordingHost) after which no pid could be recorded: a host may exist that this test cannot name.
  worlds.set(keyOf(data), { root, createdAt: Date.now(), pids: new Set(), unknownStarts: 0 });
  // Removes only what is under this root, and only inside the system temp folder. All paths are judged before any is removed.
  // A failure to delete (a file the host still holds on Windows) is reported, not thrown: cleanup may run in a finally.
  const cleanup = (...paths) => {
    const targets = (paths.length ? paths : [root]).map(path => resolve(String(path)));
    if (!inside(tmpdir(), root, true) || !basename(root).startsWith('pma-')) throw refused(`root ${root} is not a pma-* folder under ${tmpdir()}`);
    for (const target of targets) {
      if (!inside(tmpdir(), target, true)) throw refused(`${target} is outside ${tmpdir()}`);
      if (!inside(root, target)) throw refused(`${target} is outside ${root}`);
    }
    const failed = [];
    for (const target of targets) { try { rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (error) { failed.push({ path: target, error: short(error) }); } }
    return failed.length ? { removed: false, failed } : { removed: true };
  };
  return { root, env, cleanup };
}

// Puts env's PMA_* into process.env (and takes every other PMA_* of the parent out), for a test that imports ../dist/client.js, which
// reads them once. Returns the function that puts the parent's PMA_* back.
export function applyEnv(env) {
  const before = Object.entries(process.env).filter(([key]) => isPma(key));
  for (const [key] of before) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (isPma(key)) process.env[key] = value;
  return () => { for (const key of Object.keys(process.env)) if (isPma(key)) delete process.env[key]; for (const [key, value] of before) process.env[key] = value; };
}

// Reads the daemon.json of this world's data dir. Never throws: null for anything that is not a well-formed, loopback one.
function readHost(env) {
  const world = worlds.get(keyOf(env?.PMA_DATA_DIR ?? ''));
  if (!world) return { why: 'the data dir was not made by isolatedEnv' };
  let info; try { info = JSON.parse(readFileSync(join(resolve(env.PMA_DATA_DIR), 'daemon.json'), 'utf8')); } catch { return { world, why: 'no daemon.json in the data dir' }; }
  if (!info || typeof info.url !== 'string' || typeof info.token !== 'string' || !info.token || !Number.isInteger(info.pid)) return { world, why: 'daemon.json is not well formed' };
  if (!loopback(info.url)) return { world, why: 'daemon.json url is not loopback' };
  return { world, info };
}

// Call right after the test started a host (a command, a spawn, call('prepare')): remembers the pid in THIS world's daemon.json as one
// this test started. Only a daemon.json written after the world was made counts. Returns the pid, or null (and remembers nothing).
export function recordHost(env) {
  const { world, info } = readHost(env);
  if (!world || !info) return null;
  const startedAt = Date.parse(info.startedAt);
  if (!Number.isFinite(startedAt) || startedAt < world.createdAt - 2000) return null;
  world.pids.add(info.pid); return info.pid;
}
// Runs fn (the thing that starts a host) and records the host afterwards even when fn throws. An attempt after which no pid can be
// recorded leaves the world UNKNOWN_START: the host may have been spawned (detached, through WMI, so the test holds no handle) and
// die or not answer yet; waiting is no proof, so teardown keeps the root for good.
export async function recordingHost(env, fn) {
  try { return await fn(); }
  finally { if (recordHost(env) === null) { const world = worlds.get(keyOf(env?.PMA_DATA_DIR ?? '')); if (world) world.unknownStarts++; } }
}

// node:http with the bearer token, as src/client.ts post() does. Errors carry no token.
function rpc(info, method, args, timeoutMs) {
  const body = JSON.stringify({ method, args });
  return new Promise((res, rej) => {
    const request = httpRequest(info.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(timeoutMs) }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('error', rej);
      response.on('end', () => {
        if (response.statusCode === 401) return rej(new Error('RPC_UNAUTHORIZED'));
        let reply; try { reply = JSON.parse(text); } catch { return rej(new Error('RPC_FAILED: ' + text.slice(0, 200))); }
        if (!reply.ok) return rej(new Error(reply.error || 'RPC_FAILED'));
        res(reply.result);
      });
    });
    request.on('error', error => rej(new Error('RPC_FAILED: ' + short(error)))); request.end(body);
  });
}

// The proof, run before EVERY request. Everything that can be refused without a request is refused before the ping.
async function prove(env) {
  if (!env || env.PMA_TEST_MODE !== '1') throw refused('PMA_TEST_MODE is not 1');
  const { world, info, why } = readHost(env);
  if (!world || !info) throw refused(why);
  const data = resolve(env.PMA_DATA_DIR);
  if (!inside(tmpdir(), data, true) || !inside(world.root, data, true)) throw refused('the data dir is not inside this test\'s root under the system temp folder');
  if (!env.PMA_LOCK_DIR || !inside(world.root, env.PMA_LOCK_DIR, true)) throw refused('the lock dir is not this test\'s own');
  if (!world.pids.has(info.pid)) throw refused(`pid ${info.pid} was not recorded as started by this test`);
  let pong; try { pong = await rpc(info, 'ping', {}, 2000); } catch (error) { throw refused('the host did not answer a ping (' + short(error) + ')'); }
  if (pong?.ok !== true) throw refused('the ping was not ok');
  if (pong.testMode !== true) throw refused('the host does not say testMode: true');
  if (!Number.isInteger(pong.pid) || pong.pid !== info.pid) throw refused(`the ping says pid ${pong.pid}, daemon.json says pid ${info.pid}`);
  return info;
}

// call(method, args, timeoutMs) for a world made by isolatedEnv: proof first, then the request. Throws HARNESS_REFUSED otherwise.
export function guardedCall(env) {
  return async function call(method, args = {}, timeoutMs = 60000) {
    const info = await prove(env);
    return rpc(info, method, args, timeoutMs);
  };
}

// Whether a recorded pid still exists. true also when the answer is "exists but not ours to touch" (EPERM): only ESRCH means gone.
// A pid reused by another process reads as alive, which keeps the root: the safe side.
function exists(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } }
// The proof the request needs. A test that bootstraps its host with a read-only command proves it before any mutation it sends.
export async function proveOwned(env) { await prove(env); }

// Stops this world's host, if (and only if) it is proven ours, and waits until every pid this test recorded has EXITED (a closed port
// or a missing daemon.json is not an exit). Never throws, so it is safe in finally / test.after after a failed assertion.
//   {exited: [pids]}            every recorded host is gone (or none was ever recorded and no daemon.json exists)
//   {pending: [pids], note}     still running after waitMs, a daemon.json pid this test never recorded, or 'UNKNOWN_START' (a launch
//                               attempt that left no recorded pid): the caller must keep the root
//   {skipped: reason, pending}  not proven ours: nothing was sent but at most a ping
export async function ownedShutdown(env, { waitMs = 15000 } = {}) {
  const world = worlds.get(keyOf(env?.PMA_DATA_DIR ?? '')); const pids = [...(world?.pids ?? [])];
  const unknownStart = (world?.unknownStarts ?? 0) > 0;
  const { info } = readHost(env);
  // The host daemon.json names now, when this test did not record it: never contacted, never waited out, always pending.
  const foreign = info && !pids.includes(info.pid) ? [info.pid] : [];
  if (!pids.length && !info && !unknownStart) return { exited: [] };
  let skipped = null;
  if (!foreign.length) try { await guardedCall(env)('shutdown', {}, 5000); } catch (error) { skipped = short(error).replace(/^HARNESS_REFUSED: /, ''); }
  const unresolved = () => [...pids.filter(exists), ...foreign, ...(unknownStart ? ['UNKNOWN_START'] : [])];
  if (!foreign.length && !unknownStart) for (const until = Date.now() + waitMs; Date.now() < until;) {
    if (!pids.some(exists)) return skipped ? { skipped, exited: pids } : { exited: pids };
    await sleep(150);
  }
  return { ...(skipped ? { skipped } : {}), exited: pids.filter(pid => !exists(pid)), pending: unresolved(), note: foreign.length ? 'daemon.json names a host this test did not record' : unknownStart ? 'a launch attempt left no recorded pid (UNKNOWN_START)' : 'not proven exited after ' + waitMs + ' ms' };
}

// Children a test spawned itself (follow, a hook, a second host): kept by their handle, closed through it before the host is stopped,
// so none can poll or start a host again after teardown. Only these handles are touched; nothing is found by pid or process name.
export function ownedChildren() {
  const live = new Set();
  const own = child => { live.add(child); child.once('exit', () => live.delete(child)); return child; };
  // Closes every child still running and waits for its exit. The handles that did not exit in time are returned (empty = all closed).
  const closeAll = async (waitMs = 5000) => {
    const running = [...live].filter(c => c.exitCode === null && c.signalCode === null);
    await Promise.all(running.map(c => new Promise(done => { const t = setTimeout(done, waitMs); c.once('exit', () => { clearTimeout(t); done(); }); try { c.kill(); } catch { clearTimeout(t); done(); } })));
    return running.filter(c => c.exitCode === null && c.signalCode === null).map(c => c.pid);
  };
  return { own, closeAll };
}
// A teardown result that is not a full, proven cleanup fails the test (the root is then kept; the error names why).
export function assertCleaned(result) {
  if (result?.cleanup?.removed !== true || result?.stop?.pending?.length) throw new Error('HARNESS_CLEANUP_NOT_CONFIRMED: ' + JSON.stringify({ stop: result?.stop, cleanup: result?.cleanup }));
  return result;
}

// The usual ending: stop our own host, then remove the root ONLY when every host this test recorded has exited. Otherwise the root is
// kept and the result says why (FAILED_CLOSED); nothing is signalled and no other process is touched.
export async function teardown(world) {
  const stop = await ownedShutdown(world.env);
  if (stop.pending?.length) {
    console.error('harness: root kept, host not proven exited (pid ' + stop.pending.join(', ') + (stop.skipped ? '; ' + stop.skipped : '') + '): ' + world.root);
    return { stop, cleanup: { removed: false, kept: world.root, reason: 'FAILED_CLOSED' } };
  }
  return { stop, cleanup: world.cleanup() };
}
