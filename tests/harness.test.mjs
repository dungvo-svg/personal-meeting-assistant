// The test harness itself (tests/harness.mjs): the third wall between a test and the user's real meeting host. Pure in-process:
// node:http servers on loopback that stand in for a host, temp roots made by the harness. No PID but this process's own is ever
// probed (the only others are numbers written into JSON files as "a different pid"), no signal is sent, nothing is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyEnv, guardedCall, isolatedEnv, ownedShutdown, recordHost, recordingHost, teardown } from './harness.mjs';

const OTHER_PID = 987654321;   // only ever written into a JSON file as "a different pid"; never signalled
const TOKEN = 'tok-harness-secret';
const worlds = []; const servers = []; const extras = [];
const world = async label => { const w = await isolatedEnv(label); worlds.push(w); return w; };
test.after(async () => {
  for (const server of servers) await new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  for (const w of worlds) w.cleanup();
  for (const dir of extras) rmSync(dir, { recursive: true, force: true });
});

// A fake host: answers ping (as configured) and anything else, records every request. `shutdown` removes daemon.json like the real one.
async function fakeHost(w, { pong = {}, daemon = {}, token = TOKEN } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = ''; request.on('data', c => { body += c; });
    request.on('end', () => {
      const { method } = JSON.parse(body || '{}'); requests.push({ method, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{"ok":false}'); return; }
      let result;
      if (method === 'ping') result = { ok: true, version: 'fake', pid: process.pid, testMode: true, ...pong };
      else { result = { method, stopping: method === 'shutdown' }; if (method === 'shutdown') rmSync(join(w.env.PMA_DATA_DIR, 'daemon.json'), { force: true }); }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const write = more => writeFileSync(join(w.env.PMA_DATA_DIR, 'daemon.json'), JSON.stringify({ url, pid: process.pid, token, version: 'fake', startedAt: new Date().toISOString(), ...daemon, ...more }));
  write({});
  return { url, requests, write, methods: () => [...new Set(requests.map(r => r.method))] };
}
const ENV_KEYS = ['PMA_DATA_DIR', 'PMA_LOCK_DIR', 'PMA_PORT', 'PMA_STOP_HOOK', 'PMA_TEST_MODE', 'PMA_WARM'];

test('isolatedEnv: its own root, data dir, lock dir and port; no PMA_* inherited from the parent; process.env only through applyEnv', async () => {
  const parent = { PMA_LOCK_DIR: join(tmpdir(), 'the-users-lock'), PMA_PYTHON: 'python-of-the-user', PMA_EXIT_AFTER_FINISH: '1', PMA_FOO: 'x' };
  const kept = Object.fromEntries(Object.keys(parent).map(key => [key, process.env[key]]));
  Object.assign(process.env, parent);
  try {
    const a = await world('alpha beta/../x'); const b = await world('beta');
    assert.deepEqual(Object.keys(a.env).filter(key => /^PMA_/i.test(key)).sort(), ENV_KEYS, 'only what the harness sets');
    assert.equal(a.env.PMA_TEST_MODE, '1'); assert.equal(a.env.PMA_STOP_HOOK, 'off'); assert.equal(a.env.PMA_WARM, '0');
    assert.equal(a.env.PMA_DATA_DIR, join(a.root, 'data')); assert.equal(a.env.PMA_LOCK_DIR, join(a.root, 'lock'));
    assert.notEqual(a.env.PMA_LOCK_DIR, parent.PMA_LOCK_DIR, 'never the parent\'s lock');
    assert.ok(a.root.startsWith(join(tmpdir(), 'pma-alpha-beta')), 'the root is under the temp folder and carries the label, cleaned of path characters: ' + a.root);
    assert.ok(existsSync(a.env.PMA_DATA_DIR) && existsSync(a.env.PMA_LOCK_DIR));
    const port = Number(a.env.PMA_PORT); assert.ok(Number.isInteger(port) && port > 1023 && port < 65536);
    assert.notEqual(a.root, b.root); assert.notEqual(a.env.PMA_LOCK_DIR, b.env.PMA_LOCK_DIR); assert.notEqual(a.env.PMA_DATA_DIR, b.env.PMA_DATA_DIR);
    assert.ok(a.env.PATH !== undefined || a.env.Path !== undefined, 'the rest of the environment is kept for spawned commands');

    const restore = applyEnv({ ...a.env, PMA_HARNESS_ONLY: '100' });
    assert.equal(process.env.PMA_DATA_DIR, a.env.PMA_DATA_DIR); assert.equal(process.env.PMA_LOCK_DIR, a.env.PMA_LOCK_DIR); assert.equal(process.env.PMA_HARNESS_ONLY, '100');
    for (const key of ['PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH', 'PMA_FOO']) assert.equal(process.env[key], undefined, key + ' of the parent is gone while the test runs');
    restore();
    assert.equal(process.env.PMA_LOCK_DIR, parent.PMA_LOCK_DIR); assert.equal(process.env.PMA_PYTHON, parent.PMA_PYTHON); assert.equal(process.env.PMA_HARNESS_ONLY, undefined);
  } finally { for (const [key, value] of Object.entries(kept)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('guardedCall refuses a host whose ping says testMode false: only a ping is sent, never the request itself', async () => {
  const w = await world('testmode'); const host = await fakeHost(w, { pong: { testMode: false } });
  assert.equal(recordHost(w.env), process.pid);
  await assert.rejects(guardedCall(w.env)('finish', {}), /^Error: HARNESS_REFUSED: .*testMode/);
  assert.deepEqual(host.methods(), ['ping']);
  host.write({ token: TOKEN }); await assert.rejects(guardedCall(w.env)('shutdown'), /HARNESS_REFUSED/); assert.deepEqual(host.methods(), ['ping'], 'nor a shutdown');
});

test('guardedCall refuses a ping from another pid than daemon.json names', async () => {
  const w = await world('pidmismatch'); const host = await fakeHost(w, { pong: { pid: OTHER_PID } });
  recordHost(w.env);
  await assert.rejects(guardedCall(w.env)('finish', {}), /HARNESS_REFUSED: .*pid/);
  assert.deepEqual(host.methods(), ['ping']);
  // and a daemon.json that now names a pid this test did not record (another host moved in) is refused before any request
  const before = host.requests.length; host.write({ pid: OTHER_PID });
  await assert.rejects(guardedCall(w.env)('finish', {}), /HARNESS_REFUSED: pid \d+ was not recorded/);
  assert.equal(host.requests.length, before, 'not even a ping');
});

test('guardedCall refuses a host this test did not start: no request at all, so the token goes nowhere', async () => {
  const w = await world('foreign'); const host = await fakeHost(w);   // a perfect-looking test host, but recordHost() was never called for it
  await assert.rejects(guardedCall(w.env)('finish', {}), /HARNESS_REFUSED: pid \d+ was not recorded as started by this test/);
  assert.equal(host.requests.length, 0);
  // a daemon.json older than the world (left by someone before this test existed) is not recorded either
  host.write({ startedAt: new Date(Date.now() - 3600000).toISOString() }); assert.equal(recordHost(w.env), null);
  await assert.rejects(guardedCall(w.env)('finish', {}), /HARNESS_REFUSED/); assert.equal(host.requests.length, 0);
  // not loopback, not well formed, not a world of ours, not test mode: refused with nothing sent
  host.write({ url: 'http://example.invalid:9' }); assert.equal(recordHost(w.env), null); await assert.rejects(guardedCall(w.env)('finish'), /HARNESS_REFUSED: daemon\.json url is not loopback/);
  host.write({ token: '' }); await assert.rejects(guardedCall(w.env)('finish'), /HARNESS_REFUSED: daemon\.json is not well formed/);
  host.write({});   // a good, loopback, unrecorded daemon.json again, for the checks on the environment itself
  const strange = mkdtempSync(join(tmpdir(), 'pma-harness-strange-')); extras.push(strange);
  writeFileSync(join(strange, 'daemon.json'), JSON.stringify({ url: host.url, pid: process.pid, token: TOKEN, startedAt: new Date().toISOString() }));
  await assert.rejects(guardedCall({ ...w.env, PMA_DATA_DIR: strange })('finish'), /HARNESS_REFUSED: the data dir was not made by isolatedEnv/);
  await assert.rejects(guardedCall({ ...w.env, PMA_TEST_MODE: '0' })('finish'), /HARNESS_REFUSED: PMA_TEST_MODE/);
  await assert.rejects(guardedCall({ ...w.env, PMA_LOCK_DIR: join(tmpdir(), 'the-users-lock') })('finish'), /HARNESS_REFUSED: the lock dir is not this test's own/);
  assert.equal(host.requests.length, 0);
});

test('ownedShutdown after a thrown assertion (in finally, as in test.after) still refuses a foreign host, and says so instead of throwing', async () => {
  const foreign = await world('after-foreign'); const host = await fakeHost(foreign);   // never recorded
  let thrown = null; let outcome;
  try { assert.equal(1, 2, 'an assertion of the test failed'); }
  catch (error) { thrown = error; }
  finally { outcome = await ownedShutdown(foreign.env); }
  assert.ok(thrown instanceof assert.AssertionError); assert.match(outcome.skipped, /not recorded as started by this test/); assert.equal(host.requests.length, 0);
  // recorded, but it says it is not a test host (a real host that took the port): nothing but a ping, and still no throw
  const real = await world('after-real'); const user = await fakeHost(real, { pong: { testMode: false } }); recordHost(real.env);
  try { assert.equal(1, 2); } catch { /* the failure is the test's own business */ } finally { outcome = await ownedShutdown(real.env); }
  assert.match(outcome.skipped, /testMode/); assert.deepEqual(user.methods(), ['ping']);
  // no host at all (it already left): benign
  const gone = await world('after-gone'); assert.deepEqual(await ownedShutdown(gone.env), { skipped: 'no daemon.json in the data dir' });
  assert.deepEqual(await ownedShutdown({ ...gone.env, PMA_DATA_DIR: tmpdir() }), { skipped: 'the data dir was not made by isolatedEnv' });
});

test('a host this test started: proof passes, the request carries the bearer token, ownedShutdown stops it and waits for it to go', async () => {
  const w = await world('owned'); const host = await fakeHost(w);
  assert.equal(await recordingHost(w.env, async () => 'started'), 'started'); assert.equal(recordHost(w.env), process.pid);
  assert.deepEqual(await guardedCall(w.env)('status'), { method: 'status', stopping: false });
  assert.ok(host.requests.every(r => r.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(await ownedShutdown(w.env), { stopped: process.pid });
  assert.deepEqual(host.methods(), ['ping', 'status', 'shutdown']); assert.ok(!existsSync(join(w.env.PMA_DATA_DIR, 'daemon.json')));
  await assert.rejects(recordingHost(w.env, async () => { throw new Error('the start failed'); }), /the start failed/, 'recordingHost does not swallow errors');
  const done = await teardown(w); assert.deepEqual(done.cleanup, { removed: true }); assert.ok(!existsSync(w.root));
});

test('cleanup refuses a path outside its root or outside the temp folder, removes nothing in that case, and removes its own root', async () => {
  const w = await world('cleanup'); const sibling = mkdtempSync(join(tmpdir(), 'pma-harness-sibling-')); extras.push(sibling);
  writeFileSync(join(sibling, 'keep.txt'), 'keep'); writeFileSync(join(w.root, 'mine.txt'), 'mine');
  assert.throws(() => w.cleanup(sibling), /^Error: HARNESS_REFUSED: .*outside/);   // under tmpdir, but not under the root
  assert.throws(() => w.cleanup(join(w.root, '..')), /HARNESS_REFUSED/);
  assert.throws(() => w.cleanup(tmpdir()), /HARNESS_REFUSED/);
  assert.throws(() => w.cleanup(resolve('.')), /HARNESS_REFUSED: .*outside/);   // not even under the temp folder
  assert.throws(() => w.cleanup(join(w.root, 'mine.txt'), sibling), /HARNESS_REFUSED/); assert.ok(existsSync(join(w.root, 'mine.txt')), 'one bad path stops them all before anything is removed');
  assert.ok(existsSync(join(sibling, 'keep.txt')) && existsSync(w.root));
  assert.deepEqual(w.cleanup(join(w.root, 'mine.txt')), { removed: true }); assert.ok(!existsSync(join(w.root, 'mine.txt')) && existsSync(w.root));
  assert.deepEqual(w.cleanup(), { removed: true }); assert.ok(!existsSync(w.root)); assert.ok(existsSync(sibling));
});
