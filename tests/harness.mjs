// Test harness: the third wall (after machine_lock.ts lockDir() and client.ts locate()) between a test and the USER'S REAL meeting host.
// A test that starts a host gets a world of its own (temp root, data dir, lock dir, free loopback port, no inherited PMA_*), and every
// request the harness sends itself (shutdown in cleanup, mostly) goes out only after the target is PROVEN to be a host this test
// started: loopback url, a ping that says testMode: true and the same pid as daemon.json, and that pid recorded by recordHost() right
// after the test started it. Anything else is refused with HARNESS_REFUSED and nothing but (at most) a ping is sent: fail closed.
// No function here sends a signal, spawns a process or opens a device. The bearer token is never printed or put in an error.
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
  worlds.set(keyOf(data), { root, createdAt: Date.now(), pids: new Set() });
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
// Runs fn (the thing that starts a host) and records the host afterwards even when fn throws.
export async function recordingHost(env, fn) { try { return await fn(); } finally { recordHost(env); } }

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

// Stops this world's host, if (and only if) it is proven ours; waits until it has gone (its daemon.json is gone before its port is
// freed). Never throws, so it is safe in finally / test.after after a failed assertion. {stopped: pid} or {skipped: reason}.
export async function ownedShutdown(env, { waitMs = 10000 } = {}) {
  const call = guardedCall(env); const pid = readHost(env).info?.pid ?? null;
  try { await call('shutdown', {}, 5000); }
  catch (error) { return { skipped: short(error).replace(/^HARNESS_REFUSED: /, '') }; }
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    try { await prove(env); } catch { return { stopped: pid }; }   // not provable any more: daemon.json gone or the port closed
    await sleep(100);
  }
  return { stopped: pid, note: 'still answering after ' + waitMs + ' ms' };
}

// The usual ending: stop our own host (if proven), then remove the root. A refusal to stop is told, except "nothing was running".
export async function teardown(world) {
  const stop = await ownedShutdown(world.env);
  if (stop.skipped && !/no daemon\.json/.test(stop.skipped)) console.error('harness: host not stopped (' + stop.skipped + ')');
  return { stop, cleanup: world.cleanup() };
}
