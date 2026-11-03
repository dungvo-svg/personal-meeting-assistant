// Agent control of the right session from another folder (03/11, runbook docs/RUNBOOK_AGENT_CONTROL.md), with NO capture at all. The
// meeting is a diagnostic fixture session (prepare{fixture:true}) made through the guarded RPC of a harness world (temp root/data/lock,
// private port, PMA_TEST_MODE=1); fixture:true is what keeps every capture path off (PMA_WARM is not forwarded to a host started through
// WMI). The candidate's CLI is then run by absolute path from the BidOps project folder (nothing there is read or written) for
// status and stop: a valid but WRONG session id is refused and leaves the meeting open; the RIGHT one ends exactly that meeting; capture,
// recorder and worker stay off throughout. A stop with no host running starts none. CLI start is NOT exercised (it is an activation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const BIDOPS = 'D:\\WORK\\Agent\\Agent-first\\NNC BidOps Agent';
const CLI = resolve('dist/cli.js');
const run = promisify(execFile);
// The CLI as an agent runs it: absolute entry, from the BidOps folder, with this world's PMA_* only. Exit code is returned, not thrown.
const cli = (env, ...args) => run(process.execPath, [CLI, ...args], { cwd: BIDOPS, env, windowsHide: true }).then(r => ({ code: 0, ...r }), e => ({ code: e.code ?? 1, stdout: e.stdout, stderr: e.stderr }));
const json = r => JSON.parse(r.stdout);
const OTHER = '00000000-0000-4000-8000-000000000123';
const skip = !existsSync(BIDOPS) && 'the BidOps folder is not on this machine';

test('from the BidOps folder: status names the right meeting, a wrong session id stops nothing, the right one ends exactly it, nothing captures', { skip }, async () => {
  const world = await isolatedEnv('control'); const restoreEnv = applyEnv(world.env);
  const { call } = await import('../dist/client.js');
  try {
    await recordingHost(world.env, () => call('history')); const owned = guardedCall(world.env);
    const pong = await owned('ping');
    const { session } = await owned('prepare', { title: 'FIXTURE điều khiển phiên, không phải cuộc họp', fixture: true, languages: ['vi'] });
    const off = s => { assert.equal(s.captureState, 'OFF'); assert.equal(s.recorder?.state, 'OFF'); assert.equal(s.recorder?.pid ?? null, null); assert.equal(s.asr?.wanted, false); };

    // 1. Inspect first: the host, the data dir and the meeting it names.
    const look = json(await cli(world.env, 'status'));
    assert.equal(look.attached.pid, pong.pid); assert.equal(resolve(look.attached.dataDir).toLowerCase(), resolve(world.env.PMA_DATA_DIR).toLowerCase());
    assert.equal(look.session.id, session.id); assert.equal(look.session.ended, null); assert.equal(look.host.protocol, 'pma-rpc/2'); off(look);

    // 2. A valid but wrong id: refused, the meeting stays open.
    const wrong = await cli(world.env, 'stop', '--session', OTHER);
    assert.notEqual(wrong.code, 0); assert.match(wrong.stdout + wrong.stderr, /SESSION_NOT_FOUND/);
    const still = json(await cli(world.env, 'status')); assert.equal(still.session.id, session.id); assert.equal(still.session.ended, null); off(still);

    // 3. The right id: exactly this meeting ends; RAW is written inside this world; still nothing captured.
    const stopped = await cli(world.env, 'stop', '--session', session.id);
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr); const r = json(stopped);
    assert.equal(r.session.id, session.id); assert.ok(r.raw?.path && resolve(r.raw.path).toLowerCase().startsWith(resolve(world.root).toLowerCase() + '\\'));
    const after = json(await cli(world.env, 'status')); assert.equal(after.session.id, session.id); assert.notEqual(after.session.ended, null); off(after);
    assert.equal(after.attached.pid, pong.pid, 'the same host answered every command');
    assert.match(readFileSync(r.raw.path, 'utf8'), /FIXTURE điều khiển phiên/);
  } finally {
    try { assertCleaned(await teardown(world)); } finally { restoreEnv(); }
  }
});

test('a stop with no host running starts no host and says so', { skip }, async () => {
  const world = await isolatedEnv('control-none'); const restoreEnv = applyEnv(world.env);
  try {
    const r = await cli(world.env, 'stop', '--session', OTHER);
    assert.notEqual(r.code, 0); assert.match(r.stdout + r.stderr, /HOST_NOT_RUNNING/);
    assert.equal(existsSync(join(world.env.PMA_DATA_DIR, 'daemon.json')), false, 'no host was launched');
    assert.equal(json(await cli(world.env, 'status')).host, 'NOT_RUNNING', 'status only looks');
  } finally {
    try { assertCleaned(await teardown(world)); } finally { restoreEnv(); }
  }
});
