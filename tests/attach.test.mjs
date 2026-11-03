// One activation point (0.12.2): a command from any checkout / cwd / data dir reaches the ONE meeting host of the machine.
// Only in-process fakes: a node:http server that stands in for a host, temp dirs with hand-written daemon.json and runtime.lock.
// The lock's holder is this test process itself (the one PID known to be alive); no other PID is ever probed or signalled, and the
// launcher is replaced by a seam, so nothing here can start a host, open a device or load a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const localDir = mkdtempSync(join(tmpdir(), 'pma-attach-local-'));
const lockDir = mkdtempSync(join(tmpdir(), 'pma-attach-lock-'));
const otherDir = mkdtempSync(join(tmpdir(), 'pma-attach-other-'));
Object.assign(process.env, { PMA_DATA_DIR: localDir, PMA_LOCK_DIR: lockDir, PMA_TEST_MODE: '1' });   // before the import: client reads them once
const { ensureDaemon, inspect, call, setClientForTests } = await import('../dist/client.js');

const freePort = () => new Promise(r => { const s = createNet(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const lockFile = join(lockDir, 'runtime.lock');
const OTHER_PID = 987654321;   // only ever written into a JSON file as a "different pid"; never signalled

// A fake host: answers /rpc ping and status for one bearer token, and records every request it receives.
async function fakeHost(token, pid = process.pid, testMode = true) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = ''; request.on('data', c => { body += c; });
    request.on('end', () => {
      const { method } = JSON.parse(body || '{}'); requests.push({ method, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{"ok":false}'); return; }
      const result = method === 'ping' ? { ok: true, version: 'fake', pid, testMode } : { host: 'FAKE', answeredBy: pid, method };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, token, requests, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
const writeDaemon = (dir, fields) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ version: 'fake', startedAt: new Date().toISOString(), ...fields })); };
const writeLock = fields => writeFileSync(lockFile, JSON.stringify({ pid: process.pid, pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: 'lock-token', dataDir: resolve(otherDir), root: resolve('.'), port: null, since: new Date().toISOString(), sessionId: null, recorderPid: null, workerPid: null, ...fields }));
// Every test starts from nothing, with a launcher that only counts and waits that are short.
function fresh() {
  for (const dir of [localDir, otherDir]) rmSync(join(dir, 'daemon.json'), { force: true });
  rmSync(lockFile, { force: true });
  const launches = []; setClientForTests({ launch: () => launches.push(1), graceMs: 0, startMs: 300 });
  return launches;
}
test.after(() => { for (const dir of [localDir, lockDir, otherDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('local: this data dir\'s daemon.json answers, so that host is used (via local) and nothing is started', async () => {
  const launches = fresh(); const host = await fakeHost('tok-local');
  try {
    writeDaemon(localDir, { url: host.url, pid: process.pid, token: 'tok-local' });
    assert.equal((await ensureDaemon()).url, host.url);
    const status = await inspect();
    assert.equal(status.host, 'FAKE'); assert.deepEqual(status.attached, { via: 'local', dataDir: resolve(localDir), port: host.port, pid: process.pid });
    assert.equal((await call('status')).answeredBy, process.pid);
    assert.equal(launches.length, 0);
  } finally { await host.close(); }
});

test('machine: no daemon.json here, but the lock holder (another data dir) has one with the same pid and answers: attach, do not start', async () => {
  const launches = fresh(); const host = await fakeHost('tok-machine');
  try {
    writeDaemon(otherDir, { url: host.url, pid: process.pid, token: 'tok-machine' });
    writeLock({ dataDir: otherDir, port: host.port });
    assert.equal((await ensureDaemon()).url, host.url);
    const status = await inspect();
    assert.equal(status.host, 'FAKE'); assert.deepEqual(status.attached, { via: 'machine', dataDir: resolve(otherDir), port: host.port, pid: process.pid });
    const reply = await call('status');   // a command from this checkout lands on the host of the other one
    assert.equal(reply.method, 'status'); assert.ok(host.requests.some(r => r.method === 'status' && r.authorization === 'Bearer tok-machine'));
    assert.equal(launches.length, 0);
  } finally { await host.close(); }
});

test('local wins over machine: when both answer, the host of this data dir is used', async () => {
  const launches = fresh(); const a = await fakeHost('tok-a'); const b = await fakeHost('tok-b');
  try {
    writeDaemon(localDir, { url: a.url, pid: process.pid, token: 'tok-a' });
    writeDaemon(otherDir, { url: b.url, pid: process.pid, token: 'tok-b' }); writeLock({ dataDir: otherDir, port: b.port });
    assert.equal((await inspect()).attached.via, 'local'); assert.equal(b.requests.length, 0); assert.equal(launches.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('holder alive but unreachable (no daemon.json, or the port is closed): RUNTIME_BUSY with pid/port/data dir, and the launcher is never reached', async () => {
  const launches = fresh();
  writeLock({ dataDir: otherDir, port: 4321 });   // holder is alive (this process), its folder has no daemon.json
  await assert.rejects(ensureDaemon(), error => /^RUNTIME_BUSY: host PMA của máy đang chạy/.test(error.message) && error.message.includes(`pid ${process.pid}`) && error.message.includes('cổng 4321') && error.message.includes(otherDir) && /Không mở host thứ hai/.test(error.message));
  await assert.rejects(call('status'), /RUNTIME_BUSY/);
  const closed = await freePort();   // daemon.json present, matching pid, but nothing listens
  writeDaemon(otherDir, { url: `http://127.0.0.1:${closed}`, pid: process.pid, token: 'tok-x' }); writeLock({ dataDir: otherDir, port: closed });
  await assert.rejects(ensureDaemon(), /RUNTIME_BUSY: .*không trả lời/);
  assert.equal(launches.length, 0, 'no second host was started');
  // status only reports it.
  const status = await inspect();
  assert.equal(status.host, 'NOT_RUNNING'); assert.equal(status.attached, null); assert.equal(status.machine.pid, process.pid); assert.ok(!('token' in status.machine));
  assert.match(status.note, /đang giữ máy nhưng chưa kết nối được/); assert.equal(launches.length, 0);
});

test('identity guard: a daemon.json whose pid is not the lock holder\'s is not trusted, and its token is never sent', async () => {
  const launches = fresh(); const impostor = await fakeHost('tok-impostor', OTHER_PID);
  try {
    writeDaemon(otherDir, { url: impostor.url, pid: OTHER_PID, token: 'tok-impostor' }); writeLock({ dataDir: otherDir, port: impostor.port });
    await assert.rejects(ensureDaemon(), /RUNTIME_BUSY: .*không khớp pid giữ khoá/);
    assert.equal((await inspect()).host, 'NOT_RUNNING');
    assert.equal(impostor.requests.length, 0, 'not even a ping, so the token went nowhere');
    // The pid matches the lock but the port does not: also refused before any request.
    writeDaemon(otherDir, { url: impostor.url, pid: process.pid, token: 'tok-impostor' }); writeLock({ dataDir: otherDir, port: impostor.port + 1 });
    await assert.rejects(ensureDaemon(), /RUNTIME_BUSY: .*cổng/);
    assert.equal(impostor.requests.length, 0);
    // A URL that is not loopback never receives a token, whatever the file says.
    writeDaemon(otherDir, { url: 'http://example.invalid:9', pid: process.pid, token: 'tok-impostor' }); writeLock({ dataDir: otherDir, port: null });
    await assert.rejects(ensureDaemon(), /RUNTIME_BUSY/);
    assert.equal(launches.length, 0);
  } finally { await impostor.close(); }
});

test('with no holder and no host, the launcher is reached exactly once; inspect never reaches it', async () => {
  const launches = fresh();
  assert.equal((await inspect()).host, 'NOT_RUNNING'); assert.equal(launches.length, 0, 'inspect started nothing');
  await assert.rejects(ensureDaemon(), /DAEMON_NOT_STARTED/);   // the fake launcher starts nothing
  assert.equal(launches.length, 1);
});

test('a host that comes up while we wait for a starting holder is attached (grace period)', async () => {
  const launches = fresh(); const host = await fakeHost('tok-late'); setClientForTests({ graceMs: 5000 });
  try {
    writeLock({ dataDir: otherDir, port: host.port });   // lock taken, daemon.json not yet written
    setTimeout(() => writeDaemon(otherDir, { url: host.url, pid: process.pid, token: 'tok-late' }), 300);
    assert.equal((await ensureDaemon()).url, host.url); assert.equal(launches.length, 0);
  } finally { await host.close(); }
});

// Astra review of 75feff5: a test client must never drive the user's real host. Two walls: its lock namespace is its own, and it
// uses only a host that says it is a test host.
test('a test-mode client never uses a host that is not a test host, even one its own data folder points to; nothing but ping reaches it', async () => {
  const { launches } = fresh();
  const real = await fakeHost('real-token', process.pid, false);
  try {
    writeDaemon(localDir, { url: real.url, pid: process.pid, token: 'real-token' });
    await assert.rejects(call('finish', {}), error => !/answeredBy/.test(String(error)));
    assert.deepEqual([...new Set(real.requests.map(r => r.method))], ['ping'], 'only pings: no finish, shutdown or purge');
    assert.equal(launches.length, 1, 'it starts its own (test) host instead, through the counting launcher');
    const seen = await inspect(); assert.equal(seen.host, 'NOT_RUNNING');
  } finally { await real.close(); }
});

test('with PMA_TEST_MODE and no PMA_LOCK_DIR, the lock folder is inside the data folder, never the user\'s', async () => {
  const lock = await import('../dist/machine_lock.js');
  const saved = { ...process.env };
  try {
    delete process.env.PMA_LOCK_DIR; process.env.PMA_TEST_MODE = '1'; process.env.PMA_DATA_DIR = localDir;
    assert.equal(resolve(lock.lockDir()), resolve(join(localDir, 'machine-lock')));
    process.env.PMA_TEST_MODE = '0';
    assert.notEqual(resolve(lock.lockDir()), resolve(join(localDir, 'machine-lock')), 'outside test mode: the normal folder');
  } finally { for (const key of ['PMA_LOCK_DIR', 'PMA_TEST_MODE', 'PMA_DATA_DIR']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
