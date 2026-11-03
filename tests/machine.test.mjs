// One meeting runtime per machine (0.12.1, ENG-36), after the 03/11 meeting where a second host from another checkout recorded the same
// speaker and filled the GPU. The lock module on its own, then two real test hosts (two data folders, two ports, one lock folder).
// Synthetic only: no device, no model, no audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNet } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = createNet(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const lockDir = mkdtempSync(join(tmpdir(), 'pma-lock-test-')); process.env.PMA_LOCK_DIR = lockDir;
const lock = await import('../dist/machine_lock.js');
const lockFile = join(lockDir, 'runtime.lock');
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); return Number(r.stdout.trim()); };
const owner = more => ({ pid: process.pid, pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: 'other', dataDir: resolve('x'), root: resolve('.'), port: 1, since: new Date().toISOString(), sessionId: null, recorderPid: null, workerPid: null, ...more });

test('the lock: one holder; a second runtime is refused with who holds it; only the holder updates or releases', () => {
  const a = lock.claimMachine({ token: 'aaaa', dataDir: 'dataA', root: '.', port: 1001 });
  assert.equal(a.pid, process.pid); assert.equal(lock.claimMachine({ token: 'aaaa', dataDir: 'dataA', root: '.', port: 1001 }).token, 'aaaa', 'claiming again changes nothing');
  assert.throws(() => lock.claimMachine({ token: 'bbbb', dataDir: 'dataB', root: '.', port: 1002 }), /RUNTIME_BUSY: một host PMA khác đang giữ máy \(pid \d+, cổng 1001, dữ liệu .*dataA/);
  assert.equal(lock.updateMachine('bbbb', { sessionId: 's' }), false); assert.equal(lock.updateMachine('aaaa', { recorderPid: 42 }), true); assert.equal(lock.readLock().recorderPid, 42);
  assert.equal(lock.releaseMachine('bbbb'), false); assert.ok(existsSync(lockFile));
  assert.equal(lock.releaseMachine('aaaa'), true); assert.ok(!existsSync(lockFile));
  assert.equal(lock.claimMachine({ token: 'bbbb', dataDir: 'dataB', root: '.', port: 1002 }).token, 'bbbb'); lock.releaseMachine('bbbb');
});

test('the lock is stale only when its holder is gone: a dead PID, or a live PID that started at another time (reused); no time limit', () => {
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), since: new Date(0).toISOString() })));
  assert.equal(lock.claimMachine({ token: 'cccc', dataDir: 'dataC', root: '.', port: 1 }).token, 'cccc'); lock.releaseMachine('cccc');
  // A live PID with the wrong start time is another process that got the same number.
  writeFileSync(lockFile, JSON.stringify(owner({ pidStartedAt: new Date(Date.now() - 86400000).toISOString() })));
  assert.equal(lock.claimMachine({ token: 'dddd', dataDir: 'dataD', root: '.', port: 1 }).token, 'dddd'); lock.releaseMachine('dddd');
  // An old lock whose holder is alive is not taken, however old.
  writeFileSync(lockFile, JSON.stringify(owner({ since: new Date(0).toISOString() })));
  assert.throws(() => lock.claimMachine({ token: 'eeee', dataDir: 'dataE', root: '.', port: 1 }), /RUNTIME_BUSY/);
  rmSync(lockFile, { force: true });
});

test('a host that died while its recorder goes on still holds the machine: another data folder is refused, its own data folder may take the meeting over', () => {
  const alive = process.pid;   // stands for the recorder that is still running
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), dataDir: resolve('dataF'), recorderPid: alive })));
  assert.throws(() => lock.claimMachine({ token: 'ffff', dataDir: 'dataOther', root: '.', port: 1 }), /RUNTIME_BUSY: host cũ đã dừng nhưng bộ ghi\/bộ nghe của nó còn chạy/);
  assert.equal(lock.claimMachine({ token: 'gggg', dataDir: 'dataF', root: '.', port: 1 }).token, 'gggg'); lock.releaseMachine('gggg');
});

test('two data folders and ports, one machine: the second folder reaches the first host (attach), never a second host; finish frees the machine; status with no host starts nothing', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'pma-machine-a-')), mkdtempSync(join(tmpdir(), 'pma-machine-b-'))];
  const ports = [String(await freePort()), String(await freePort())];
  const envOf = i => ({ ...process.env, PMA_PORT: ports[i], PMA_TEST_MODE: '1', PMA_DATA_DIR: dirs[i], PMA_LOCK_DIR: lockDir, PMA_STOP_HOOK: 'off', PMA_WARM: '0' });
  const pma = (i, ...args) => new Promise(res => { const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], { env: envOf(i) }); let out = ''; child.stdout.on('data', d => { out += d; }); child.on('exit', code => res({ out, code, json: (() => { try { return JSON.parse(out); } catch { return null; } })() })); });
  try {
    // No host yet: status only looks.
    const none = await pma(1, 'status'); assert.equal(none.json.host, 'NOT_RUNNING'); assert.ok(!existsSync(join(dirs[1], 'daemon.json')), 'status started no host');
    const a = await pma(0, 'start', '--title', 'Họp A', '--no-select'); assert.equal(a.code, 0, a.out);
    // One activation point (0.12.1, client attach): from data folder B the command reaches A's host, the one meeting of this machine;
    // no second host is started.
    const b = await pma(1, 'start', '--title', 'Họp B', '--no-select'); assert.equal(b.code, 0, b.out); assert.equal(b.json.session.id, a.json.session.id, 'B joined the meeting A opened');
    assert.ok(!existsSync(join(dirs[1], 'daemon.json')), 'no host was started for folder B');
    const seen = (await pma(1, 'status')).json; assert.equal(seen.session.id, a.json.session.id); assert.equal(seen.attached.via, 'machine'); assert.equal(seen.attached.port, Number(ports[0])); assert.ok(!JSON.stringify(seen).includes('"token"'));
    const stopped = await pma(0, 'stop'); assert.equal(stopped.code, 0, stopped.out);
    const b2 = await pma(1, 'start', '--title', 'Họp B', '--no-select'); assert.equal(b2.code, 0, b2.out);
    assert.equal((await pma(1, 'status')).json.machine.mine, true);
    await pma(1, 'stop');
  } finally {
    for (const i of [0, 1]) { await pma(i, 'shutdown').catch(() => {}); }
    await sleep(500); for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('the MCP adapter starts no host on connect, and session_status only looks', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const data = mkdtempSync(join(tmpdir(), 'pma-mcp-inspect-')); const port = String(await freePort());
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), PMA_TEST_MODE: '1', PMA_DATA_DIR: data, PMA_PORT: port, PMA_LOCK_DIR: lockDir };
  const client = new Client({ name: 'pma-inspect-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env, stderr: 'pipe' });
  try {
    await client.connect(transport); await sleep(1500);
    assert.ok(!existsSync(join(data, 'daemon.json')), 'connecting started no host');
    const status = JSON.parse((await client.callTool({ name: 'session_status', arguments: {} })).content[0].text);
    assert.equal(status.host, 'NOT_RUNNING'); assert.ok(!existsSync(join(data, 'daemon.json')), 'status started no host');
  } finally { await client.close().catch(() => {}); await sleep(300); rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});

test('two hosts that judge the same lock stale at once: the second does not move the first one\'s fresh lock (deterministic interleaving)', () => {
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), token: 'old0' })));
  // B has read the stale lock and is about to take it; right then A takes it all the way (the replayed race of review finding a).
  assert.throws(() => lock.claimMachine({ token: 'bbbb', dataDir: 'dataB', root: '.', port: 2 }, { onStale: () => lock.claimMachine({ token: 'aaaa', dataDir: 'dataA', root: '.', port: 1 }) }), /RUNTIME_BUSY: một host PMA khác đang giữ máy/);
  assert.equal(lock.readLock().token, 'aaaa', 'A keeps the lock it took');
  assert.ok(!existsSync(lockFile + '.takeover'), 'the takeover guard is gone');
  lock.releaseMachine('aaaa');
  // A guard left by a host that died is not cleared by a host (fail closed): the claim stops and names it.
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), token: 'old1' }))); writeFileSync(lockFile + '.takeover', JSON.stringify(owner({ pid: deadPid(), token: 'g1' })));
  assert.throws(() => lock.claimMachine({ token: 'cccc', dataDir: 'dataC', root: '.', port: 3 }), /khoá phụ/); rmSync(lockFile + '.takeover', { force: true });
  assert.equal(lock.claimMachine({ token: 'cccc', dataDir: 'dataC', root: '.', port: 3 }).token, 'cccc'); lock.releaseMachine('cccc');
});

test('the takeover guard: a contender inside another host\'s critical section changes nothing; no host ever removes a guard, live or gone (fail closed)', () => {
  // Inside A's guard (lock read again, about to be moved), B tries: B must not enter, and A's take-over completes alone.
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), token: 'old2' })));
  let inside = null;
  const a = lock.claimMachine({ token: 'aaa2', dataDir: 'dataA', root: '.', port: 1 }, { inGuard: () => {
    const guard = JSON.parse(readFileSync(lockFile + '.takeover', 'utf8')); assert.equal(guard.pid, process.pid, 'the guard is whole while held');
    try { lock.claimMachine({ token: 'bbb2', dataDir: 'dataB', root: '.', port: 2 }); inside = 'entered'; } catch (error) { inside = String(error.message); }
  } });
  assert.equal(a.token, 'aaa2'); assert.match(inside, /RUNTIME_BUSY/); assert.equal(lock.readLock().token, 'aaa2'); assert.ok(!existsSync(lockFile + '.takeover'));
  lock.releaseMachine('aaa2');
  // A guard of a live process (this one) from long ago: not removed, so the claim does not get through.
  writeFileSync(lockFile, JSON.stringify(owner({ pid: deadPid(), token: 'old3' })));
  writeFileSync(lockFile + '.takeover', JSON.stringify(owner({ token: 'liveguard', since: new Date(0).toISOString() })));
  assert.throws(() => lock.claimMachine({ token: 'ccc2', dataDir: 'dataC', root: '.', port: 3 }), /RUNTIME_BUSY/);
  assert.equal(JSON.parse(readFileSync(lockFile + '.takeover', 'utf8')).token, 'liveguard', 'a live holder keeps its guard');
  // The same guard once its holder is gone: still never removed by a host (fail closed, review of 13cd5e8 finding 2); the error
  // names the file to remove. Removed by hand, the claim goes through.
  writeFileSync(lockFile + '.takeover', JSON.stringify(owner({ pid: deadPid(), token: 'deadguard' })));
  assert.throws(() => lock.claimMachine({ token: 'ccc2', dataDir: 'dataC', root: '.', port: 3 }), /RUNTIME_BUSY: khoá phụ .*runtime\.lock\.takeover còn lại từ pid \d+ đã dừng/);
  assert.equal(JSON.parse(readFileSync(lockFile + '.takeover', 'utf8')).token, 'deadguard', 'not removed by the host');
  rmSync(lockFile + '.takeover', { force: true });
  assert.equal(lock.claimMachine({ token: 'ccc2', dataDir: 'dataC', root: '.', port: 3 }).token, 'ccc2'); lock.releaseMachine('ccc2');
});
