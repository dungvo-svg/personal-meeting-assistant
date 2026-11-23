// An older host still running after an upgrade (03/11, Codex finding on dfaf1d3): a draft of this build must not reach a host that does
// not say it enforces the draft contract, while status, reading and stop keep working with it. The "host" here is a small HTTP server
// inside this test process, answering /rpc like a daemon (an 0.11 ping, a partial one, the current one) and recording every request;
// its daemon.json is written into a harness world (temp root/data/lock, PMA_TEST_MODE=1). The client's launcher is replaced by one that
// throws, so no host can be spawned; no device, no model, no audio, no signal. The fake's daemon.json is removed and the server closed
// before teardown, which then must confirm a full cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyEnv, assertCleaned, isolatedEnv, teardown } from './harness.mjs';

const world = await isolatedEnv('host-protocol'); const restoreEnv = applyEnv(world.env);
const client = await import('../dist/client.js');
const { CAPABILITIES, PROTOCOL } = await import('../dist/protocol.js');
client.setClientForTests({ launch: () => { throw new Error('NO_LAUNCH_IN_TEST: this test never starts a host'); }, graceMs: 0, startMs: 0 });

const TOKEN = 'host-protocol-test-token';
const PINGS = {
  legacy: { ok: true, version: '0.11.0', pid: process.pid, testMode: true },                                   // a771aeb's ping
  partial: { ok: true, version: '0.12.1', pid: process.pid, testMode: true, protocol: PROTOCOL, capabilities: ['context-receipt/1'] },
  current: { ok: true, version: '0.12.1', pid: process.pid, testMode: true, protocol: PROTOCOL, capabilities: [...CAPABILITIES] },
  // An earlier 0.12.1 build: the same version string and every capability of its time, but mic-session/1 only.
  v1only: { ok: true, version: '0.12.1', pid: process.pid, testMode: true, protocol: PROTOCOL, capabilities: ['draft-guard/1', 'context-receipt/1', 'job-token/1', 'mic-session/1'] },
};
let mode = 'legacy'; const received = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; });
  req.on('end', () => {
    const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url !== '/rpc' || req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
    const { method, args } = JSON.parse(body || '{}'); received.push({ method, args });
    if (method === 'ping') return reply({ ok: true, result: PINGS[mode] });
    if (method === 'status') return reply({ ok: true, result: { session: null, captureState: 'OFF' } });
    return reply({ ok: true, result: { accepted: method } });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const daemonJson = join(world.env.PMA_DATA_DIR, 'daemon.json');
writeFileSync(daemonJson, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, token: TOKEN, version: 'fake', startedAt: new Date().toISOString() }));

test.after(async () => {
  try {
    rmSync(daemonJson, { force: true }); await new Promise(r => server.close(r));
    assertCleaned(await teardown(world));
  } finally { restoreEnv(); }
});

const DRAFTS = [
  ['picture', { text: 'Bức tranh.', sourceIds: [1], receipt: 'rcpt-0000000000000000', expectedRevision: 0 }],
  ['translate', { items: [{ sourceId: 1, text: 'Xin chào' }] }],
  ['participants', { participants: [{ name: 'Quân' }] }],
  ['summary', { markdown: '- Một.', sourceIds: [1], receipt: 'rcpt-0000000000000000', expectedRevision: 0 }],
  ['tasks', { tasks: [], receipt: 'rcpt-0000000000000000', expectedRevision: 0 }],
  ['job', { action: 'done', id: 1, result: 'Xong.', token: 'job-0000000000000000' }],
];
const drafts = () => received.filter(r => r.method !== 'ping' && r.method !== 'status' && r.method !== 'finish' && r.method !== 'read');

test('an 0.11 host (no capabilities) receives zero draft payloads; status, read and finish still work with it', async () => {
  mode = 'legacy'; received.length = 0;
  for (const [method, args] of DRAFTS) await assert.rejects(client.attach(method, args), /HOST_PROTOCOL_OLD: .*draft-guard\/1/, method);
  assert.deepEqual(drafts(), [], 'no draft method reached the old host');
  assert.ok(received.every(r => r.method === 'ping' && JSON.stringify(r.args) === '{}'), 'only pings, with no payload');
  const look = await client.inspect();
  assert.equal(look.host.draftsAllowed, false); assert.deepEqual(look.host.capabilities, []); assert.equal(look.host.version, '0.11.0');
  assert.deepEqual(await client.call('read', {}), { accepted: 'read' });
  assert.deepEqual(await client.call('finish', {}), { accepted: 'finish' }, 'an explicit stop still reaches the old host');
  assert.deepEqual(await client.reach('finish', {}), { accepted: 'finish' }, 'and so does the stop path (reach) of the CLI and MCP: not gated by capabilities');
});

test('a host missing one needed capability is refused the same way, naming what is missing; a job also needs job-token', async () => {
  mode = 'partial'; received.length = 0;
  await assert.rejects(client.attach('summary', DRAFTS[3][1]), /HOST_PROTOCOL_OLD: .*draft-guard\/1/);
  await assert.rejects(client.attach('job', DRAFTS[5][1]), /draft-guard\/1, job-token\/1/);
  assert.deepEqual(drafts(), []);
});

test('the current host is sent every draft unchanged', async () => {
  mode = 'current'; received.length = 0;
  for (const [method, args] of DRAFTS) assert.deepEqual(await client.attach(method, args), { accepted: method });
  assert.deepEqual(drafts().map(r => [r.method, r.args]), DRAFTS, 'each draft arrived once, as sent');
  assert.equal((await client.inspect()).host.draftsAllowed, true);
});

test('the real host says what it implements: its ping carries the protocol and exactly the listed capabilities (read as text)', () => {
  const daemon = readFileSync(resolve('src/daemon.ts'), 'utf8');
  assert.match(daemon, /ping: \(\) => \(\{ ok: true, version: VERSION, pid: process\.pid, testMode: runtime\.testMode, protocol: PROTOCOL, capabilities: \[\.\.\.CAPABILITIES\] \}\)/);
  assert.deepEqual([...CAPABILITIES], ['draft-guard/1', 'context-receipt/1', 'job-token/1', 'mic-session/1', 'mic-session/2', 'meeting-purpose/1', 'picture-items/1']);
});

// Writes that go through call(), not attach (Codex counterexample on the capability fence): the picture's reserved note key, and an
// explicit no-microphone choice that an 0.11 prepare would ignore. Everything else through call() is not gated.
test('a note under the picture key never leaves the client; other notes, and a prepare without mic:false, still reach an old host', async () => {
  mode = 'legacy'; received.length = 0;
  await assert.rejects(client.call('note', { key: 'buc-tranh', revision: 1, kind: 'observation', text: 'x', sourceIds: [1] }), /PICTURE_KEY_RESERVED/);
  assert.deepEqual(received, [], 'refused before any request, ping included');
  assert.deepEqual(await client.call('note', { key: 'ghi-chu', revision: 1, kind: 'observation', text: 'x', sourceIds: [1] }), { accepted: 'note' });
  assert.deepEqual(await client.call('prepare', { title: 'Họp', fixture: true }), { accepted: 'prepare' }, 'no new guarantee asked for: not gated');
});

test('prepare with mic:false is refused by an old host before it is sent, and sent to the current one', async () => {
  mode = 'legacy'; received.length = 0;
  await assert.rejects(client.call('prepare', { title: 'Họp', mic: false }), /HOST_PROTOCOL_OLD: .*mic-session\/2.*prepare chưa được gửi/);
  assert.ok(received.every(r => r.method === 'ping'), 'the old host saw only pings');
  mode = 'current'; received.length = 0;
  assert.deepEqual(await client.call('prepare', { title: 'Họp', mic: false }), { accepted: 'prepare' });
  assert.deepEqual(received.filter(r => r.method === 'prepare').map(r => r.args), [{ title: 'Họp', mic: false }]);
});

// Codex review of b960b8a: PMA_MIC=0 in the client is an explicit no-microphone choice too. A running host never sees the client's
// environment, so the client puts mic:false into the request (prepare, select, listen) and checks it like --no-mic, before any payload.
test('PMA_MIC=0 without --no-mic: an old host gets zero prepare payloads; a current host gets mic:false; select and listen carry it', async () => {
  const before = process.env.PMA_MIC; process.env.PMA_MIC = '0';
  try {
    mode = 'legacy'; received.length = 0;
    await assert.rejects(client.call('prepare', { title: 'Họp' }), /HOST_PROTOCOL_OLD: .*mic-session\/2/);
    assert.ok(received.every(r => r.method === 'ping'), 'no prepare reached the old host');
    // select and listen take a mic flag on an 0.11 host too: they are sent, with the choice in them.
    assert.deepEqual(await client.call('select', { deviceIndex: 13 }), { accepted: 'select' });
    assert.deepEqual(await client.call('listen', {}), { accepted: 'listen' });
    assert.deepEqual(received.filter(r => r.method === 'select' || r.method === 'listen').map(r => r.args.mic), [false, false]);
    mode = 'current'; received.length = 0;
    assert.deepEqual(await client.call('prepare', { title: 'Họp', mic: true }), { accepted: 'prepare' });
    assert.deepEqual(received.filter(r => r.method === 'prepare').map(r => r.args), [{ title: 'Họp', mic: false }], 'PMA_MIC=0 wins over an explicit mic:true');
  } finally { if (before === undefined) delete process.env.PMA_MIC; else process.env.PMA_MIC = before; }
  // Without PMA_MIC=0 nothing is added: the OWN-027 default (microphone recorded) is unchanged.
  mode = 'current'; received.length = 0;
  await client.call('prepare', { title: 'Họp' });
  assert.deepEqual(received.filter(r => r.method === 'prepare').map(r => r.args), [{ title: 'Họp' }]);
});

// Codex review of 4c21d07: the stronger no-mic contract (mic-session/2) is required before a no-mic prepare; an earlier 0.12.1 that
// only has mic-session/1 (silent early return on an open meeting) is refused like 0.11, while its status, stop and drafts still work.
test('prepare(mic:false) needs mic-session/2: an earlier 0.12.1 with /1 only gets no prepare payload; status, stop and drafts still reach it', async () => {
  mode = 'v1only'; received.length = 0;
  await assert.rejects(client.call('prepare', { title: 'Họp', mic: false }), /HOST_PROTOCOL_OLD: .*mic-session\/2.*prepare chưa được gửi/);
  assert.ok(received.every(r => r.method === 'ping'), 'no prepare reached it');
  assert.deepEqual(await client.call('prepare', { title: 'Họp' }), { accepted: 'prepare' }, 'a prepare without a no-mic choice is not gated');
  assert.deepEqual(await client.reach('finish', {}), { accepted: 'finish' });
  assert.deepEqual(await client.attach('summary', { markdown: '- Một.', sourceIds: [1], receipt: 'rcpt-0000000000000000', expectedRevision: 0 }), { accepted: 'summary' }, 'its draft contract (v1) is unchanged');
  assert.equal((await client.inspect()).host.draftsAllowed, true);
  mode = 'current'; received.length = 0;
  assert.deepEqual(await client.call('prepare', { title: 'Họp', mic: false }), { accepted: 'prepare' });
});
